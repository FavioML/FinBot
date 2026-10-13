'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAdminEconomics } from '@/lib/hooks/use-admin-economics';
// El precio de Neto sale de una sola fuente, nunca escrito a mano.
import { PRO_PRICE_MONTHLY_PEN } from '@/lib/constants';

function formatPen(n: number, decimals = 2): string {
  return `S/ ${n.toLocaleString('es-PE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatPenShort(n: number): string {
  if (Math.abs(n) >= 1000) {
    return `S/ ${(n / 1000).toFixed(1)}k`;
  }
  return `S/ ${Math.round(n)}`;
}

function KpiCard({
  label,
  value,
  subtitle,
  accent,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  accent?: 'positive' | 'warning' | 'negative' | 'default';
}) {
  const valueColor =
    accent === 'positive'
      ? 'text-primary'
      : accent === 'warning'
        ? 'text-warning'
        : accent === 'negative'
          ? 'text-negative'
          : 'text-foreground';
  return (
    <div className="glass-card rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueColor}`}>{value}</div>
      {subtitle && (
        <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>
      )}
    </div>
  );
}

function SmallKpi({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <div className="glass-card rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-lg font-semibold text-foreground">{value}</div>
      {subtitle && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>
      )}
    </div>
  );
}

function SkeletonGrid({ count, cols }: { count: number; cols: string }) {
  return (
    <div className={`grid gap-3 ${cols}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl border border-border bg-foreground/[0.02]"
        />
      ))}
    </div>
  );
}

export default function AdminEconomicsPage() {
  const { data, isLoading, error } = useAdminEconomics();

  if (error) {
    return (
      <div className="rounded-xl border border-negative/35 bg-negative/8 p-4 text-sm text-negative-ink">
        Error al cargar economics. {error instanceof Error ? error.message : ''}
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <SkeletonGrid count={4} cols="grid-cols-2 md:grid-cols-4" />
        <SkeletonGrid count={8} cols="grid-cols-2 md:grid-cols-4" />
        <SkeletonGrid count={2} cols="md:grid-cols-2" />
      </div>
    );
  }

  const breakevenAccent: 'positive' | 'warning' | 'negative' =
    data.breakeven_gap <= 0
      ? 'positive'
      : data.breakeven_gap <= 3
        ? 'warning'
        : 'negative';

  const breakevenSubtitle =
    data.breakeven_gap <= 0
      ? 'Breakeven alcanzado'
      : `Faltan ${data.breakeven_gap} usuarios Pro`;

  const grossMarginPct =
    Math.round((data.gross_margin_pro_pen / 10) * 100);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Unit Economics</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          MRR, ARR, breakeven, márgenes, CAC y LTV. Todo sobre datos reales de producción.
        </p>
      </div>

      {/* Sección 1: KPI hero */}
      <section>
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          KPIs principales
        </h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard
            label="MRR"
            value={formatPen(data.mrr)}
            /* Los dos matices van pegados al MRR y no en tarjetas aparte, porque los dos son
               sobre ESTE número: cuánto se descontó por cortesías (Pro regalado, sin un sol
               de por medio) y cuánto porque el cliente pidió borrar su cuenta. Sin ellos, un
               MRR que baja S/18 de un mes al otro no tiene explicación en la pantalla y se lee
               como un bug del panel. Cada uno aparece solo cuando existe. */
            subtitle={[
              `${data.pro_users} Pro activos`,
              data.cortesias > 0
                ? `${data.cortesias} de cortesía sin contar`
                : null,
              data.bajas_declaradas > 0
                ? `${data.bajas_declaradas} ${data.bajas_declaradas === 1 ? 'dado de baja' : 'dados de baja'} sin contar`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            accent="positive"
          />
          <KpiCard
            label="ARR"
            value={formatPen(data.arr, 0)}
            subtitle="Proyección anual"
          />
          <KpiCard
            label="Breakeven Gap"
            value={data.breakeven_gap <= 0 ? '✓' : `+${data.breakeven_gap}`}
            subtitle={breakevenSubtitle}
            accent={breakevenAccent}
          />
          <KpiCard
            label="Margen bruto Pro"
            value={`${formatPen(data.gross_margin_pro_pen)}`}
            subtitle={`${grossMarginPct}% por usuario`}
            accent="positive"
          />
        </div>
      </section>

      {/* Sección 2: KPIs secundarios */}
      <section>
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Métricas secundarias
        </h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SmallKpi
            label="Total usuarios"
            value={data.total_users}
            subtitle={`${data.free_users} Free · ${data.pro_users} Pro`}
          />
          <SmallKpi
            label="Conversión Free→Pro"
            value={`${data.conversion_rate}%`}
            subtitle={`${data.new_users_this_month} nuevos este mes`}
          />
          <SmallKpi
            label="Churn 30d"
            value={`${data.churn_rate_30d}%`}
          />
          <SmallKpi
            label="LTV Pro"
            value={formatPen(data.ltv_pro_pen, 0)}
            subtitle="Estimado vs churn actual"
          />
          <SmallKpi
            label="CAC referidos"
            value={formatPen(data.cac_referidos_pen)}
          />
          <SmallKpi
            label="Costos mensuales"
            value={formatPen(data.total_monthly_costs_pen, 0)}
            subtitle={`${formatPen(data.total_yearly_costs_pen, 0)} al año`}
          />
          <SmallKpi
            label="Margen operativo / mes"
            value={`${data.operating_margin_monthly_pen >= 0 ? '+' : '−'}${formatPen(
              Math.abs(data.operating_margin_monthly_pen),
              0,
            )}`}
            subtitle="MRR menos costos mensuales"
          />
          <SmallKpi
            label="Caja generada"
            value={`${data.cash_generated_pen >= 0 ? '+' : '−'}${formatPen(
              Math.abs(data.cash_generated_pen),
              0,
            )}`}
            subtitle="Acumulado histórico (caja real)"
          />
          <SmallKpi
            label="Activos 30d"
            value={data.active_users_30d}
            subtitle="Con ≥1 transacción"
          />
          <SmallKpi
            label="Tx este mes"
            value={data.transactions_this_month}
            subtitle={`${data.transactions_total} total histórico`}
          />
        </div>
      </section>

      {/* Sección 3: Charts */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="glass-card rounded-xl p-4">
          <h3 className="mb-3 text-sm font-medium text-foreground">
            MRR últimos 6 meses
          </h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data.mrr_history}
                margin={{ top: 4, right: 4, bottom: 0, left: -10 }}
              >
                <defs>
                  <linearGradient id="gradMrr" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--foreground) 5%, transparent)" />
                <XAxis
                  dataKey="month"
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatPenShort(v)}
                />
                <Tooltip itemStyle={{ color: 'var(--foreground)' }}
                  contentStyle={{
                    background: 'var(--surface-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'var(--foreground)' }}
                  formatter={(v) => formatPen(Number(v), 0)}
                />
                <Area
                  type="monotone"
                  dataKey="mrr"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  fill="url(#gradMrr)"
                  name="MRR"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="glass-card rounded-xl p-4">
          <h3 className="mb-3 text-sm font-medium text-foreground">
            Crecimiento usuarios (12 semanas)
          </h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data.user_growth_12w}
                margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--foreground) 5%, transparent)" />
                <XAxis
                  dataKey="week"
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  interval={1}
                />
                <YAxis
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip itemStyle={{ color: 'var(--foreground)' }}
                  contentStyle={{
                    background: 'var(--surface-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'var(--foreground)' }}
                />
                <Line
                  type="monotone"
                  dataKey="free"
                  stroke="var(--muted-foreground)"
                  strokeWidth={2}
                  dot={false}
                  name="Free"
                />
                <Line
                  type="monotone"
                  dataKey="pro"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  dot={false}
                  name="Pro"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Sección 4: Comparativa con competencia */}
      <section className="glass-card rounded-xl p-4">
        <h3 className="mb-3 text-sm font-medium text-foreground">
          Comparativa con la competencia
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2">Producto</th>
                <th className="px-3 py-2">Precio mensual</th>
                <th className="px-3 py-2">Diferencia vs Neto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-3 py-2 font-medium text-primary">Neto</td>
                {/* Los precios de la competencia van a mano (son hechos externos); el NUESTRO no. */}
                <td className="px-3 py-2">S/ {PRO_PRICE_MONTHLY_PEN.toFixed(2)}</td>
                <td className="px-3 py-2 text-muted-foreground">—</td>
              </tr>
              <tr>
                <td className="px-3 py-2">Pablo</td>
                <td className="px-3 py-2">S/ 20.00</td>
                <td className="px-3 py-2 text-muted-foreground">+100%</td>
              </tr>
              <tr>
                <td className="px-3 py-2">Foxy</td>
                <td className="px-3 py-2">S/ 19.90</td>
                <td className="px-3 py-2 text-muted-foreground">+99%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-foreground-soft">
          Neto es el más bajo del mercado peruano: 50% menos que Pablo, 49% menos que Foxy.
        </p>
      </section>

      {/* Sección 5: Alertas operacionales */}
      {(data.costs_due_today > 0 ||
        data.costs_overdue > 0 ||
        data.breakeven_gap > 5) && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Alertas operacionales
          </h3>
          {data.costs_due_today > 0 && (
            <div className="rounded-xl border border-warning/35 bg-warning/8 p-4 text-sm text-warning-ink">
              {data.costs_due_today} costo
              {data.costs_due_today === 1 ? '' : 's'} vence
              {data.costs_due_today === 1 ? '' : 'n'} HOY — total{' '}
              {formatPen(
                data.costs_due_this_week
                  .filter((c) => c.days_until === 0)
                  .reduce((sum, c) => sum + c.amount_pen, 0),
              )}
              .
            </div>
          )}
          {data.costs_overdue > 0 && (
            <div className="rounded-xl border border-negative/35 bg-negative/8 p-4 text-sm text-negative-ink">
              {data.costs_overdue} costo
              {data.costs_overdue === 1 ? '' : 's'} atrasado
              {data.costs_overdue === 1 ? '' : 's'}. Revisa la sección de Costos.
            </div>
          )}
          {data.breakeven_gap > 5 && (
            <div className="rounded-xl border border-warning/35 bg-warning/8 p-4 text-sm text-warning-ink">
              Breakeven aún no alcanzado, faltan {data.breakeven_gap} usuarios Pro.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
