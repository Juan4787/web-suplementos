import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { useAuth } from '@/features/auth/AuthProvider';

const schema = z.object({
  email: z.email('Ingresá un correo válido.'),
  password: z.string().min(6, 'Ingresá tu contraseña.')
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const { user, signIn, isDemo, authError } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, setValue, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: isDemo ? 'duena@demo.local' : '', password: isDemo ? 'demostracion' : '' }
  });
  if (user) return <Navigate to="/app" />;
  const submit = handleSubmit(async (values) => {
    setError(null);
    try {
      await signIn(values.email, values.password);
      await navigate({ to: '/app' });
    } catch (caught) {
      setError(caught);
    }
  });
  return (
    <main className="grid min-h-screen bg-cream-100 lg:grid-cols-[1fr_0.82fr]">
      <section className="relative hidden overflow-hidden bg-brand-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="surface-grid absolute inset-0 opacity-25" />
        <div className="absolute -right-28 top-20 size-96 rounded-full bg-brand-600/30 blur-3xl" />
        <div className="relative"><Logo inverted /></div>
        <div className="relative max-w-xl">
          <span className="grid size-14 place-items-center rounded-[1.25rem] bg-brand-600 text-white shadow-md"><ShieldCheck className="size-7" /></span>
          <h1 className="mt-7 font-display text-6xl font-black leading-[0.92] tracking-[-0.06em]">TODO LO QUE SIGUE, CLARO.</h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-white/75">Pedidos, stock y compras en un lugar. La información financiera aparece solo para quien corresponde.</p>
        </div>
        <p className="relative text-xs font-semibold text-white/40">Panel privado de Impulso</p>
      </section>
      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="lg:hidden"><Logo /></div>
          <Link to="/" className="mt-8 inline-flex items-center gap-2 text-sm font-extrabold text-ink-600 hover:text-brand-600 lg:mt-0"><ArrowLeft className="size-4" /> Volver a la tienda</Link>
          <div className="mt-10 rounded-[2rem] bg-white p-6 shadow-soft sm:p-8">
            <span className="grid size-12 place-items-center rounded-2xl bg-brand-100 text-brand-700"><LockKeyhole className="size-5" /></span>
            <h2 className="mt-5 font-display text-3xl font-black tracking-[-0.04em]">Entrar al panel</h2>
            <p className="mt-2 text-sm leading-6 text-ink-600">Usá el correo habilitado para la tienda.</p>
            {isDemo ? (
              <div className="mt-5 rounded-2xl border border-brand-200/60 bg-brand-50/70 p-4 text-sm">
                <p className="font-black text-brand-900">Accesos de demostración</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="rounded-full bg-white px-3 py-2 text-xs font-black shadow-sm hover:bg-brand-50" onClick={() => setValue('email', 'duena@demo.local')}>Ver como dueña</button>
                  <button className="rounded-full bg-white px-3 py-2 text-xs font-black shadow-sm hover:bg-brand-50" onClick={() => setValue('email', 'recepcion@demo.local')}>Ver como personal</button>
                </div>
              </div>
            ) : null}
            <form className="mt-6 space-y-5" onSubmit={submit} noValidate>
              <Field label="Correo" htmlFor="email" error={errors.email?.message}><Input id="email" type="email" autoComplete="email" {...register('email')} /></Field>
              <Field label="Contraseña" htmlFor="password" error={errors.password?.message}><Input id="password" type="password" autoComplete="current-password" {...register('password')} /></Field>
              {error || authError ? <ErrorState error={error ?? authError} /> : null}
              <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Ingresar</Button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
