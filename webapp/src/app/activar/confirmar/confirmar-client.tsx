'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function ConfirmarActivacion() {
  const router = useRouter();
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmar() {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch('/api/activar/confirmar', { method: 'POST' });
      const data = await res.json();
      if (data?.ok) {
        router.replace('/dashboard?activado=1');
        return;
      }
      setError(
        data?.estado === 'conflicto'
          ? 'Tus dos cuentas tienen datos compartidos y hay que unirlas a mano. Escríbenos por WhatsApp y lo resolvemos.'
          : 'No pudimos activarla. Vuelve a intentar en un momento.'
      );
    } catch {
      setError('No pudimos activarla. Vuelve a intentar en un momento.');
    } finally {
      setCargando(false);
    }
  }

  async function cerrarSesion() {
    await createClient().auth.signOut();
    // El token sigue en la cookie, así que al volver a entrar el callback lo consume.
    router.replace('/login?activar=1');
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="rounded-xl border border-negative/20 bg-negative/8 px-4 py-3">
          <p className="text-sm text-negative">{error}</p>
        </div>
      )}
      <button
        onClick={confirmar}
        disabled={cargando}
        className="w-full cursor-pointer rounded-xl bg-primary px-6 py-4 text-base font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        {cargando ? 'Activando…' : 'Sí, es mi cuenta'}
      </button>
      <button
        onClick={cerrarSesion}
        disabled={cargando}
        className="w-full cursor-pointer rounded-xl border border-border px-6 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
      >
        Entrar con otra cuenta
      </button>
    </div>
  );
}
