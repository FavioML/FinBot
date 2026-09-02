'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Loader2 } from 'lucide-react';
import { useAdminProducto } from '@/lib/hooks/use-admin-producto';
import type {
  AdminEngagement,
  AdminRetention,
  FeatureAdoptionRow,
} from '@/lib/types-admin';

const FEATURE_LABEL: Record<string, string> = {
  transacciones: 'Transacciones',
  categorias: 'Categorías custom',
  presupuestos: 'Presupuestos',
  deudas: 'Deudas',
  metas: 'Metas de ahorro',
  espacios: 'Espacios compartidos',
  alertas: 'Alertas de gasto',
  score: 'Score financiero',
  gmail: 'Lectura Gmail',
};

function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const valueColor =
    tone === 'good'
      ? 'text-[#1D9E75]'
      : tone === 'warn'
      ? 'text-[#EF9F27]'
      : tone === 'bad'
      ? 'text-[#D85A30]'
      : 'text-[#F0EFE8]';
  return (
    <div className="glass-card p-4">
      <p className="text-[11px] uppercase tracking-wider text-[#8A877D]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-[#8A877D]">{hint}</p>}
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-[#F0EFE8]">{title}</h3>
      <p className="mt-0.5 text-xs text-[#8A877D]">{subtitle}</p>
    </div>
  );
}

// ===================================================================
// Retención por cohorte (heatmap)
// ===================================================================
function retentionCellStyle(rate: number | null): React.CSSProperties {
  if (rate === null) return { background: 'transparent', color: '#5A584F' };
  const alpha = Math.min(0.9, 0.06 + (rate / 100) * 0.7);
  return {
    background: `rgba(29,158,117,${alpha.toFixed(3)})`,
    color: rate >= 45 ? '#0E0E0C' : '#F0EFE8',
  };
}

