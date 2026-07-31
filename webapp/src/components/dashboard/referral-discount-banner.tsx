'use client';

import Link from 'next/link';
import { Gift } from 'lucide-react';
import { useUser } from '@/lib/hooks/use-user';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { PRO_PRICE_MONTHLY_PEN } from '@/lib/constants';

/**
 * Recordatorio del descuento de referido (50% off el primer mes Pro) para que el referido
 * no deje pasar la ventana de 7 días. Aparece en TODO el dashboard (montado en el shell), a
 * diferencia del banner detallado de `/dashboard/pro`, que solo se ve al entrar a activar.
 *
 * NO es descartable a propósito: es time-sensitive y de alto valor: se apaga solo cuando la
 * ventana vence o cuando el usuario se hace Pro (deja de tener "primer mes"). El conteo de
 * días se calcula en fecha Lima, igual que el server (`/api/pro/status`), para no depender de
 * la zona del navegador. Lee del `useUser` ya cargado — sin fetch extra.
 */
export function ReferralDiscountBanner() {
  const { data: user } = useUser();

  if (IS_DEMO || !user || user.plan === 'premium') return null;

  const pct = user.referido_dscto_pct || 0;
  const vence = user.referido_dscto_vence ? String(user.referido_dscto_vence).slice(0, 10) : null;
  if (!pct || !vence) return null;

  // Hoy en Lima (YYYY-MM-DD); comparación lexicográfica = cronológica.
  const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  if (vence < hoyLima) return null; // ya venció

  const ms = new Date(vence + 'T12:00:00-05:00').getTime() - new Date(hoyLima + 'T12:00:00-05:00').getTime();
  const dias = Math.max(0, Math.round(ms / 86400000));
  const precio = Math.round(PRO_PRICE_MONTHLY_PEN * (100 - pct)) / 100;

  const cuando =
    dias === 0 ? 'Vence hoy' : dias === 1 ? 'Vence mañana' : `Vence en ${dias} días`;
  const urgente = dias <= 2;

  return (
    <div
      className={`mb-4 flex items-center gap-3 rounded-2xl border px-4 py-3 ${
        urgente
          ? 'border-[#EF9F27]/40 bg-[#EF9F27]/10'
          : 'border-[#EF9F27]/25 bg-[#EF9F27]/[0.06]'
      }`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#EF9F27]/15 text-[#EF9F27]">
        <Gift className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#F0EFE8]">
          Tu 50% de bienvenida sigue activo — estrena Pro por{' '}
          <span className="font-semibold text-[#EF9F27]">S/{precio}</span>{' '}
          <span className="text-[#8A877D] line-through">S/{PRO_PRICE_MONTHLY_PEN}</span>
        </p>
        <p className={`text-xs ${urgente ? 'font-medium text-[#EF9F27]' : 'text-[#8A877D]'}`}>
          {cuando}. Aplica a tu primer mes (plan mensual).
        </p>
      </div>
      <Link
        href="/dashboard/pro"
        className="shrink-0 rounded-lg bg-[#EF9F27] px-3 py-2 text-xs font-semibold text-[#1A1A18] transition-colors hover:bg-[#EF9F27]/90"
      >
        Activar Pro
      </Link>
    </div>
  );
}
