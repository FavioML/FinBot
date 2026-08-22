'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Target, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** La única parte interactiva: unirse a la meta. El contenido lo pinta el servidor. */
export function AccionUnirseMeta({ code }: { code: string }) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);

  async function unirse() {
    setEnviando(true);
    setError(null);
    try {
      const res = await fetch('/api/goals/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          // Not logged in — redirect to login with return URL
          router.push(`/login?redirect=/join/meta/${code}`);
          return;
        }
        // 404 = hay sesion pero todavia no hay cuenta Neto vinculada. Antes esto
        // llegaba como 401 y terminaba en /login, que el middleware rebota a
        // /dashboard por tener sesion: la invitacion se perdia sin decir nada.
        if (res.status === 404) {
          router.push(`/onboarding?redirect=/join/meta/${code}`);
          return;
        }
        throw new Error(data.error || 'Error al unirse');
      }
      setListo(true);
      setTimeout(() => router.push('/dashboard/planes'), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al unirse');
    } finally {
      setEnviando(false);
    }
  }

  if (listo) {
    return (
      <div className="flex items-center justify-center gap-2 py-3 text-[#1D9E75]">
        <Check className="h-5 w-5" />
        <span className="text-sm font-medium">Te uniste exitosamente</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-[#D85A30] text-center">{error}</p>}
      <Button
        onClick={unirse}
        disabled={enviando}
        className="w-full bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white"
      >
        {enviando ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Target className="h-4 w-4 mr-2" />}
        Unirme a esta meta
      </Button>
      <p className="text-[10px] text-[#8A877D] text-center">Necesitas una cuenta NETO para unirte</p>
    </div>
  );
}
