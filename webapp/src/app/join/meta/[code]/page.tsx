'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { motion } from 'motion/react';
import { Users, Target, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';

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
      <motion.div
        className="w-full max-w-sm"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Image src="/neto-logo.png" alt="NETO" width={64} height={64} className="h-16 w-16 object-contain" />
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

            {/* Progress */}
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#8A877D]">Progreso</span>
                <span className="text-[#1D9E75] font-medium">{preview.porcentaje}%</span>
              </div>
              <div className="h-2 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-[#1D9E75]"
                  initial={{ width: 0 }}
                  animate={{ width: `${preview.porcentaje}%` }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
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
      </motion.div>
    </div>
  );
}
