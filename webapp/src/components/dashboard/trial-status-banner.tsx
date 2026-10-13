'use client';

import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { useUser } from '@/lib/hooks/use-user';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { diasRestantesTrial } from '@/lib/plan';

/**
 * Estado de la prueba de 14 días, visible en TODO el dashboard (montado en el shell).
 *
 * Es la segunda de las tres veces que se comunica el trial: la primera es la confirmación
 * del primer gasto por WhatsApp, y la tercera son los avisos de los días 11 y 14.
 *
 * NO se comunica en `/activar`, y eso es deliberado: esa página tiene un solo trabajo —
 * que la persona toque el botón — y meterle un segundo frame ("¿gratis? ¿o sea que después
 * pago?") ante alguien que todavía no vio nada es exactamente el ruido que se le sacó
 * cuando se rediseñó. Acá, en cambio, la persona está mirando su propia data con Pro
 * encendido: el claim es verificable en vez de abstracto.
 *
 * Tampoco se calla hasta el día 11: un trial que nadie sabe que existe es un muro sorpresa,
 * que es justo el generador de churn que este cambio vino a matar.
 *
 * Copy largo los primeros días (hay que explicar qué se está estrenando), compacto después,
 * ámbar cuando quedan ≤3. No es descartable a propósito, igual que
 * `ReferralDiscountBanner`: es time-sensitive y se apaga solo al vencer o al pagar.
 * Lee del `useUser` ya cargado — sin fetch extra.
 */
export function TrialStatusBanner() {
  const { data: user } = useUser();

  if (IS_DEMO || !user) return null;

  // `plan` entra en la cuenta a propósito: sin él, un usuario cuyo plan cayó a 'free' con
  // el trial_estado todavía en 'activo' veía este banner ARRIBA del paywall. Ver enTrial.
  const dias = diasRestantesTrial(user.plan, user.trial_estado, user.trial_vence);
  if (dias === null) return null;

  const urgente = dias <= 3;
  // Los primeros dos días todavía hay que decir QUÉ se está estrenando; después basta
  // con el contador, que a esa altura ya se entiende.
  const explicar = dias >= 12;

  const cuando =
    dias === 0 ? 'Termina hoy' : dias === 1 ? 'Queda 1 día' : `Quedan ${dias} días`;

  return (
    <div
      className={`mb-4 flex items-center gap-3 rounded-2xl border px-4 py-3 ${
        urgente
          ? 'border-warning/40 bg-warning/10'
          : 'border-primary/30 bg-primary/[0.07]'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
          urgente ? 'bg-warning/15 text-warning-ink' : 'bg-primary/15 text-primary-ink'
        }`}
      >
        <Sparkles className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          Estás en <span className="font-semibold">Neto Pro</span> —{' '}
          <span className={urgente ? 'text-warning' : 'text-primary'}>
            {cuando.toLowerCase()}
          </span>{' '}
          de prueba
        </p>
        <p className={`text-xs ${urgente ? 'font-medium text-warning' : 'text-muted-foreground'}`}>
          {explicar
            ? 'Gráficos, categorías, presupuestos, reportes e historial completo, sin tarjeta.'
            : urgente
              ? 'Después sigo anotando tus gastos, pero el dashboard y el historial se cierran.'
              : 'Sin tarjeta. Decide al final, con tus números delante.'}
        </p>
      </div>
      <Link
        href="/dashboard/pro"
        className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
          urgente
            ? 'bg-warning text-warning-foreground hover:bg-warning/90'
            : 'border border-primary/40 text-primary-ink hover:bg-primary/10'
        }`}
      >
        {urgente ? 'Continuar con Pro' : 'Ver planes'}
      </Link>
    </div>
  );
}
