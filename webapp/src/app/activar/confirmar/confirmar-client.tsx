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
        <div className="rounded-xl border border-[rgba(216,90,48,0.2)] bg-[rgba(216,90,48,0.08)] px-4 py-3">
          <p className="text-sm text-[#D85A30]">{error}</p>
        </div>
      )}
      <button
        onClick={confirmar}
        disabled={cargando}
        className="w-full cursor-pointer rounded-xl bg-[#1D9E75] px-6 py-4 text-base font-medium text-white transition-colors hover:bg-[#1D9E75]/90 disabled:opacity-60"
      >
        {cargando ? 'Activando…' : 'Sí, es mi cuenta'}
      </button>
      <button
        onClick={cerrarSesion}
        disabled={cargando}
        className="w-full cursor-pointer rounded-xl border border-white/[0.08] px-6 py-3 text-sm text-[#8A877D] transition-colors hover:text-[#F0EFE8] disabled:opacity-60"
      >
        Entrar con otra cuenta
      </button>
    </div>
  );
}
