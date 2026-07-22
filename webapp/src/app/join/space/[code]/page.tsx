'use client';

export const dynamic = 'force-dynamic';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { motion } from 'motion/react';
import { Users, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SpacePreview {
  id: string;
  name: string;
  type: string;
  creator: string;
  members_count: number;
}

const TYPE_LABEL: Record<string, string> = {
  pareja: 'Espacio de pareja',
  roommates: 'Espacio de roommates',
  custom: 'Espacio compartido',
};

const TYPE_ICON: Record<string, string> = {
  pareja: '💑',
  roommates: '🏘️',
  custom: '👥',
};

export default function JoinSpacePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [preview, setPreview] = useState<SpacePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Fetch public preview (no auth needed)
  useEffect(() => {
    fetch(`/api/spaces/invite?code=${code}`)
      .then((res) => {
        if (!res.ok) throw new Error('Invalid code');
        return res.json();
      })
      .then(setPreview)
      .catch(() => setError('Código de invitación inválido o expirado'))
      .finally(() => setLoading(false));
  }, [code]);

  async function handleJoin() {
    setJoining(true);
    setError(null);
    try {
      const res = await fetch('/api/spaces/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          router.push(`/login?redirect=/join/space/${code}`);
          return;
        }
        // 404 = hay sesion pero todavia no hay cuenta Neto vinculada. Antes esto
        // llegaba como 401 y terminaba en /login, que el middleware rebota a
        // /dashboard por tener sesion: la invitacion se perdia sin decir nada.
        if (res.status === 404) {
          router.push(`/onboarding?redirect=/join/space/${code}`);
          return;
        }
        throw new Error(data.error || 'Error al unirse');
      }
      if (data.already_member) {
        router.replace(`/dashboard/espacios/${data.space_id}`);
        return;
      }
      setSuccess(true);
      setTimeout(() => router.replace(`/dashboard/espacios/${data.space_id}`), 2000);
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
          <span className="sr-only">neto</span>
        </div>

        {loading ? (
          <div className="glass-card p-8 text-center">
            <Loader2 className="h-8 w-8 text-[#1D9E75] mx-auto animate-spin" />
            <p className="text-sm text-[#8A877D] mt-3">Cargando invitación...</p>
          </div>
        ) : error && !preview ? (
          <div className="glass-card p-8 text-center">
            <Users className="w-10 h-10 text-[#8A877D]/50 mx-auto" />
            <p className="text-base font-semibold text-[#F0EFE8] mt-3">Invitación no válida</p>
            <p className="text-sm text-[#8A877D] mt-1">{error}</p>
            <Button variant="outline" onClick={() => router.push('/dashboard')} className="mt-4">
              Ir al dashboard
            </Button>
          </div>
        ) : preview ? (
          <div className="glass-card glass-card-glow p-6 space-y-5">
            {/* Space preview */}
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-[rgba(29,158,117,0.12)] flex items-center justify-center mx-auto">
                <span className="text-2xl">{TYPE_ICON[preview.type] || '👥'}</span>
              </div>
              <h1 className="text-lg font-semibold text-[#F0EFE8] mt-4">
                {preview.creator} te invita a un espacio
              </h1>
              <p className="text-xs text-[#8A877D] mt-1">
                {TYPE_LABEL[preview.type] || 'Espacio compartido'}
              </p>
            </div>

            {/* Space info */}
            <div className="text-center py-3 rounded-xl bg-[rgba(255,255,255,0.03)]">
              <p className="text-xl font-bold text-[#1D9E75]">{preview.name}</p>
              <p className="text-xs text-[#8A877D] mt-1">
                {preview.members_count} miembro{preview.members_count !== 1 ? 's' : ''}
              </p>
            </div>

            {/* Action */}
            {success ? (
              <div className="flex items-center justify-center gap-2 py-3 text-[#1D9E75]">
                <Check className="h-5 w-5" />
                <span className="text-sm font-medium">¡Te uniste al espacio!</span>
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
                    <Users className="h-4 w-4 mr-2" />
                  )}
                  Unirme al espacio
                </Button>
                <p className="text-[10px] text-[#8A877D] text-center">
                  Podrás compartir gastos y dividir cuentas con los miembros
                </p>
              </div>
            )}

            {/* Not a user? */}
            <div className="pt-3 border-t border-[rgba(255,255,255,0.05)] text-center">
              <p className="text-xs text-[#8A877D] mb-2">¿No tienes cuenta NETO?</p>
              <a
                href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-[#1D9E75] hover:underline"
              >
                Regístrate gratis por WhatsApp
              </a>
            </div>
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
