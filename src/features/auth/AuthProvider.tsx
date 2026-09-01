import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren
} from 'react';
import { appEnv } from '@/app/env';
import { demoOwner, demoStaff } from '@/data/demo-data';
import { AppError } from '@/domain/errors';
import type { AppUser, UserRole } from '@/domain/types';
import { getSupabaseClient } from '@/lib/supabase';

type AuthContextValue = {
  user: AppUser | null;
  loading: boolean;
  authError: AppError | null;
  isDemo: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  switchDemoRole(role: UserRole): void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const profileRequestError = (error: unknown): AppError => {
  const payload = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : null;
  if (payload?.code === 'P0001' && payload.message === 'FORBIDDEN') {
    return new AppError('auth', 'Tu acceso al panel todavía no está habilitado.', {
      cause: error,
      nextAction: 'Pedile a la dueña que habilite tu usuario.'
    });
  }
  return new AppError('temporary', 'No pudimos comprobar tu acceso en este momento.', {
    cause: error,
    retryable: true,
    nextAction: 'Comprobá tu conexión y volvé a intentarlo.'
  });
};

const profileFromRpc = (data: unknown, fallbackEmail: string): AppUser => {
  if (typeof data !== 'object' || data === null) {
    throw new AppError('auth', 'No pudimos comprobar tu acceso.', {
      nextAction: 'Volvé a ingresar.'
    });
  }
  const profile = data as Record<string, unknown>;
  if (
    typeof profile.id !== 'string' ||
    typeof profile.displayName !== 'string' ||
    (profile.role !== 'owner' && profile.role !== 'staff')
  ) {
    throw new AppError('auth', 'Tu usuario todavía no tiene un perfil activo.', {
      nextAction: 'Pedile a la dueña que termine de habilitarlo.'
    });
  }
  return {
    id: profile.id,
    displayName: profile.displayName,
    email: typeof profile.email === 'string' ? profile.email : fallbackEmail,
    role: profile.role,
    active: true
  };
};

const AUTH_PROFILE_CACHE_KEY = 'suplementos_auth_profile';

const getCachedProfile = (): AppUser | null => {
  try {
    const raw = window.localStorage.getItem(AUTH_PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.id === 'string' &&
      typeof parsed.displayName === 'string' &&
      (parsed.role === 'owner' || parsed.role === 'staff')
    ) {
      return parsed as AppUser;
    }
  } catch {}
  return null;
};

const setCachedProfile = (user: AppUser | null) => {
  try {
    if (user) {
      window.localStorage.setItem(AUTH_PROFILE_CACHE_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(AUTH_PROFILE_CACHE_KEY);
    }
  } catch {}
};

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AppUser | null>(() => {
    if (appEnv.isDemo) {
      try {
        const saved = window.sessionStorage.getItem('demo_role');
        if (saved === 'staff') return demoStaff;
        if (saved === 'owner') return demoOwner;
      } catch {}
      return demoOwner;
    }
    return getCachedProfile();
  });
  const [loading, setLoading] = useState(() => {
    if (appEnv.isDemo) return false;
    if (appEnv.mode !== 'supabase') return false;
    return getCachedProfile() === null;
  });
  const [authError, setAuthError] = useState<AppError | null>(null);

  const updateActiveUser = useCallback((nextUser: AppUser | null) => {
    setUser(nextUser);
    setCachedProfile(nextUser);
  }, []);

  const requestSupabaseProfile = useCallback(async (fallbackEmail: string): Promise<AppUser> => {
    const { data, error } = await getSupabaseClient().rpc('get_current_profile');
    if (error) throw profileRequestError(error);
    return profileFromRpc(data, fallbackEmail);
  }, []);

  const loadSupabaseProfile = useCallback(async (_isInitial = false) => {
    if (appEnv.mode !== 'supabase') return;
    const client = getSupabaseClient();
    try {
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw profileRequestError(sessionError);
      const session = sessionData.session;
      if (!session) {
        updateActiveUser(null);
        setAuthError(null);
        return;
      }
      const profile = await requestSupabaseProfile(session.user.email ?? '');
      updateActiveUser(profile);
      setAuthError(null);
    } catch (caught) {
      const err = caught instanceof AppError ? caught : profileRequestError(caught);
      if (err.kind === 'auth') {
        updateActiveUser(null);
        setAuthError(err);
      } else {
        // En errores temporales de red, conservamos el usuario en memoria
        setAuthError(err);
      }
    } finally {
      setLoading(false);
    }
  }, [requestSupabaseProfile, updateActiveUser]);

  useEffect(() => {
    if (appEnv.mode !== 'supabase') return;
    void loadSupabaseProfile(true);
    const client = getSupabaseClient();
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        updateActiveUser(null);
        setLoading(false);
      } else if (event === 'SIGNED_IN') {
        void loadSupabaseProfile(false);
      } else {
        // TOKEN_REFRESHED, USER_UPDATED: revalidación silenciosa en segundo plano
        void loadSupabaseProfile(false);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [loadSupabaseProfile, updateActiveUser]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (appEnv.isDemo) {
      const nextRole = email.toLowerCase().includes('recepcion') ? 'staff' : 'owner';
      try {
        window.sessionStorage.setItem('demo_role', nextRole);
      } catch {}
      setUser(nextRole === 'staff' ? demoStaff : demoOwner);
      setAuthError(null);
      return;
    }
    if (appEnv.mode !== 'supabase') {
      throw new AppError('configuration', 'La aplicación todavía no está conectada a la tienda.');
    }
    const client = getSupabaseClient();
    setAuthError(null);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      throw new AppError('auth', 'El correo o la contraseña no coinciden.', {
        nextAction: 'Revisalos y volvé a intentarlo.'
      });
    }
    try {
      const profile = await requestSupabaseProfile(data.user.email ?? email);
      updateActiveUser(profile);
      setAuthError(null);
    } catch (caught) {
      const accessError = caught instanceof AppError ? caught : profileRequestError(caught);
      updateActiveUser(null);
      setAuthError(accessError);
      if (accessError.kind === 'auth') await client.auth.signOut({ scope: 'local' });
      throw accessError;
    }
  }, [requestSupabaseProfile, updateActiveUser]);

  const signOut = useCallback(async () => {
    if (appEnv.isDemo) {
      try {
        window.sessionStorage.removeItem('demo_role');
      } catch {}
      setUser(null);
      setAuthError(null);
      return;
    }
    if (appEnv.mode === 'supabase') await getSupabaseClient().auth.signOut();
    updateActiveUser(null);
    setAuthError(null);
  }, [updateActiveUser]);

  const switchDemoRole = useCallback((role: UserRole) => {
    if (appEnv.isDemo) {
      try {
        window.sessionStorage.setItem('demo_role', role);
      } catch {}
      setUser(role === 'owner' ? demoOwner : demoStaff);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, authError, isDemo: appEnv.isDemo, signIn, signOut, switchDemoRole }),
    [user, loading, authError, signIn, signOut, switchDemoRole]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider.');
  return context;
};
