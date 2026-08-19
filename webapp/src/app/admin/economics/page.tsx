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
  accent?: 'green' | 'amber' | 'red' | 'default';
}) {
  const valueColor =
    accent === 'green'
      ? 'text-[#1D9E75]'
      : accent === 'amber'
        ? 'text-[#EF9F27]'
        : accent === 'red'
          ? 'text-[#D85A30]'
          : 'text-[#F0EFE8]';
  return (
    <div className="glass-card rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-[#8A877D]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueColor}`}>{value}</div>
      {subtitle && (
        <div className="mt-1 text-xs text-[#8A877D]">{subtitle}</div>
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
      <div className="text-[10px] uppercase tracking-wider text-[#8A877D]">{label}</div>
      <div className="mt-1.5 text-lg font-semibold text-[#F0EFE8]">{value}</div>
      {subtitle && (
        <div className="mt-0.5 text-[11px] text-[#8A877D]">{subtitle}</div>
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
          className="h-24 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]"
        />
      ))}
    </div>
  );
}

export default function AdminEconomicsPage() {
  const { data, isLoading, error } = useAdminEconomics();

  if (error) {
    return (
      <div className="rounded-xl border border-[rgba(216,90,48,0.35)] bg-[rgba(216,90,48,0.08)] p-4 text-sm text-[#D85A30]">
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

  const breakevenAccent: 'green' | 'amber' | 'red' =
    data.breakeven_gap <= 0
      ? 'green'
      : data.breakeven_gap <= 3
        ? 'amber'
        : 'red';

  const breakevenSubtitle =
    data.breakeven_gap <= 0
      ? 'Breakeven alcanzado'
      : `Faltan ${data.breakeven_gap} usuarios Pro`;

  const grossMarginPct =
    Math.round((data.gross_margin_pro_pen / 10) * 100);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-[#F0EFE8]">Unit Economics</h2>
        <p className="mt-1 text-sm text-[#8A877D]">
          MRR, ARR, breakeven, márgenes, CAC y LTV. Todo sobre datos reales de producción.
        </p>
      </div>

      {/* Sección 1: KPI hero */}
      <section>
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-[#8A877D]">
          KPIs principales
        </h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard
            label="MRR"
            value={formatPen(data.mrr)}
            /* Los dos matices van pegados al MRR y no en tarjetas aparte, porque los dos son
               sobre ESTE número: cuánto no es plata (comps) y cuánto dejó de contarse porque
               el cliente pidió borrar su cuenta. Sin lo segundo, un MRR que baja S/18 de un
               mes al otro no tiene explicación en la pantalla y se lee como un bug del panel.
               Cada uno aparece solo cuando existe. */
            subtitle={[
              `${data.pro_users} Pro activos`,
              data.pro_sin_pago_registrado > 0
                ? `${data.pro_sin_pago_registrado} sin pago registrado`
                : null,
              data.bajas_declaradas > 0
                ? `${data.bajas_declaradas} ${data.bajas_declaradas === 1 ? 'dado de baja' : 'dados de baja'} sin contar`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            accent="green"
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
            accent="green"
          />
        </div>
      </section>

      {/* Sección 2: KPIs secundarios */}
      <section>
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-[#8A877D]">
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
          <h3 className="mb-3 text-sm font-medium text-[#F0EFE8]">
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
                    <stop offset="5%" stopColor="#1D9E75" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#1D9E75" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  dataKey="month"
                  tick={{ fill: '#8A877D', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#8A877D', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatPenShort(v)}
                />
                <Tooltip
                  contentStyle={{
                    background: '#1C1C19',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#F0EFE8' }}
                  formatter={(v) => formatPen(Number(v), 0)}
                />
                <Area
                  type="monotone"
                  dataKey="mrr"
                  stroke="#1D9E75"
                  strokeWidth={2}
                  fill="url(#gradMrr)"
                  name="MRR"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="glass-card rounded-xl p-4">
          <h3 className="mb-3 text-sm font-medium text-[#F0EFE8]">
            Crecimiento usuarios (12 semanas)
          </h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data.user_growth_12w}
                margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  dataKey="week"
                  tick={{ fill: '#8A877D', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  interval={1}
                />
                <YAxis
                  tick={{ fill: '#8A877D', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: '#1C1C19',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#F0EFE8' }}
                />
                <Line
                  type="monotone"
                  dataKey="free"
                  stroke="#8A877D"
                  strokeWidth={2}
                  dot={false}
                  name="Free"
                />
                <Line
                  type="monotone"
                  dataKey="pro"
                  stroke="#1D9E75"
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
        <h3 className="mb-3 text-sm font-medium text-[#F0EFE8]">
          Comparativa con la competencia
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wider text-[#8A877D]">
                <th className="px-3 py-2">Producto</th>
                <th className="px-3 py-2">Precio mensual</th>
                <th className="px-3 py-2">Diferencia vs Neto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <tr>
                <td className="px-3 py-2 font-medium text-[#1D9E75]">Neto</td>
                {/* Los precios de la competencia van a mano (son hechos externos); el NUESTRO no. */}
                <td className="px-3 py-2">S/ {PRO_PRICE_MONTHLY_PEN.toFixed(2)}</td>
                <td className="px-3 py-2 text-[#8A877D]">—</td>
              </tr>
              <tr>
                <td className="px-3 py-2">Pablo</td>
                <td className="px-3 py-2">S/ 20.00</td>
                <td className="px-3 py-2 text-[#8A877D]">+100%</td>
              </tr>
              <tr>
                <td className="px-3 py-2">Foxy</td>
                <td className="px-3 py-2">S/ 19.90</td>
                <td className="px-3 py-2 text-[#8A877D]">+99%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[#C8C6BC]">
          Neto es el más bajo del mercado peruano: 50% menos que Pablo, 49% menos que Foxy.
        </p>
      </section>

      {/* Sección 5: Alertas operacionales */}
      {(data.costs_due_today > 0 ||
        data.costs_overdue > 0 ||
        data.breakeven_gap > 5) && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium uppercase tracking-wider text-[#8A877D]">
            Alertas operacionales
          </h3>
          {data.costs_due_today > 0 && (
            <div className="rounded-xl border border-[rgba(239,159,39,0.35)] bg-[rgba(239,159,39,0.08)] p-4 text-sm text-[#EF9F27]">
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
            <div className="rounded-xl border border-[rgba(216,90,48,0.35)] bg-[rgba(216,90,48,0.08)] p-4 text-sm text-[#D85A30]">
              {data.costs_overdue} costo
              {data.costs_overdue === 1 ? '' : 's'} atrasado
              {data.costs_overdue === 1 ? '' : 's'}. Revisa la sección de Costos.
            </div>
          )}
          {data.breakeven_gap > 5 && (
            <div className="rounded-xl border border-[rgba(239,159,39,0.35)] bg-[rgba(239,159,39,0.08)] p-4 text-sm text-[#EF9F27]">
              Breakeven aún no alcanzado, faltan {data.breakeven_gap} usuarios Pro.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
