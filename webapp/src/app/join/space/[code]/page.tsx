'use client';

export const dynamic = 'force-dynamic';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { motion } from 'motion/react';
import { Users, Check, Loader2, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SpacePreview {
  id: string;
  name: string;
  type: string;
  members_count: number;
  creator: string;
}

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
  const [notLoggedIn, setNotLoggedIn] = useState(false);

  useEffect(() => {
    // Try to get space preview by code
    fetch(`/api/spaces/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
      .then(async (res) => {
        if (res.status === 401) {
          setNotLoggedIn(true);
          setLoading(false);
          return;
        }
        if (!res.ok) throw new Error('Invalid code');
        const data = await res.json();
        if (data.already_member) {
          // Already a member — redirect directly
          router.replace(`/dashboard/espacios/${data.space_id}`);
          return;
        }
        setSuccess(true);
        setTimeout(() => router.replace(`/dashboard/espacios/${data.space_id}`), 1500);
      })
      .catch(() => setError('Código de invitación inválido o expirado'))
      .finally(() => setLoading(false));
  }, [code, router]);

  async function handleJoinAfterLogin() {
    setJoining(true);
    router.push(`/login?redirect=/join/space/${code}`);
  }

  return (
    <div className="min-h-screen bg-[#0E0E0C] flex flex-col items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
      >
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Image src="/neto-logo.png" alt="NETO" width={64} height={64} className="object-contain" />
        </div>

        <div className="glass-card p-7 space-y-5 text-center">
          {loading ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 className="w-8 h-8 text-[#1D9E75] animate-spin" />
              <p className="text-sm text-[#8A877D]">Verificando invitación...</p>
            </div>
          ) : success ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="w-14 h-14 rounded-full bg-[rgba(29,158,117,0.15)] flex items-center justify-center">
                <Check className="w-7 h-7 text-[#1D9E75]" />
              </div>
              <p className="text-base font-semibold text-[#F0EFE8]">¡Te uniste al espacio!</p>
              <p className="text-sm text-[#8A877D]">Redirigiendo...</p>
            </div>
          ) : notLoggedIn ? (
            <>
              <div className="flex flex-col items-center gap-3">
                <span className="text-4xl">{TYPE_ICON[preview?.type ?? 'custom']}</span>
                <h1 className="text-lg font-bold text-[#F0EFE8]">
                  Únete a un espacio compartido
                </h1>
                <p className="text-sm text-[#8A877D]">
                  Inicia sesión con tu cuenta de Neto para unirte usando el código{' '}
                  <span className="text-[#1D9E75] font-mono font-semibold">{code}</span>
                </p>
              </div>
              <Button
                onClick={handleJoinAfterLogin}
                disabled={joining}
                className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-2"
              >
                <LogIn className="w-4 h-4" />
                Iniciar sesión para unirme
              </Button>
            </>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <Users className="w-10 h-10 text-[#8A877D]/50" />
              <p className="text-base font-semibold text-[#F0EFE8]">Invitación no válida</p>
              <p className="text-sm text-[#8A877D]">{error}</p>
              <Button
                variant="ghost"
                onClick={() => router.push('/dashboard')}
                className="text-[#1D9E75]"
              >
                Ir al dashboard
              </Button>
            </div>
          ) : null}
        </div>

        <p className="text-center text-xs text-[#8A877D] mt-6">
          Powered by{' '}
          <span className="text-[#1D9E75] font-semibold">NETO</span>
        </p>
      </motion.div>
    </div>
  );
}