function RetentionSection({ retention }: { retention: AdminRetention }) {
  const { periods, cohorts } = retention;
  return (
    <section className="space-y-3">
      <SectionHeader
        title="Retención por cohorte"
        subtitle="% de cada cohorte de registro que hizo ≥1 transacción en cada ventana de 30 días desde su alta. Vacío = la ventana aún no transcurrió."
      />
      {cohorts.length === 0 ? (
        <div className="glass-card p-6 text-sm text-[#8A877D]">Sin cohortes todavía.</div>
      ) : (
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[rgba(255,255,255,0.06)] text-left text-xs uppercase tracking-wider text-[#8A877D]">
                <th className="px-4 py-3 font-medium">Cohorte</th>
                <th className="px-4 py-3 font-medium text-right">Users</th>
                {periods.map((p) => (
                  <th key={p} className="px-3 py-3 text-center font-medium">
                    Mes {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => {
                const cellByPeriod = new Map(c.cells.map((cell) => [cell.period, cell]));
                return (
                  <tr
                    key={c.cohort}
                    className="border-b border-[rgba(255,255,255,0.04)] last:border-0"
                  >
                    <td className="px-4 py-2.5 font-medium text-[#F0EFE8]">{c.cohort}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#C8C6BC]">
                      {c.size}
                    </td>
                    {periods.map((p) => {
                      const cell = cellByPeriod.get(p);
                      const rate = cell?.rate ?? null;
                      return (
                        <td key={p} className="px-1.5 py-1.5 text-center">
                          <div
                            className="rounded-md px-2 py-1.5 text-xs font-medium tabular-nums"
                            style={retentionCellStyle(rate)}
                            title={
                              cell && rate !== null
                                ? `${cell.active} de ${c.size} activos`
                                : 'Ventana aún no transcurrida'
                            }
                          >
                            {rate === null ? '—' : `${rate}%`}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ===================================================================
// Distribución de engagement
// ===================================================================
function EngagementSection({ engagement }: { engagement: AdminEngagement }) {
  const { total, dormant, mean, median, buckets } = engagement;
  const dormantPct = total > 0 ? Math.round((dormant / total) * 1000) / 10 : 0;
  const data = buckets.map((b) => ({
    bucket: b.bucket === '0' ? '0 (dormido)' : b.bucket,
    usuarios: b.usuarios,
    isDormant: b.bucket === '0',
  }));

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Distribución de engagement"
        subtitle="Transacciones por usuario. La mediana y el % dormido cuentan la historia que el promedio esconde."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Mediana tx / usuario" value={median} hint="La mitad hace esto o menos" />
        <StatCard label="Promedio tx / usuario" value={mean} hint="Inflado por power users" />
        <StatCard
          label="Dormidos (0 tx)"
          value={`${dormantPct}%`}
          hint={`${dormant} de ${total}`}
          tone={dormantPct >= 40 ? 'bad' : dormantPct >= 20 ? 'warn' : 'good'}
        />
        <StatCard label="Usuarios reales" value={total} hint="Excluye cuentas internas" />
      </div>
      <div className="glass-card p-4">
        <p className="mb-3 text-sm font-medium text-[#F0EFE8]">Usuarios por rango de transacciones</p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="bucket" stroke="#8A877D" fontSize={12} />
              <YAxis stroke="#8A877D" fontSize={12} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                contentStyle={{
                  background: '#1C1C19',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: '#F0EFE8',
                }}
              />
              <Bar dataKey="usuarios" radius={[4, 4, 0, 0]}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.isDormant ? '#D85A30' : '#1D9E75'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

// ===================================================================
// Adopción de features
// ===================================================================
function AdoptionSection({
  adoption,
  total,
}: {
  adoption: FeatureAdoptionRow[];
  total: number;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        title="Adopción de features"
        subtitle={`Usuarios distintos que tocaron cada feature, sobre ${total} usuarios reales. Para decidir qué reforzar o dejar de mantener.`}
      />
      <div className="glass-card space-y-3 p-4">
        {adoption.map((f) => {
          const tone =
            f.pct >= 40 ? '#1D9E75' : f.pct >= 15 ? '#EF9F27' : '#D85A30';
          return (
            <div key={f.feature}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-[#C8C6BC]">{FEATURE_LABEL[f.feature] ?? f.feature}</span>
                <span className="tabular-nums text-[#8A877D]">
                  {f.users} <span className="text-[#5A584F]">({f.pct}%)</span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${Math.min(100, f.pct)}%`, backgroundColor: tone }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Cupo de la app OAuth de Google. **No es una fila más de adopción**, y por eso vive en su
 * propia sección: mide un INVENTARIO, no uso. El límite de 100 usuarios lo cuenta Google sobre
 * todo el ciclo de vida del proyecto, no se restablece, y no baja cuando alguien desconecta —
 * quien autorizó una vez ya gastó su cupo para siempre. O sea que este número solo sube, y el
 * día que llegue a 100 la única salida es la certificación CASA.
 *
 * La diferencia con la barra "Lectura Gmail" de arriba es deliberada: esa cuenta a los que HOY
 * tienen la conexión viva (los que el cron escanea), y siempre va a ser menor o igual que esta.
 */
function CupoGmailSection({ gastados }: { gastados: number }) {
  const CAP = 100;
  const pct = Math.min(100, Math.round((gastados / CAP) * 1000) / 10);
  const tone = pct >= 80 ? '#D85A30' : pct >= 50 ? '#EF9F27' : '#1D9E75';
  return (
    <section className="space-y-3">
      <SectionHeader
        title="Cupo OAuth de Google"
        subtitle="Usuarios que autorizaron Gmail alguna vez. El cupo NO se recupera al desconectar: quien autorizó una vez lo gastó para siempre. Al llegar a 100 hace falta la certificación CASA."
      />
      <div className="glass-card space-y-3 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-[#C8C6BC]">Cupos gastados</span>
          <span className="tabular-nums text-[#F0EFE8]">
            <span className="text-2xl font-semibold" style={{ color: tone }}>{gastados}</span>
            <span className="text-sm text-[#5A584F]"> / {CAP}</span>
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, backgroundColor: tone }}
          />
        </div>
        <p className="text-xs text-[#8A877D]">
          Incluye cuentas internas a propósito: gastan cupo igual que cualquier otra.
        </p>
      </div>
    </section>
  );
}

export default function AdminProductoPage() {
  const { data, isLoading, isError } = useAdminProducto();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-[#8A877D]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Cargando métricas de producto…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="glass-card p-6 text-sm text-[#D85A30]">
        Error cargando métricas de producto. Refresca la página.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-[#F0EFE8]">Producto & Retención</h2>
        <p className="mt-1 text-sm text-[#8A877D]">
          Activación, retención y adopción sobre usuarios reales (excluye cuentas internas). Lo que
          el embudo y el promedio no muestran.
        </p>
      </div>

      <RetentionSection retention={data.retention} />
      <EngagementSection engagement={data.engagement} />
      <AdoptionSection adoption={data.adoption} total={data.total_users} />
      <CupoGmailSection gastados={data.gmail_cupo} />
    </div>
  );
}
