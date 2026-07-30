'use client';

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAdminUsers, type AdminUser } from '@/lib/hooks/use-admin-operacion';
import {
  classifyUser,
  countBySegment,
  daysUntilProExpiry,
  isProExpiringSoon,
  SEGMENT_LABEL,
  SEGMENT_ORDER,
  type UserSegment,
} from '@/lib/admin-user-segments';

// ===================================================================
// Formato
// ===================================================================
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'America/Lima',
  });
}

function daysAgoLabel(iso: string | null | undefined): string {
  if (!iso) return 'sin actividad';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  return `hace ${d}d`;
}

function userLabel(u: AdminUser): string {
  return u.nombre || u.whatsapp || u.email || u.id.slice(0, 8);
}

const CANAL_LABEL: Record<AdminUser['canal'], string> = {
  whatsapp: 'WhatsApp',
  google: 'Google',
  magic_link: 'Magic Link',
};

const SEGMENT_TONE: Record<UserSegment, string> = {
  power: '#1D9E75',
  activo: '#68dbae',
  en_riesgo: '#EF9F27',
  dormido: '#D85A30',
};

const SEGMENT_HINT: Record<UserSegment, string> = {
  power: '≥1 tx en 14d y ≥30 tx totales',
  activo: '≥1 tx en los últimos 14 días',
  en_riesgo: 'sin tx en 14d, activo en 30d',
  dormido: '0 tx o sin actividad en 30d',
};

