'use client';


import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TrendingUp, Bug, Repeat, AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { useSpendingAlerts } from '@/lib/hooks/use-spending-alerts';
import type { SpendingAlert } from '@/lib/hooks/use-spending-alerts';
import { canAccess } from '@/lib/plan';
import { ProGate } from '@/components/shared/pro-gate';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { AlertasSkeleton } from '@/components/dashboard/skeletons';
import { formatCurrency } from '@/lib/utils';
import { HeaderActions } from '@/components/dashboard/topbar';

const TYPE_CONFIG = {
  spike: {
    icon: TrendingUp,
    color: '#D85A30',
    bg: 'rgba(216,90,48,0.08)',
    label: 'Incremento inusual',
  },
  ant: {
    icon: Bug,
    color: '#EF9F27',
    bg: 'rgba(239,159,39,0.08)',
    label: 'Gastos hormiga',
  },
  recurring: {
    icon: Repeat,
    color: '#378ADD',
    bg: 'rgba(55,138,221,0.08)',
    label: 'Patrón recurrente',
  },
  projection: {
    icon: AlertTriangle,
    color: '#EF9F27',
    bg: 'rgba(239,159,39,0.08)',
    label: 'Proyección de exceso',
  },
} as const;

const COMPARISON_LABEL: Record<string, string> = {
  spike: 'mes anterior',
  projection: 'presupuesto',
};

function AlertCard({ alert, canLimits, onSetLimit }: { alert: SpendingAlert; canLimits: boolean; onSetLimit?: (category?: string) => void }) {
  const config = TYPE_CONFIG[alert.type];
  const Icon = config.icon;
  const showLimitButton = canLimits && (alert.type === 'spike' || alert.type === 'projection');
  const showComparison = alert.comparison_amount > 0 && (alert.type === 'spike' || alert.type === 'projection');
  const diff = showComparison
    ? Math.round(((alert.amount - alert.comparison_amount) / alert.comparison_amount) * 100)
    : null;

  const date = new Date(alert.created_at).toLocaleDateString('es-PE', {
    day: 'numeric',
    month: 'short',
  });

  return (
    <div
      className="glass-card p-4 flex items-start gap-4"
      style={{ borderLeft: `3px solid ${config.color}` }}
    >
      {/* Icon */}
      <div
        className="rounded-xl p-2.5 shrink-0 mt-0.5"
        style={{ background: config.bg }}
      >
        <Icon className="w-5 h-5" style={{ color: config.color }} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs font-medium uppercase tracking-wide" style={{ color: config.color }}>
            {config.label}{alert.category ? ` · ${alert.category}` : ''}
          </p>
          <span className="text-xs text-[#8A877D]">{date}</span>
        </div>
        <p className="text-sm text-[#F0EFE8] mt-1">{alert.message}</p>
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <span className="text-sm font-semibold text-[#F0EFE8]">
            {formatCurrency(alert.amount)}
          </span>
          {showComparison && (
            <span className="text-xs text-[#8A877D]">
              vs {formatCurrency(alert.comparison_amount)} {COMPARISON_LABEL[alert.type] ?? ''}
              {diff !== null && ` (+${diff}%)`}
            </span>
          )}
          {alert.action_taken && (
            <span className="flex items-center gap-1 text-xs text-[#1D9E75]">
              <CheckCircle2 className="w-3 h-3" /> Atendida
            </span>
          )}
        </div>
        {showLimitButton && !alert.limit_set && (
          <button
            className="mt-2 text-xs font-medium text-[#1D9E75] hover:underline"
            onClick={() => onSetLimit?.(alert.category ?? undefined)}
          >
            + Poner límite
          </button>
        )}
        {alert.limit_set && (
          <p className="mt-2 text-xs text-[#8A877D]">Límite activo: {formatCurrency(alert.limit_set)}</p>
        )}
      </div>
    </div>
  );
}

export default function AlertasPage() {
  const router = useRouter();
  const { data, isLoading } = useSpendingAlerts(20);

  if (isLoading) {
    return (
      <AlertasSkeleton />
    );
  }

  const alerts = data?.alerts ?? [];
  const userPlan = data?.isPro ? 'premium' : 'free';

  const canProjections = canAccess(userPlan, 'fugas_projections');
  const canLimits = canAccess(userPlan, 'fugas_limits');
  const canWeeklyAlerts = canAccess(userPlan, 'fugas_weekly_alerts');

  // Filter: only show spike/ant/recurring for free users (no projection)
  const visibleAlerts = canProjections ? alerts : alerts.filter((a) => a.type !== 'projection');

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[#F0EFE8]">Detector de Fugas</h1>
            <p className="text-[#8A877D] text-sm mt-1">
              Neto analiza tus gastos y detecta patrones que podrían estar drenando tu billetera
            </p>
          </div>
          <HeaderActions />
        </div>
      </FadeIn>

      {visibleAlerts.length === 0 ? (
        <FadeIn delay={0.05}>
          <div className="glass-card p-10 flex flex-col items-center text-center gap-3">
            <ShieldCheck className="w-12 h-12 text-[#1D9E75]" style={{ filter: 'drop-shadow(0 0 12px rgba(29,158,117,0.4))' }} />
            <h2 className="text-base font-semibold text-[#F0EFE8]">Todo bien por ahora</h2>
            <p className="text-sm text-[#8A877D] max-w-xs">
              Neto te avisará por aquí y por WhatsApp si detecta algún patrón de gasto inusual.
            </p>
          </div>
        </FadeIn>
      ) : (
        <>
          <div className="space-y-3">
            {visibleAlerts.map((alert, i) => (
              <FadeIn key={alert.id} delay={0.04 * i}>
                <AlertCard
                  alert={alert}
                  canLimits={canLimits}
                  onSetLimit={(cat) => router.push(cat ? `/dashboard/presupuestos?categoria=${encodeURIComponent(cat)}` : '/dashboard/presupuestos')}
                />
              </FadeIn>
            ))}
          </div>

          {/* Proyecciones gate for free users */}
          {!canProjections && (
            <FadeIn delay={0.1}>
              <ProGate
                featureName="Proyecciones de exceso"
                description="Neto predice qué categorías van a pasarse del límite antes de que termine el mes"
              />
            </FadeIn>
          )}
        </>
      )}

      {/* Pro banner for free users */}
      {!canWeeklyAlerts && (
        <FadeIn delay={0.15}>
          <div className="glass-card p-5 flex items-start gap-4 border border-[rgba(29,158,117,0.2)]">
            <div className="rounded-xl p-2.5 bg-[rgba(29,158,117,0.1)] shrink-0">
              <ShieldCheck className="w-5 h-5 text-[#1D9E75]" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-[#F0EFE8]">Más protección con Pro</p>
              <p className="text-xs text-[#8A877D] mt-1">
                Alertas semanales automáticas, proyecciones de gasto y límites automáticos por categoría.
              </p>
              <Link
                href="/dashboard/configuracion"
                className="inline-block mt-3 rounded-lg bg-[#1D9E75] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#1D9E75]/90 transition-colors"
              >
                Ver planes →
              </Link>
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
