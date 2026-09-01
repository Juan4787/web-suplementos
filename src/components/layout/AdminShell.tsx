import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import {
  BarChart3,
  Bot,
  Boxes,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  PackageSearch,
  ReceiptText,
  Settings,
  UserRound,
  X
} from 'lucide-react';
import { useState } from 'react';
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/DataState';
import type { Capability } from '@/domain/permissions';
import { can } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/cn';

type NavItem = {
  label: string;
  to:
    | '/app'
    | '/app/pedidos'
    | '/app/pedidos/importar'
    | '/app/productos'
    | '/app/inventario'
    | '/app/clientes'
    | '/app/ventas'
    | '/app/ia'
    | '/app/configuracion';
  matchPrefixes?: string[];
  exact?: boolean;
  icon: typeof LayoutDashboard;
  capability?: Capability;
};

const operationalNav: NavItem[] = [
  { label: 'Inicio', to: '/app', exact: true, icon: LayoutDashboard },
  { label: 'Pedidos', to: '/app/pedidos', exact: true, icon: ReceiptText },
  { label: 'Importar WhatsApp', to: '/app/pedidos/importar', matchPrefixes: ['/app/pedidos/importar'], icon: MessageCircle },
  { label: 'Productos', to: '/app/productos', matchPrefixes: ['/app/productos'], icon: PackageSearch },
  { label: 'Inventario', to: '/app/inventario', matchPrefixes: ['/app/inventario', '/app/stock', '/app/compras', '/app/movimientos'], icon: Boxes },
  { label: 'Clientes', to: '/app/clientes', matchPrefixes: ['/app/clientes'], icon: UserRound }
];

const ownerNav: NavItem[] = [
  { label: 'Ventas', to: '/app/ventas', matchPrefixes: ['/app/ventas', '/app/analiticas'], icon: BarChart3, capability: 'view_financials' },
  { label: 'Asistente', to: '/app/ia', matchPrefixes: ['/app/ia'], icon: Bot, capability: 'use_ai' }
];

const settingsNav: NavItem[] = [
  { label: 'Configuración', to: '/app/configuracion', matchPrefixes: ['/app/configuracion', '/app/exportar', '/app/usuarios'], icon: Settings, capability: 'manage_pricing' }
];

