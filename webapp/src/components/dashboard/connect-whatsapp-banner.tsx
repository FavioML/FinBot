'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MessageCircle, X } from 'lucide-react';
import { useUser } from '@/lib/hooks/use-user';
import { IS_DEMO } from '@/lib/demo/is-demo';

const DISMISS_KEY = 'neto_connect_wa_dismissed';

/**
 * Nudge para cuentas web-first (registradas con Google, sin número). Invita a vincular
 * WhatsApp para registrar gastos por chat — es opcional, así que se puede descartar.
 * Se oculta solo cuando el usuario ya tiene número (`user.whatsapp`).
 */
export function ConnectWhatsappBanner() {
  const { data: user } = useUser();
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1',
  );

  if (IS_DEMO || !user || user.whatsapp || dismissed) return null;

  // Al Pro el chat le suma más (alertas de movimientos + registro por foto de Yape),
  // así que el nudge es un poco más específico. Para Free queda la invitación base.
  const isPremium = user.plan === 'premium';
  const titulo = isPremium
    ? 'Suma WhatsApp a tu Pro'
    : 'Conecta tu WhatsApp para registrar gastos por chat';
  const descripcion = isPremium
    ? 'Recibe alertas de movimientos y registra gastos con una foto de tu Yape, desde el chat.'
    : 'Es opcional. Manda un gasto o una foto de tu Yape y Neto lo anota.';

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* localStorage no disponible: descartar solo por esta sesión */
    }
    setDismissed(true);
  };

  return (
    <div className="glass-card mb-4 flex items-center gap-3 rounded-2xl px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1D9E75]/15 text-[#1D9E75]">
        <MessageCircle className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#F0EFE8]">{titulo}</p>
        <p className="text-xs text-[#8A877D]">{descripcion}</p>
      </div>
      <Link
        href="/onboarding"
        className="shrink-0 rounded-lg bg-[#1D9E75] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1D9E75]/90"
      >
        Conectar
      </Link>
      <button
        onClick={dismiss}
        aria-label="Descartar"
        className="shrink-0 rounded-lg p-1.5 text-[#8A877D] transition-colors hover:text-[#C8C6BC]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
