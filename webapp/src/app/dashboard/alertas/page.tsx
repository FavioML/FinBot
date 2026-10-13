'use client';


import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TrendingUp, Bug, Repeat, AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { useSpendingAlerts, decidirVistaAlertas } from '@/lib/hooks/use-spending-alerts';
import type { SpendingAlert } from '@/lib/hooks/use-spending-alerts';
import { canAccess } from '@/lib/plan';
import { useUser } from '@/lib/hooks/use-user';
import { ProGate } from '@/components/shared/pro-gate';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { AlertasSkeleton } from '@/components/dashboard/skeletons';
import { formatCurrency } from '@/lib/utils';
import { HeaderActions } from '@/components/dashboard/topbar';
import { ErrorState } from '@/components/shared/error-state';

const TYPE_CONFIG = {
  spike: {
    icon: TrendingUp,
    color: 'var(--negative)',
    bg: 'color-mix(in srgb, var(--negative) 8%, transparent)',
    label: 'Incremento inusual',
  },
  ant: {
    icon: Bug,
    color: 'var(--warning)',
    bg: 'color-mix(in srgb, var(--warning) 8%, transparent)',
    label: 'Gastos hormiga',
  },
  recurring: {
    icon: Repeat,
    color: 'var(--info)',
    bg: 'color-mix(in srgb, var(--info) 8%, transparent)',
    label: 'Patrón recurrente',
  },
  projection: {
    icon: AlertTriangle,
    color: 'var(--warning)',
    bg: 'color-mix(in srgb, var(--warning) 8%, transparent)',
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
          <span className="text-xs text-muted-foreground">{date}</span>
        </div>
        <p className="text-sm text-foreground mt-1">{alert.message}</p>
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <span className="text-sm font-semibold text-foreground">
            {formatCurrency(alert.amount)}
          </span>
          {showComparison && (
            <span className="text-xs text-muted-foreground">
              vs {formatCurrency(alert.comparison_amount)} {COMPARISON_LABEL[alert.type] ?? ''}
              {diff !== null && ` (+${diff}%)`}
            </span>
          )}
          {alert.action_taken && (
            <span className="flex items-center gap-1 text-xs text-primary">
              <CheckCircle2 className="w-3 h-3" /> Atendida
            </span>
          )}
        </div>
        {showLimitButton && !alert.limit_set && (
          <button
            className="mt-2 text-xs font-medium text-primary hover:underline"
            onClick={() => onSetLimit?.(alert.category ?? undefined)}
          >
            + Poner límite
          </button>
        )}
        {alert.limit_set && (
          <p className="mt-2 text-xs text-muted-foreground">Límite activo: {formatCurrency(alert.limit_set)}</p>
        )}
      </div>
    </div>
  );
}

export default function AlertasPage() {
  const router = useRouter();
  const { data: user } = useUser();
  const { data, isLoading, isError, refetch } = useSpendingAlerts(20);
  const vista = decidirVistaAlertas({ isLoading, isError, data });

  if (vista === 'cargando') {
    return (
      <AlertasSkeleton />
    );
  }

  // Un fetch caído NO es "no tienes fugas". Sin esta rama la página decía "Todo bien por ahora"
  // con un escudo verde encima cada vez que /api/alerts fallaba (F3), que es la peor mentira
  // posible acá: el usuario cierra la pestaña tranquilo justo cuando el detector no miró nada.
  if (vista === 'error') {
    return (
      // La descripción NO es la genérica a propósito: acá el riesgo no es que el usuario
      // crea que perdió data, es que crea que no tiene fugas.
      <ErrorState
        titulo="No pudimos revisar tus gastos"
        descripcion="Esto no significa que no haya fugas: significa que no pudimos mirar. Revisa tu conexión e inténtalo de nuevo."
        onReintentar={() => refetch()}
      />
    );
  }

  const alerts = data?.alerts ?? [];
  // El plan sale de `useUser`, la fuente de verdad del resto del dashboard, y no del `isPro` de
  // esta respuesta: con el fetch de alertas caído ese campo llegaba `undefined` y degradaba a un
  // Pro a Free, escondiéndole proyecciones y límites que sí paga (segunda mitad de F3).
  const userPlan = user?.plan;

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
            <h1 className="text-2xl font-bold text-foreground">Detector de Fugas</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Neto analiza tus gastos y detecta patrones que podrían estar drenando tu billetera
            </p>
          </div>
          <HeaderActions />
        </div>
      </FadeIn>

      {visibleAlerts.length === 0 ? (
        <FadeIn delay={0.05}>
          <div className="glass-card p-10 flex flex-col items-center text-center gap-3">
            <ShieldCheck className="w-12 h-12 text-primary" style={{ filter: 'drop-shadow(0 0 12px color-mix(in srgb, var(--primary) 40%, transparent))' }} />
            <h2 className="text-base font-semibold text-foreground">Todo bien por ahora</h2>
            <p className="text-sm text-muted-foreground max-w-xs">
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
          <div className="glass-card p-5 flex items-start gap-4 border border-primary/20">
            <div className="rounded-xl p-2.5 bg-primary/10 shrink-0">
              <ShieldCheck className="w-5 h-5 text-primary-ink" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">Más protección con Pro</p>
              <p className="text-xs text-muted-foreground mt-1">
                Alertas semanales automáticas, proyecciones de gasto y límites automáticos por categoría.
              </p>
              <Link
                href="/dashboard/configuracion"
                className="inline-block mt-3 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
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
