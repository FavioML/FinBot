'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.replace('/login');
        return;
      }
      setName(
        user.user_metadata?.full_name ||
          user.user_metadata?.name ||
          ''
      );
      setEmail(user.email || '');
      setLoading(false);
    });
  }, [router]);

  const formatWhatsapp = (value: string) => {
    // Only keep digits
    const digits = value.replace(/\D/g, '').slice(0, 9);
    // Format as 999 999 999
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  };

  const handleSubmit = async () => {
    setError('');
    const digits = whatsapp.replace(/\D/g, '');

    if (digits.length !== 9) {
      setError('Ingresa un numero de 9 digitos');
      toast.error('Ingresa un numero de 9 digitos');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsapp: digits }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al registrar');
        setSubmitting(false);
        return;
      }

      router.replace('/dashboard');
    } catch {
      setError('Error de conexion. Intenta de nuevo.');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0E0E0C]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#1D9E75] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0E0E0C] px-4">
      <motion.div
        className="w-full max-w-md"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        {/* Logo */}
        <div className="mb-10 flex items-center gap-3">
          <Image
            src="/neto-logo.png"
            alt="NETO"
            width={56}
            height={56}
            priority
            className="h-14 w-14 object-contain"
          />
          <div>
            <h2 className="text-xl font-bold text-[#F0EFE8]">NETO</h2>
            <p className="text-sm text-[#8A877D]">Tu asistente financiero</p>
          </div>
        </div>

        {/* Heading */}
        <h1 className="mb-2 text-2xl font-bold text-[#F0EFE8]">
          Completa tu registro
        </h1>
        <p className="mb-8 text-[#8A877D]">Un ultimo paso para empezar</p>

        {/* Read-only user info */}
        <div className="mb-4">
          <label className="mb-1.5 block text-sm font-medium text-[#C8C6BC]">
            Nombre
          </label>
          <input
            value={name}
            readOnly
            className="w-full rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-sm text-[#8A877D] outline-none transition-colors"
          />
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-sm font-medium text-[#C8C6BC]">
            Email
          </label>
          <input
            value={email}
            readOnly
            className="w-full rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-sm text-[#8A877D] outline-none transition-colors"
          />
        </div>

        {/* WhatsApp input */}
        <div className="mb-6">
          <label className="mb-1.5 block text-sm font-medium text-[#C8C6BC]">
            WhatsApp
          </label>
          <div className="flex overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.03] focus-within:border-[#1D9E75]/50">
            <span className="flex items-center border-r border-white/[0.06] bg-white/[0.02] px-4 text-sm font-medium text-[#8A877D]">
              +51
            </span>
            <input
              type="tel"
              placeholder="999 999 999"
              value={whatsapp}
              onChange={(e) => setWhatsapp(formatWhatsapp(e.target.value))}
              className="w-full bg-transparent px-4 py-3 text-sm text-[#F0EFE8] outline-none placeholder:text-[#8A877D]/50"
              maxLength={11}
            />
          </div>
          <p className="mt-1.5 text-xs text-[#8A877D]">
            Para registrar gastos por WhatsApp
          </p>
        </div>

        {/* Error */}
        {error && (
          <p className="mb-4 text-sm text-red-400">{error}</p>
        )}

        {/* Submit */}
        <motion.button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#1D9E75] px-6 py-4 text-base font-medium text-white shadow-lg shadow-[#1D9E75]/20 transition-all hover:bg-[#1D9E75]/90 hover:shadow-[#1D9E75]/30 disabled:cursor-not-allowed disabled:opacity-50"
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
        >
          {submitting ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : (
            'Comenzar'
          )}
        </motion.button>

        {/* Footer */}
        <footer className="mt-12 flex items-center justify-center gap-4 text-xs text-[#8A877D]">
          <a
            href="https://neto.pe"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-[#C8C6BC]"
          >
            neto.pe
          </a>
          <span className="text-white/[0.06]">|</span>
          <a href="/privacidad" className="transition-colors hover:text-[#C8C6BC]">
            Privacidad
          </a>
          <span className="text-white/[0.06]">|</span>
          <a href="/terminos" className="transition-colors hover:text-[#C8C6BC]">
            Terminos
          </a>
        </footer>
      </motion.div>
    </div>
  );
}