// ===================================================================
// Sub-componentes
// ===================================================================
function SegmentCard({
  label,
  count,
  hint,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  hint: string;
  tone: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`glass-card rounded-xl p-4 text-left transition-all ${
        active ? 'ring-1 ring-[rgba(29,158,117,0.5)]' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-[#8A877D]">{label}</span>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tone }} />
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-[#F0EFE8]">{count}</div>
      <div className="mt-1 text-xs text-[#8A877D]">{hint}</div>
    </button>
  );
}

function MiniList({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="mb-3 text-sm font-medium text-[#F0EFE8]">{title}</h3>
      {empty ? (
        <p className="py-4 text-center text-xs text-[#8A877D]">Nada por acá todavía.</p>
      ) : (
        <ul className="space-y-2">{children}</ul>
      )}
    </div>
  );
}

function FeedRow({ name, right }: { name: string; right: string }) {
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0 truncate text-[#C8C6BC]">{name}</span>
      <span className="shrink-0 text-xs tabular-nums text-[#8A877D]">{right}</span>
    </li>
  );
}

// ===================================================================
// Página
// ===================================================================
export default function AdminUsersPage() {
  const { data, isLoading, isError } = useAdminUsers();
  const [segment, setSegment] = useState<UserSegment | 'todos'>('todos');

  // Usuarios reales (excluye cuentas internas: fundador / QA) para todo el análisis.
  const users = useMemo(
    () => (data?.usuarios ?? []).filter((u) => !u.is_internal),
    [data?.usuarios],
  );

  const counts = useMemo(() => countBySegment(users), [users]);
  // Snapshot al montar (lazy init): estable para las deps de los useMemo y para el render, sin
  // llamar Date.now() en cada render (React 19 lo marca como impuro).
  const [now] = useState(() => Date.now());

  const proExpiring = useMemo(
    () =>
      users
        .filter((u) => isProExpiringSoon(u, now))
        .sort(
          (a, b) =>
            (daysUntilProExpiry(a, now) ?? 999) - (daysUntilProExpiry(b, now) ?? 999),
        ),
    [users, now],
  );

  const nuevosRegistros = useMemo(
    () =>
      [...users]
        .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
        .slice(0, 8),
    [users],
  );

  const nuevasConversiones = useMemo(
    () =>
      users
        .filter((u) => u.plan === 'premium' && u.premium_desde)
        .sort((a, b) => +new Date(b.premium_desde!) - +new Date(a.premium_desde!))
        .slice(0, 8),
    [users],
  );

  const enfriandose = useMemo(
    () =>
      users
        .filter((u) => classifyUser(u) === 'en_riesgo')
        .sort((a, b) => +new Date(b.last_tx_at ?? 0) - +new Date(a.last_tx_at ?? 0))
        .slice(0, 8),
    [users],
  );

  const porCanal = useMemo(() => {
    const canales: AdminUser['canal'][] = ['whatsapp', 'google', 'magic_link'];
    return canales.map((canal) => {
      const list = users.filter((u) => u.canal === canal);
      const pro = list.filter((u) => u.plan === 'premium').length;
      const conv = list.length > 0 ? Math.round((pro / list.length) * 1000) / 10 : 0;
      return { canal, total: list.length, pro, conv };
    });
  }, [users]);

  const listedUsers = useMemo(() => {
    const list =
      segment === 'todos' ? users : users.filter((u) => classifyUser(u) === segment);
    return [...list].sort((a, b) => +new Date(b.last_tx_at ?? 0) - +new Date(a.last_tx_at ?? 0));
  }, [users, segment]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-[#8A877D]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Cargando usuarios…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="glass-card p-6 text-sm text-[#D85A30]">
        Error cargando usuarios. Refresca la página.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-[#F0EFE8]">Usuarios</h2>
        <p className="mt-1 text-sm text-[#8A877D]">
          Salud de la base por segmento, actividad reciente y adquisición. Sobre usuarios reales
          (excluye cuentas internas). La gestión operativa (activar Pro, tickets) vive en Operación.
        </p>
      </div>

      {/* Segmentos */}
      <section className="space-y-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <SegmentCard
            label="Todos"
            count={users.length}
            hint="Usuarios reales"
            tone="#8A877D"
            active={segment === 'todos'}
            onClick={() => setSegment('todos')}
          />
          {SEGMENT_ORDER.map((s) => (
            <SegmentCard
              key={s}
              label={SEGMENT_LABEL[s]}
              count={counts[s]}
              hint={SEGMENT_HINT[s]}
              tone={SEGMENT_TONE[s]}
              active={segment === s}
              onClick={() => setSegment(s)}
            />
          ))}
        </div>
        {proExpiring.length > 0 && (
          <div className="rounded-xl border border-[rgba(239,159,39,0.35)] bg-[rgba(239,159,39,0.08)] px-4 py-3 text-sm text-[#EF9F27]">
            {proExpiring.length} Pro {proExpiring.length === 1 ? 'vence' : 'vencen'} en ≤7 días (o ya
            vencidos). Revisá el feed de la derecha para renovarlos.
          </div>
        )}
      </section>

      {/* Lista del segmento seleccionado */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-base font-semibold text-[#F0EFE8]">
            {segment === 'todos' ? 'Todos los usuarios' : SEGMENT_LABEL[segment]}
          </h3>
          <span className="text-xs text-[#8A877D]">{listedUsers.length} usuarios</span>
        </div>
        <div className="glass-card overflow-hidden">
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-[#131311]">
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-[#8A877D]">
                  <th className="px-4 py-3 font-medium">Usuario</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">Canal</th>
                  <th className="px-4 py-3 text-right font-medium">Tx</th>
                  <th className="px-4 py-3 font-medium">Última actividad</th>
                  <th className="px-4 py-3 font-medium">Registro</th>
                </tr>
              </thead>
              <tbody>
                {listedUsers.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-[rgba(255,255,255,0.04)] last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#F0EFE8]">{userLabel(u)}</div>
                      <div className="text-xs text-[#8A877D]">{u.email || u.whatsapp}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          u.plan === 'premium'
                            ? 'bg-[rgba(29,158,117,0.14)] text-[#1D9E75]'
                            : 'bg-white/5 text-[#8A877D]'
                        }`}
                      >
                        {u.plan === 'premium' ? 'Pro' : 'Free'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#C8C6BC]">{CANAL_LABEL[u.canal]}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-[#C8C6BC]">
                      {u.transacciones}
                    </td>
                    <td className="px-4 py-3 text-[#C8C6BC]">{daysAgoLabel(u.last_tx_at)}</td>
                    <td className="px-4 py-3 text-xs text-[#8A877D]">{fmtDate(u.created_at)}</td>
                  </tr>
                ))}
                {listedUsers.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-[#8A877D]">
                      Ningún usuario en este segmento.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Feed de actividad reciente */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-[#F0EFE8]">Actividad reciente</h3>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniList title="Nuevos registros" empty={nuevosRegistros.length === 0}>
            {nuevosRegistros.map((u) => (
              <FeedRow key={u.id} name={userLabel(u)} right={fmtDate(u.created_at)} />
            ))}
          </MiniList>
          <MiniList title="Conversiones a Pro" empty={nuevasConversiones.length === 0}>
            {nuevasConversiones.map((u) => (
              <FeedRow key={u.id} name={userLabel(u)} right={fmtDate(u.premium_desde)} />
            ))}
          </MiniList>
          <MiniList title="Enfriándose (en riesgo)" empty={enfriandose.length === 0}>
            {enfriandose.map((u) => (
              <FeedRow key={u.id} name={userLabel(u)} right={daysAgoLabel(u.last_tx_at)} />
            ))}
          </MiniList>
          <MiniList title="Pro por vencer" empty={proExpiring.length === 0}>
            {proExpiring.map((u) => {
              const d = daysUntilProExpiry(u, now);
              return (
                <FeedRow
                  key={u.id}
                  name={userLabel(u)}
                  right={d !== null && d < 0 ? `vencido ${-d}d` : `en ${d}d`}
                />
              );
            })}
          </MiniList>
        </div>
      </section>

      {/* Adquisición por canal */}
      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-[#F0EFE8]">Adquisición por canal</h3>
          <p className="mt-0.5 text-xs text-[#8A877D]">
            De dónde vienen los usuarios y cómo convierte cada canal a Pro. (Referidos aún sin datos.)
          </p>
        </div>
        <div className="glass-card rounded-xl p-4">
          <div className="space-y-3">
            {porCanal.map((c) => (
              <div key={c.canal}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-[#C8C6BC]">{CANAL_LABEL[c.canal]}</span>
                  <span className="tabular-nums text-[#8A877D]">
                    {c.total} usuarios · {c.pro} Pro{' '}
                    <span className="text-[#5A584F]">({c.conv}% conversión)</span>
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${users.length > 0 ? (c.total / users.length) * 100 : 0}%`,
                      backgroundColor: '#1D9E75',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
