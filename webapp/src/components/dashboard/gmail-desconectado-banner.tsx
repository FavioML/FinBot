'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useGmailEstado } from '@/lib/hooks/use-gmail-estado';
import { IS_DEMO } from '@/lib/demo/is-demo';

/**
 * Gmail dejó de leer y el usuario no hizo nada para romperlo.
 *
 * Vive en el shell y no solo en la tarjeta de `/dashboard/pro` porque el síntoma que la
 * persona nota es "Neto dejó de anotar mis gastos", y con eso no va a `/dashboard/pro`: va a
 * mirar sus transacciones. El único aviso que había era efímero — un WhatsApp que fuera de la
 * ventana de 24h de Meta no se entrega, y una notificación in-app que se pierde entre las
 * demás — así que quien se lo perdía no tenía forma de enterarse.
 *
 * No es descartable, igual que `TrialStatusBanner`: se apaga solo al reconectar, y hasta
 * entonces la ingesta automática sigue rota. Un dismiss acá esconde un problema vivo.
 *
 * Se suprime en `/dashboard/pro` desde el shell: ahí la tarjeta ya cuenta lo mismo con más
 * detalle y el botón real.
 */
export function GmailDesconectadoBanner() {
  const { data } = useGmailEstado();

  if (IS_DEMO || !data?.authErrorAt) return null;

  const desde = new Date(data.authErrorAt).toLocaleDateString('es-PE', {
    timeZone: 'America/Lima',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="mb-4 flex items-center gap-3 rounded-2xl border border-[#EF9F27]/40 bg-[#EF9F27]/10 px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#EF9F27]/15 text-[#EF9F27]">
        <AlertTriangle className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#F0EFE8]">
          Tu Gmail se desconectó <span className="text-[#EF9F27]">el {desde}</span>
        </p>
        {/* Se nombra lo que SIGUE funcionando: si no, "se desconectó" se lee como que Neto
            entero dejó de servir, y lo que se rompió es una de las dos vías de registro. */}
        <p className="text-xs text-[#8A877D]">
          Neto no está registrando los gastos que te llegan por correo. Lo que anotas por WhatsApp sigue igual.
        </p>
      </div>
      <Link
        href="/dashboard/pro"
        className="shrink-0 rounded-lg bg-[#EF9F27] px-3 py-2 text-xs font-semibold text-[#1A1A18] transition-colors hover:bg-[#EF9F27]/90"
      >
        Reconectar
      </Link>
    </div>
  );
}
