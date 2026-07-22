'use client';

import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { signOutAndClear } from '@/lib/query-client';

type Phase = 'input' | 'verify';

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0E0E0C]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#1D9E75] border-t-transparent" />
    </div>
  );
}

// `useSearchParams` obliga a un limite de Suspense para que el shell siga
// prerenderizandose estatico (mismo patron que /login).
export default function OnboardingPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Onboarding />
    </Suspense>
  );
}

function Onboarding() {
  const router = useRouter();
  // A donde volver al terminar. Lo mandan las paginas /join/* cuando la API
  // responde 404 (hay sesion pero todavia no hay cuenta Neto): sin esto el
  // usuario se vincula y aterriza en el dashboard, con la invitacion perdida.
  // Solo rutas internas, para que un link no lo saque de la app.
  const destino = useSearchParams().get('redirect');
  const volverA = destino?.startsWith('/') && !destino.startsWith('//') ? destino : '/dashboard';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [code, setCode] = useState('');
  const [waLink, setWaLink] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Polling: una vez en fase "verify", pregunta al server si el webhook ya confirmo
  // el codigo (el usuario lo envio por WhatsApp). Al verificar -> dashboard.
  useEffect(() => {
    if (phase !== 'verify') return;
    const tick = async () => {
      try {
        const res = await fetch('/api/onboarding', { method: 'GET' });
        const data = await res.json();
        if (data.verified) {
          if (pollRef.current) clearInterval(pollRef.current);
          toast.success('Cuenta verificada');
          router.replace(volverA);
        }
      } catch {
        /* reintenta en el siguiente tick */
      }
    };
    pollRef.current = setInterval(tick, 3000);
    tick();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase, router, volverA]);

  const formatWhatsapp = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 9);
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

      // Cuenta ya vinculada en una sesion previa -> directo a destino.
      if (data.alreadyLinked) {
        router.replace(volverA);
        return;
      }

      setCode(data.code);
      setWaLink(data.waLink);
      setPhase('verify');
      setSubmitting(false);
    } catch {
      setError('Error de conexion. Intenta de nuevo.');
      setSubmitting(false);
    }
  };

  if (loading) {
    return <Spinner />;
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

        {phase === 'input' && (
          <>
            <h1 className="mb-2 text-2xl font-bold text-[#F0EFE8]">
              Completa tu registro
            </h1>
            <p className="mb-8 text-[#8A877D]">Un ultimo paso para empezar</p>

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

            {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

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
                'Continuar'
              )}
            </motion.button>
          </>
        )}

        {phase === 'verify' && (
          <>
            <h1 className="mb-2 text-2xl font-bold text-[#F0EFE8]">
              Verifica tu WhatsApp
            </h1>
            <p className="mb-6 text-[#8A877D]">
              Toca el boton, se abrira WhatsApp con un mensaje listo. Solo
              envialo y esta pantalla continua sola.
            </p>

            {/* Codigo (referencia visible por si el mensaje se borra) */}
            <div className="mb-6 rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-center">
              <p className="mb-1 text-xs text-[#8A877D]">Tu codigo</p>
              <p className="font-mono text-lg font-bold tracking-widest text-[#F0EFE8]">
                {code}
              </p>
            </div>

            <motion.a
              href={waLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#1D9E75] px-6 py-4 text-base font-medium text-white shadow-lg shadow-[#1D9E75]/20 transition-all hover:bg-[#1D9E75]/90 hover:shadow-[#1D9E75]/30"
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.98 }}
            >
              Abrir WhatsApp y enviar
            </motion.a>

            <div className="mt-6 flex items-center justify-center gap-2 text-sm text-[#8A877D]">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#1D9E75] border-t-transparent" />
              Esperando tu confirmacion...
            </div>

            <button
              onClick={() => {
                setPhase('input');
                setCode('');
                setWaLink('');
              }}
              className="mt-6 w-full text-center text-sm text-[#8A877D] transition-colors hover:text-[#C8C6BC] cursor-pointer"
            >
              Usar otro numero
            </button>
          </>
        )}

        {/* Change account */}
        <button
          onClick={async () => {
            await signOutAndClear();
            router.replace('/login');
          }}
          className="mt-6 w-full text-center text-sm text-[#8A877D] hover:text-[#C8C6BC] transition-colors cursor-pointer"
        >
          Cambiar de cuenta
        </button>

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
