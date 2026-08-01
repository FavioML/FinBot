'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { motion } from 'motion/react';
import { Coins, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface DebtPreview {
  acreedor: string;
  contraparte: string;
  monto_original: number;
  monto_pendiente: number;
  moneda: string;
  descripcion: string | null;
  estado: string;
  ya_confirmada: boolean;
}

export default function JoinDeudaPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [preview, setPreview] = useState<DebtPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch(`/api/debts/invite?code=${code}`)
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
      const res = await fetch('/api/debts/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          router.push(`/login?redirect=/join/deuda/${code}`);
          return;
        }
        // 404 = hay sesion pero todavia no hay cuenta Neto vinculada. Antes esto
        // llegaba como 401 y terminaba en /login, que el middleware rebota a
        // /dashboard por tener sesion: la invitacion se perdia sin decir nada.
        if (res.status === 404) {
          router.push(`/onboarding?redirect=/join/deuda/${code}`);
          return;
        }
        throw new Error(data.error || 'Error al confirmar');
      }
      setSuccess(true);
      setTimeout(() => router.push('/dashboard/deudas'), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al confirmar');
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
        <div className="flex items-center justify-center gap-3 mb-8">
          <Image src="/neto-icon.png" alt="NETO" width={56} height={56} priority className="h-14 w-14 rounded-xl object-contain" />
          <span className="text-xl font-bold text-[#F0EFE8]">NETO</span>
        </div>

        {loading ? (
          <div className="glass-card p-8 text-center">
            <Loader2 className="h-8 w-8 text-[#1D9E75] mx-auto animate-spin" />
            <p className="text-sm text-[#8A877D] mt-3">Cargando...</p>
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
            {/* Debt preview */}
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-[rgba(216,90,48,0.12)] flex items-center justify-center mx-auto">
                <Coins className="h-7 w-7 text-[#D85A30]" />
              </div>
              <h1 className="text-lg font-semibold text-[#F0EFE8] mt-4">
                {preview.acreedor} registró una deuda
              </h1>
              <p className="text-xs text-[#8A877D] mt-1">
                a nombre de <span className="text-[#C8C6BC]">{preview.contraparte}</span>
              </p>
            </div>

            {/* Amount */}
            <div className="text-center py-3 rounded-xl bg-[rgba(255,255,255,0.03)]">
              <p className="text-2xl font-bold text-[#D85A30]">
                {formatCurrency(Number(preview.monto_original), preview.moneda)}
              </p>
              {Number(preview.monto_pendiente) < Number(preview.monto_original) && (
                <p className="text-xs text-[#8A877D] mt-1">
                  Pendiente: {formatCurrency(Number(preview.monto_pendiente), preview.moneda)}
                </p>
              )}
              {preview.descripcion && (
                <p className="text-xs text-[#8A877D] mt-2">{preview.descripcion}</p>
              )}
            </div>

            {/* Status badges */}
            {preview.estado === 'pagada' && (
              <p className="text-center text-xs text-[#1D9E75] bg-[rgba(29,158,117,0.1)] rounded-lg py-2">
                Esta deuda ya fue saldada
              </p>
            )}

            {preview.ya_confirmada && preview.estado !== 'pagada' && (
              <p className="text-center text-xs text-[#EF9F27] bg-[rgba(239,159,39,0.1)] rounded-lg py-2">
                Alguien ya confirmo esta deuda
              </p>
            )}

            {/* Action */}
            {success ? (
              <div className="flex items-center justify-center gap-2 py-3 text-[#1D9E75]">
                <Check className="h-5 w-5" />
                <span className="text-sm font-medium">Deuda confirmada</span>
              </div>
            ) : preview.estado !== 'pagada' && !preview.ya_confirmada ? (
              <div className="space-y-3">
                {error && (
                  <p className="text-xs text-[#D85A30] text-center">{error}</p>
                )}
                <Button
                  onClick={handleJoin}
                  disabled={joining}
                  className="w-full bg-[#D85A30] hover:bg-[#D85A30]/90 text-white"
                >
                  {joining ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Coins className="h-4 w-4 mr-2" />
                  )}
                  Confirmar deuda
                </Button>
                <p className="text-[10px] text-[#8A877D] text-center">
                  Se agregara como deuda pendiente en tu cuenta NETO
                </p>
              </div>
            ) : (
              <Button variant="outline" onClick={() => router.push('/dashboard/deudas')} className="w-full">
                Ir a mis deudas
              </Button>
            )}

            {/* Not a user? */}
            <div className="pt-3 border-t border-[rgba(255,255,255,0.05)] text-center">
              <p className="text-xs text-[#8A877D] mb-2">¿No tienes cuenta NETO?</p>
              <div className="flex items-center justify-center gap-2 text-xs">
                <a href="/login" className="text-[#1D9E75] hover:underline">
                  Regístrate en la app
                </a>
                <span className="text-[#8A877D]">o</span>
                <a
                  href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#1D9E75] hover:underline"
                >
                  por WhatsApp
                </a>
              </div>
            </div>
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