function NavigationItems({ close }: { close?: (() => void) | undefined }) {
  const { user } = useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const item = (entry: NavItem) => {
    if (entry.capability && !can(user, entry.capability)) return null;
    const exact = entry.exact ?? entry.to === '/app';
    const active = exact
      ? pathname === entry.to
      : (entry.matchPrefixes?.some((prefix) => pathname.startsWith(prefix)) ?? pathname.startsWith(entry.to));
    const Icon = entry.icon;
    return (
      <Link
        key={entry.to}
        to={entry.to}
        onClick={close}
        className={cn(
          'flex min-h-12 items-center gap-3.5 rounded-2xl px-4 text-[15.5px] font-bold tracking-tight transition',
          active ? 'bg-brand-600 text-white font-black shadow-sm' : 'text-white/75 hover:bg-white/10 hover:text-white'
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
        {entry.label}
      </Link>
    );
  };
  return (
    <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-label="Panel">
      <div className="space-y-1">{operationalNav.map(item)}</div>
      {can(user, 'view_financials') || can(user, 'use_ai') ? (
        <>
          <p className="mb-2 mt-7 px-4 text-[13px] font-bold uppercase tracking-wider text-white/50">Decisiones</p>
          <div className="space-y-1">{ownerNav.map(item)}</div>
        </>
      ) : null}
      <p className="mb-2 mt-7 px-4 text-[13px] font-bold uppercase tracking-wider text-white/50">Cuenta</p>
      <div className="space-y-1">{settingsNav.map(item)}</div>
    </nav>
  );
}

function UserPanel() {
  const { user, isDemo, signOut, switchDemoRole } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <div className="relative mt-5 border-t border-white/10 pt-5">
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-2xl p-2 text-left transition hover:bg-white/8"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-600 font-black text-white text-base">
          {user.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-black text-white">{user.displayName}</span>
          <span className="block text-[13.5px] font-semibold text-white/65">{user.role === 'owner' ? 'Dueña' : 'Personal'}</span>
        </span>
        <ChevronDown className={cn('size-4 text-white/50 transition', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="mt-2 rounded-2xl bg-white/8 p-2">
          {isDemo ? (
            <div className="mb-2 grid grid-cols-2 gap-1 rounded-xl bg-black/15 p-1">
              <button className={cn('rounded-lg px-2 py-2 text-xs font-bold', user.role === 'owner' ? 'bg-white text-ink-950' : 'text-white/70')} onClick={() => switchDemoRole('owner')}>Dueña</button>
              <button className={cn('rounded-lg px-2 py-2 text-xs font-bold', user.role === 'staff' ? 'bg-white text-ink-950' : 'text-white/70')} onClick={() => switchDemoRole('staff')}>Personal</button>
            </div>
          ) : null}
          <button
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold text-white/80 hover:bg-white/12 hover:text-white"
            onClick={() => void signOut()}
          >
            <LogOut className="size-4" /> Cerrar sesión
          </button>
        </div>
      ) : null}
      {isDemo ? (
        <p className="mt-2 text-center text-[12.5px] font-bold text-white/45">
          Entorno de demostración
        </p>
      ) : null}
    </div>
  );
}

function Sidebar({ mobile = false, close }: { mobile?: boolean; close?: (() => void) | undefined }) {
  const { isDemo } = useAuth();
  return (
    <aside
      className={cn(
        'flex h-full w-[18rem] shrink-0 flex-col bg-ink-950 px-4 py-5',
        !mobile && 'hidden lg:flex'
      )}
    >
      <div className="mb-8 flex items-center justify-between px-2">
        <Logo inverted />
        {isDemo ? (
          <span className="rounded-md bg-white/10 px-2 py-0.5 text-[12px] font-black uppercase tracking-wider text-white/75">
            DEMO
          </span>
        ) : null}
      </div>
      <NavigationItems close={close} />
      <UserPanel />
    </aside>
  );
}

export function AdminShell() {
  const { user, loading, isDemo } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  if (loading && !user) return <LoadingState label="Comprobando tu acceso…" />;
  if (!user) return <Navigate to="/ingresar" />;
  return (
    <div className="min-h-screen bg-cream-100">
      <div className="flex h-screen min-h-[42rem]">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-ink-950/8 bg-cream-50 px-4 lg:hidden">
            <div className="flex items-center gap-2">
              <Logo compact />
              {isDemo ? (
                <span className="rounded bg-ink-950/10 px-2 py-0.5 text-[12px] font-black text-ink-700">
                  DEMO
                </span>
              ) : null}
            </div>
            <Button variant="ghost" className="size-11 px-0" onClick={() => setMobileOpen(true)} aria-label="Abrir navegación">
              <Menu className="size-5" />
            </Button>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[94rem] px-4 py-6 sm:px-6 sm:py-8 xl:px-10">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setMobileOpen(false)} aria-label="Cerrar navegación" />
          <div className="relative h-full w-[min(19rem,88vw)]">
            <Sidebar mobile close={() => setMobileOpen(false)} />
            <button className="absolute right-3 top-4 grid size-10 place-items-center rounded-full bg-white/10 text-white" onClick={() => setMobileOpen(false)} aria-label="Cerrar navegación">
              <X className="size-5" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-col gap-5 sm:mb-9 md:flex-row md:items-end md:justify-between">
      <div className="max-w-3xl">
        <h1 className="font-display text-3xl font-black tracking-[-0.04em] text-ink-950 sm:text-4xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-[15.5px] sm:text-base leading-relaxed text-ink-700 font-medium">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
