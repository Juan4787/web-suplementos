import type { ReactNode } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { Capability } from '@/domain/permissions';
import { can } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthProvider';

export function RoleGate({
  capability,
  children,
  fallback
}: {
  capability: Capability;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { user } = useAuth();
  if (can(user, capability)) return children;
  if (fallback) return fallback;
  return (
    <div className="rounded-[1.75rem] border border-ink-950/10 bg-white p-8 text-center shadow-card">
      <LockKeyhole className="mx-auto size-8 text-ink-600" aria-hidden="true" />
      <h2 className="mt-4 font-display text-xl font-black">Esta información es privada</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-600">
        Tu acceso está pensado para la operación diaria. La dueña puede abrir esta sección desde su usuario.
      </p>
    </div>
  );
}

