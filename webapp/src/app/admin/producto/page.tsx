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
      ? 'text-primary'
      : tone === 'warn'
      ? 'text-warning'
      : tone === 'bad'
      ? 'text-negative'
      : 'text-foreground';
  return (
    <div className="glass-card p-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
}

// ===================================================================
// Retención por cohorte (heatmap)
// ===================================================================
function retentionCellStyle(rate: number | null): React.CSSProperties {
  if (rate === null) return { background: 'transparent', color: 'var(--muted-foreground)' };
  // El texto va siempre en `foreground` y el tinte se topa en 45%. Con el corte viejo (texto en
  // `background` desde 45%) las celdas medias quedaban a 1.8:1 en claro, y en oscuro hay una franja
  // (tinte 50-60%) donde ni el texto claro ni el oscuro llegan a 4.5:1. Con el tope: >= 5:1 en oscuro
  // y >= 9:1 en claro, medido el 12-oct-2026.
  const alpha = 0.06 + (Math.min(100, Math.max(0, rate)) / 100) * 0.39;
  return {
    background: `color-mix(in srgb, var(--primary) ${(alpha * 100).toFixed(1)}%, transparent)`,
    color: 'var(--foreground)',
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
        <div className="glass-card p-6 text-sm text-muted-foreground">Sin cohortes todavía.</div>
      ) : (
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
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
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-2.5 font-medium text-foreground">{c.cohort}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground-soft">
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
        <p className="mb-3 text-sm font-medium text-foreground">Usuarios por rango de transacciones</p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--foreground) 5%, transparent)" />
              <XAxis dataKey="bucket" stroke="var(--muted-foreground)" fontSize={12} />
              <YAxis stroke="var(--muted-foreground)" fontSize={12} allowDecimals={false} />
              <Tooltip itemStyle={{ color: 'var(--foreground)' }}
                cursor={{ fill: 'color-mix(in srgb, var(--foreground) 3%, transparent)' }}
                contentStyle={{
                  background: 'var(--surface-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--foreground)',
                }}
              />
              <Bar dataKey="usuarios" radius={[4, 4, 0, 0]}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.isDormant ? 'var(--negative)' : 'var(--primary)'} />
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
            f.pct >= 40 ? 'var(--primary)' : f.pct >= 15 ? 'var(--warning)' : 'var(--negative)';
          return (
            <div key={f.feature}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-foreground-soft">{FEATURE_LABEL[f.feature] ?? f.feature}</span>
                <span className="tabular-nums text-muted-foreground">
                  {f.users} <span className="text-muted-foreground">({f.pct}%)</span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-foreground/5">
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
  const tone = pct >= 80 ? 'var(--negative)' : pct >= 50 ? 'var(--warning)' : 'var(--primary)';
  return (
    <section className="space-y-3">
      <SectionHeader
        title="Cupo OAuth de Google"
        subtitle="Usuarios que autorizaron Gmail alguna vez. El cupo NO se recupera al desconectar: quien autorizó una vez lo gastó para siempre. Al llegar a 100 hace falta la certificación CASA."
      />
      <div className="glass-card space-y-3 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-foreground-soft">Cupos gastados</span>
          <span className="tabular-nums text-foreground">
            <span className="text-2xl font-semibold" style={{ color: tone }}>{gastados}</span>
            <span className="text-sm text-muted-foreground"> / {CAP}</span>
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-foreground/5">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, backgroundColor: tone }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
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
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Cargando métricas de producto…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="glass-card p-6 text-sm text-negative">
        Error cargando métricas de producto. Refresca la página.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Producto & Retención</h2>
        <p className="mt-1 text-sm text-muted-foreground">
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
