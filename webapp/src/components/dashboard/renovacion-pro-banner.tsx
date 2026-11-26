'use client';

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { useUser } from '@/lib/hooks/use-user';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { diasRestantesPro, RENOVACION_AVISO_DIAS } from '@/lib/plan';

/**
 * Aviso de renovación para quien PAGA, visible en todo el dashboard (montado en el shell) los
 * últimos `RENOVACION_AVISO_DIAS` días antes de `premium_vence`.
 *
 * Es el hermano de `TrialStatusBanner`, que solo cubre la prueba. Hasta el 25-nov-2026 el Pro
 * pagado vencía sin que la web lo dijera fuera de Configuración, y la renovación es manual (un
 * Yape y un comprobante por ciclo): si nadie la pide en el momento, no pasa. Desde agosto iban
 * 0 de 10 renovaciones mensuales, con los avisos por WhatsApp sin entregarse (ventana de 24 h
 * cerrada). La web es el único canal que llega a quien entra.
 *
 * El botón lleva a `/dashboard/pro?renovar=1`, que abre el formulario de pago directo en vez
 * de la pantalla "Eres Neto Pro" con la renovación escondida detrás de otro botón. No es
 * descartable, igual que el de la prueba: se apaga solo al renovar o al vencer.
 */
export function RenovacionProBanner() {
  const { data: user } = useUser();

  // Quien ya mandó su comprobante no tiene que volver a pagar: `/dashboard/pro` le muestra
  // "Tu renovación está en verificación", y la tira diciéndole "Renovar" lo contradiría.
  if (IS_DEMO || !user || user.pago_pendiente) return null;

  const dias = diasRestantesPro(user.plan, user.trial_estado, user.premium_vence);
  if (dias === null || dias > RENOVACION_AVISO_DIAS) return null;

  const urgente = dias <= 1;
  const fecha = new Date(String(user.premium_vence).slice(0, 10) + 'T12:00:00').toLocaleDateString(
    'es-PE',
    { day: 'numeric', month: 'long' },
  );
  const cuando =
    dias === 0 ? 'vence hoy' : dias === 1 ? 'vence mañana' : `vence en ${dias} días, el ${fecha}`;

  return (
    <div
      className={`mb-4 flex items-center gap-3 rounded-2xl border px-4 py-3 ${
        urgente ? 'border-warning/40 bg-warning/10' : 'border-primary/30 bg-primary/[0.07]'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
          urgente ? 'bg-warning/15 text-warning-ink' : 'bg-primary/15 text-primary-ink'
        }`}
      >
        <RefreshCw className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          Tu <span className="font-semibold">Neto Pro</span>{' '}
          <span className={urgente ? 'text-warning-ink' : 'text-primary-ink'}>{cuando}</span>
        </p>
        <p className={`text-xs ${urgente ? 'font-medium text-warning-ink' : 'text-muted-foreground'}`}>
          Renovar es un Yape y subir el comprobante. Si no renuevas, sigo anotando tus gastos, pero
          el dashboard y el historial se cierran.
        </p>
      </div>
      <Link
        href="/dashboard/pro?renovar=1"
        className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
          urgente
            ? 'bg-warning text-warning-foreground hover:bg-warning/90'
            : 'border border-primary/40 text-primary-ink hover:bg-primary/10'
        }`}
      >
        Renovar
      </Link>
    </div>
  );
}
