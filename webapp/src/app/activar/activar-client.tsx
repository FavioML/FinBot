'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { createClient } from '@/lib/supabase/client';

// Un solo camino primario: Google. El correo queda como salida secundaria para
// quien no tenga cuenta de Google, plegado hasta que lo pida — a esta página se
// llega para terminar algo que ya empezó, no para elegir entre opciones.
//
// Lo que NO va acá, y es deliberado: nada de "empezar por WhatsApp" (viene de
// ahí) ni de "crea tu cuenta" (ya la tiene, con sus gastos adentro).

export default function EntrarActivacion({
  whatsappEnmascarado,
}: {
  whatsappEnmascarado: string | null;
}) {
  const [verEmail, setVerEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [cargando, setCargando] = useState(false);

  async function entrarConGoogle() {
    setCargando(true);
    await createClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  async function enviarEnlace() {
    if (!email.trim()) return;
    setCargando(true);
    await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setEnviado(true);
    setCargando(false);
  }

  return (
    <div>
      <motion.button
        onClick={entrarConGoogle}
        disabled={cargando}
        className="flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl bg-[#1D9E75] px-6 py-4 text-base font-medium text-white transition-colors hover:bg-[#1D9E75]/90 disabled:opacity-60"
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.98 }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#fff" />
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#fff" opacity={0.8} />
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#fff" opacity={0.6} />
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#fff" opacity={0.8} />
        </svg>
        Continuar con Google
      </motion.button>

      {whatsappEnmascarado && (
        <p className="mt-3 text-center text-xs text-[#8A877D]">
          Es la misma cuenta de tu WhatsApp {whatsappEnmascarado}
        </p>
      )}

      <div className="mt-6 text-center">
        {enviado ? (
          <div className="rounded-xl border border-[rgba(29,158,117,0.2)] bg-[rgba(29,158,117,0.08)] px-4 py-3">
            <p className="text-sm font-medium text-[#1D9E75]">
              ✓ Enlace enviado — revísalo en tu correo.
            </p>
          </div>
        ) : verEmail ? (
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="tu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && enviarEnlace()}
              className="form-input flex-1 rounded-xl px-3 py-3 text-sm"
            />
            <button
              onClick={enviarEnlace}
              disabled={cargando || !email.trim()}
              className="cursor-pointer rounded-xl border border-white/[0.08] px-4 text-sm text-[#F0EFE8] transition-colors hover:bg-white/[0.04] disabled:opacity-50"
            >
              Enviar
            </button>
          </div>
        ) : (
          <button
            onClick={() => setVerEmail(true)}
            className="cursor-pointer text-sm text-[#8A877D] transition-colors hover:text-[#F0EFE8]"
          >
            Prefiero entrar con mi correo
          </button>
        )}
      </div>

      <p className="mt-8 text-center text-xs text-[#8A877D]">
        Conexión segura · Sin contraseñas
      </p>
    </div>
  );
}
