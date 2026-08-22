'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * La única parte interactiva de la invitación: confirmar la parte propia del gasto.
 *
 * El resto de la pantalla la pinta el servidor con los datos ya resueltos (ver `page.tsx`).
 * Esta isla existe sólo por el `onClick`, y por eso recibe el código y nada más: el
 * contenido que la persona vino a leer no depende de que este bundle llegue.
 */
export function AccionConfirmarGasto({ code }: { code: string }) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);

  async function confirmar() {
    setEnviando(true);
    setError(null);
    try {
      const res = await fetch('/api/split/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          router.push(`/login?redirect=/join/gasto/${code}`);
          return;
        }
        // 404 = hay sesion pero todavia no hay cuenta Neto vinculada. Antes esto
        // llegaba como 401 y terminaba en /login, que el middleware rebota a
        // /dashboard por tener sesion: la invitacion se perdia sin decir nada.
        if (res.status === 404) {
          router.push(`/onboarding?redirect=/join/gasto/${code}`);
          return;
        }
        throw new Error(data.error || 'Error al confirmar');
      }
      setListo(true);
      setTimeout(() => router.push('/dashboard/deudas'), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al confirmar');
    } finally {
      setEnviando(false);
    }
  }

  if (listo) {
    return (
      <div className="flex items-center justify-center gap-2 py-3 text-[#1D9E75]">
        <Check className="h-5 w-5" />
        <span className="text-sm font-medium">Participacion confirmada</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-[#D85A30] text-center">{error}</p>}
      <Button
        onClick={confirmar}
        disabled={enviando}
        className="w-full bg-[#EF9F27] hover:bg-[#EF9F27]/90 text-black font-medium"
      >
        {enviando ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Users className="h-4 w-4 mr-2" />}
        Confirmar mi parte
      </Button>
      <p className="text-[10px] text-[#8A877D] text-center">
        Se agregara como deuda pendiente en tu cuenta NETO
      </p>
    </div>
  );
}
