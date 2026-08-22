'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Users, Target, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { ENTRADA_TARJETA } from '@/lib/entrada';

export const dynamic = 'force-dynamic';

interface GoalPreview {
  nombre: string;
  icono: string;
  monto_objetivo: number;
  monto_actual: number;
  porcentaje: number;
  creador: string;
  participantes: number;
}

export default function JoinMetaPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [preview, setPreview] = useState<GoalPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch(`/api/goals/invite?code=${code}`)
      .then((res) => {
        if (!res.ok) throw new Error('Invalid invite');
        return res.json();
      })
      .then(setPreview)
      .catch(() => setError('Invitacion invalida o expirada'))
      .finally(() => setLoading(false));
  }, [code]);

  async function handleJoin() {
    setJoining(true);
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
      setSuccess(true);
      setTimeout(() => router.push('/dashboard/planes'), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al unirse');
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0E0E0C] flex items-center justify-center p-4">
      <div className={`w-full max-w-sm ${ENTRADA_TARJETA} animation-duration-400`}>
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <Image src="/neto-icon.png" alt="NETO" width={56} height={56} priority className="h-14 w-14 rounded-xl object-contain" />
          <span className="text-xl font-bold text-[#F0EFE8]">NETO</span>
        </div>

        {loading ? (
          <div className="glass-card p-8 text-center">
            <Loader2 className="h-8 w-8 text-[#1D9E75] mx-auto animate-spin" />
            <p className="text-sm text-[#8A877D] mt-3">Cargando invitacion...</p>
          </div>
        ) : error && !preview ? (
          <div className="glass-card p-8 text-center">
            <p className="text-sm text-[#D85A30] mb-4">{error}</p>
            <Button variant="outline" onClick={() => router.push('/dashboard')}>
              Ir al dashboard
            </Button>
          </div>
        ) : preview ? (
          <div className="glass-card glass-card-glow p-6 space-y-5">
            {/* Goal preview */}
            <div className="text-center">
              <span className="text-4xl">{preview.icono}</span>
              <h1 className="text-lg font-semibold text-[#F0EFE8] mt-3">{preview.nombre}</h1>
              <p className="text-xs text-[#8A877D] mt-1">
                Creada por <span className="text-[#C8C6BC]">{preview.creador}</span>
              </p>
            </div>

            {/* Progress
              *
              * La barra crece con CSS (`.animate-barra-progreso` en globals.css) y no con
              * `motion`, que era el unico uso que quedaba en esta pantalla y le costaba
              * 118 KB sin comprimir (~38.8 KB gzip) de bundle propio: medido contra
              * produccion el 22-ago-2026, /join/meta pesaba 1159.0 KB contra los 1041.7 KB
              * de /join/gasto y /join/deuda, que ya no lo importan.
              *
              * La regla del repo (docblock de login/page.tsx) no es "nunca motion": es que
              * paga cuando anima estado que cambia de verdad. Esto anima un valor de runtime
              * UNA vez, al montar, y despues no vuelve a moverse — mas cerca de una entrada
              * decorativa que de estado vivo. Y la pantalla es la peor superficie posible
              * para pagarlo: se abre desde una invitacion de WhatsApp, en datos moviles, con
              * gente que todavia no tiene cuenta.
              */}
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#8A877D]">Progreso</span>
                <span className="text-[#1D9E75] font-medium">{preview.porcentaje}%</span>
              </div>
              <div className="h-2 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#1D9E75] animate-barra-progreso"
                  style={{ width: `${preview.porcentaje}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] text-[#8A877D] mt-1">
                <span>{formatCurrency(preview.monto_actual)}</span>
                <span>{formatCurrency(preview.monto_objetivo)}</span>
              </div>
            </div>

            {/* Participants */}
            <div className="flex items-center gap-2 text-xs text-[#8A877D]">
              <Users className="h-4 w-4" />
              <span>{preview.participantes} participante{preview.participantes !== 1 ? 's' : ''}</span>
            </div>

            {/* Action */}
            {success ? (
              <div className="flex items-center justify-center gap-2 py-3 text-[#1D9E75]">
                <Check className="h-5 w-5" />
                <span className="text-sm font-medium">Te uniste exitosamente</span>
              </div>
            ) : (
              <div className="space-y-3">
                {error && (
                  <p className="text-xs text-[#D85A30] text-center">{error}</p>
                )}
                <Button
                  onClick={handleJoin}
                  disabled={joining}
                  className="w-full bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white"
                >
                  {joining ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Target className="h-4 w-4 mr-2" />
                  )}
                  Unirme a esta meta
                </Button>
                <p className="text-[10px] text-[#8A877D] text-center">
                  Necesitas una cuenta NETO para unirte
                </p>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
