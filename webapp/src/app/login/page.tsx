'use client';

import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const handleGoogleLogin = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0E0E0C] px-4 font-sans">
      {/* Main content */}
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        {/* Logo & tagline */}
        <div className="flex flex-col items-center gap-3">
          <Image
            src="/neto-logo.png"
            alt="NETO"
            width={120}
            height={40}
            priority
          />
          <p className="text-sm text-[#8A877D]">Tu asistente financiero</p>
        </div>

        {/* Glass card */}
        <div className="w-full rounded-2xl border border-white/[0.06] bg-white/[0.03] p-8 backdrop-blur-xl">
          <h1 className="mb-6 text-center text-xl font-semibold text-[#F0EFE8]">
            Iniciar sesion
          </h1>

          <button
            onClick={handleGoogleLogin}
            className="flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl bg-[#1D9E75] px-4 py-3 text-sm font-medium text-white transition-all hover:bg-[#1D9E75]/90 active:scale-[0.98]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#fff"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#fff"
                opacity={0.8}
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                fill="#fff"
                opacity={0.6}
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#fff"
                opacity={0.8}
              />
            </svg>
            Continuar con Google
          </button>

          {/* Divider */}
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-white/[0.06]" />
            <span className="text-xs text-[#8A877D]">o</span>
            <div className="h-px flex-1 bg-white/[0.06]" />
          </div>

          {/* WhatsApp CTA */}
          <p className="text-center text-sm text-[#C8C6BC]">
            No tienes cuenta?{' '}
            <a
              href="https://wa.me/51933014505"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[#1D9E75] transition-colors hover:text-[#1D9E75]/80"
            >
              Escribenos por WhatsApp
            </a>
          </p>
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-12 flex items-center gap-4 text-xs text-[#8A877D]">
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
    </div>
  );
}
