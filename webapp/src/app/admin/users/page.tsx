'use client';

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useAdminUsers, type AdminUser } from '@/lib/hooks/use-admin-operacion';
import { useAdminUserFicha } from '@/lib/hooks/use-admin-user-ficha';
import {
  classifyUser,
  countBySegment,
  daysUntilProExpiry,
  isProExpiringSoon,
  SEGMENT_LABEL,
  SEGMENT_ORDER,
  type UserSegment,
  estadoComercial,
  countByEstado,
  diasHastaFinTrial,
  isTrialExpiringSoon,
  ESTADO_LABEL,
  ESTADO_HINT,
  ESTADO_ORDER,
  type EstadoComercial,
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

// El verde de la marca queda reservado para quien PAGA. La prueba va en ámbar: tiene Pro, pero
// es plata que todavía no entró y tiene fecha de vencimiento. Los tres muros comparten familia
// fría porque la acción sobre ellos es distinta entre sí pero ninguna es "cobrar hoy".
const ESTADO_TONE: Record<EstadoComercial, string> = {
  pro_pagado: '#1D9E75',
  pago_pendiente: '#68dbae',
  trial: '#EF9F27',
  muro_vencido: '#D85A30',
  muro_ex_pagador: '#a8705a',
  sin_estrenar: '#8A877D',
};

/**
 * Fecha de hoy en Lima, congelada al montar. Lazy init y no una lectura en render: React 19
 * marca `new Date()` en render como impuro, y además un valor estable evita que los `useMemo`
 * que dependen de él se recalculen en cada pasada.
 */
function useHoyLima(): string {
  const [hoy] = useState(() =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }),
  );
  return hoy;
}

/**
 * Badge del estado comercial. Reemplaza al `plan === 'premium' ? 'Pro' : 'Free'` que estaba
 * duplicado en la ficha y en la tabla — y que era falso en las dos direcciones bajo el modelo
 * de trial. Una sola definición para que las dos superficies no puedan volver a divergir.
 */
function EstadoBadge({ user, hoyLima }: { user: AdminUser; hoyLima: string }) {
  const estado = estadoComercial(user);
  // `hoyLima` llega por prop y no se lee el reloj acá: React 19 marca `new Date()` en render
  // como impuro, y es la misma razón por la que esta página snapshotea `now` con useState.
  const dias = diasHastaFinTrial(user, hoyLima);
  const tone = ESTADO_TONE[estado];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${tone}22`, color: tone }}
      title={ESTADO_HINT[estado]}
    >
      {ESTADO_LABEL[estado]}
      {estado === 'trial' && dias !== null && (
        <span className="ml-1 opacity-80">· {dias === 0 ? 'vence hoy' : `${dias}d`}</span>
      )}
    </span>
  );
}

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

function fmtPen(n: number): string {
  return `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ===================================================================
// Ficha individual (drill-down)
// ===================================================================
function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-[#8A877D]">{label}</span>
      <span className="text-right font-medium text-[#F0EFE8]">{value}</span>
    </div>
  );
}

function FeatureChip({ label, count }: { label: string; count: number }) {
  const on = count > 0;
  return (
    <div
      className={`rounded-lg border px-2.5 py-1.5 ${
        on
          ? 'border-[rgba(29,158,117,0.3)] bg-[rgba(29,158,117,0.08)]'
          : 'border-white/5 bg-white/[0.02]'
      }`}
    >
      <div className={`text-sm font-semibold tabular-nums ${on ? 'text-[#F0EFE8]' : 'text-[#5A584F]'}`}>
        {count}
      </div>
      <div className={`text-[10px] uppercase tracking-wide ${on ? 'text-[#8A877D]' : 'text-[#5A584F]'}`}>
        {label}
      </div>
    </div>
  );
}

function SheetSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-[#8A877D]">
        {title}
      </h4>
      {children}
    </div>
  );
}

function UserFichaSheet({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const { data, isLoading } = useAdminUserFicha(user?.id ?? null);
  const f = data?.features;
  const nps = data?.nps?.response_data;
  const seg = user ? classifyUser(user) : null;
  const hoyLima = useHoyLima();

  return (
    <Sheet open={!!user} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto border-l border-white/10 bg-[#131311] text-[#F0EFE8] sm:max-w-md"
      >
        {user && (
          <>
            <SheetHeader className="border-b border-white/5">
              <SheetTitle className="text-[#F0EFE8]">{userLabel(user)}</SheetTitle>
              <SheetDescription className="text-[#8A877D]">
                {user.email || user.whatsapp}
              </SheetDescription>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <EstadoBadge user={user} hoyLima={hoyLima} />
                {/* El plan no se toca cuando alguien pide borrar su cuenta (quien pagó conserva
                    su Pro si vuelve), así que sin esta chip la ficha decía "Pro · vence 2027"
                    sobre alguien que se fue. Es la misma marca que lo saca del MRR. */}
                {user.cuenta_borrada_at && (
                  <span className="inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">
                    Pidió borrar su cuenta
                  </span>
                )}
                {seg && (
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{
                      backgroundColor: `${SEGMENT_TONE[seg]}22`,
                      color: SEGMENT_TONE[seg],
                    }}
                  >
                    {SEGMENT_LABEL[seg]}
                  </span>
                )}
                <span className="text-xs text-[#8A877D]">{CANAL_LABEL[user.canal]}</span>
              </div>
            </SheetHeader>

            <div className="space-y-5 px-4 py-4">
              <SheetSection title="Timeline">
                <DetailRow label="Registro" value={fmtDate(user.created_at)} />
                <DetailRow label="Primera transacción" value={fmtDate(user.first_tx_at)} />
                {/* Actividad = tx O mensaje. Con last_tx_at, quien usa Neto por WhatsApp sin
                    registrar gastos figuraba como "sin actividad" aunque escribiera ese día. */}
                <DetailRow label="Última actividad" value={daysAgoLabel(user.last_activity_at)} />
                {/* Ramifica por estado y no por `plan`: durante la prueba `plan` es 'premium'
                    pero `premium_desde`/`premium_vence` son NULL a propósito, así que la ficha
                    mostraba "Se hizo Pro: —" y "Pro vence: —" sobre alguien que está probando.
                    Dos guiones donde correspondía una fecha de fin de prueba. */}
                {estadoComercial(user) === 'trial' ? (
                  <DetailRow label="Prueba termina" value={fmtDate(user.trial_vence)} />
                ) : (
                  user.plan === 'premium' && (
                    <>
                      <DetailRow label="Se hizo Pro" value={fmtDate(user.premium_desde)} />
                      <DetailRow label="Pro vence" value={fmtDate(user.premium_vence)} />
                    </>
                  )
                )}
                {user.cuenta_borrada_at && (
                  <DetailRow label="Pidió la baja" value={fmtDate(user.cuenta_borrada_at)} />
                )}
              </SheetSection>

              <SheetSection title="Actividad">
                <div className="grid grid-cols-3 gap-2">
                  <FeatureChip label="Tx total" count={user.transacciones} />
                  <FeatureChip label="Tx 30d" count={user.tx_30d ?? 0} />
                  <FeatureChip label="Tx 14d" count={user.tx_14d ?? 0} />
                </div>
                {/* El Score vive acá y no entre las features: no es algo que el usuario
                    elija usar (el cron se lo calcula a todos), es un indicador de su salud. */}
                <div className="mt-2">
                  <DetailRow
                    label="Neto Score"
                    value={f && f.score !== null ? `${f.score}/100` : '—'}
                  />
                </div>
              </SheetSection>

              <SheetSection title="Plan & valor">
                <DetailRow label="LTV (pagos aprobados)" value={f ? fmtPen(f.ltv_pen) : '—'} />
                <DetailRow label="Pagos aprobados" value={f ? f.pagos_aprobados : '—'} />
                <DetailRow label="Tickets de soporte" value={f ? f.tickets : '—'} />
              </SheetSection>

              <SheetSection title="Features que usa">
                {isLoading || !f ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-[#8A877D]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    <FeatureChip label="Categorías" count={f.categorias} />
                    <FeatureChip label="Presupuestos" count={f.presupuestos} />
                    <FeatureChip label="Metas" count={f.metas} />
                    <FeatureChip label="Deudas" count={f.deudas} />
                    <FeatureChip label="Espacios" count={f.espacios} />
                    <FeatureChip label="Alertas" count={f.alertas} />
                    <FeatureChip label="Gmail" count={f.gmail ? 1 : 0} />
                  </div>
                )}
              </SheetSection>

              <SheetSection title="NPS in-app">
                {nps ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      <FeatureChip label="Facilidad" count={nps.ease ?? 0} />
                      <FeatureChip label="Utilidad" count={nps.usefulness ?? 0} />
                      <FeatureChip label="Recomienda" count={nps.recommend ?? 0} />
                    </div>
                    {nps.comment && (
                      <p className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-sm text-[#C8C6BC]">
                        “{nps.comment}”
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="py-2 text-sm text-[#8A877D]">Sin respuesta NPS todavía.</p>
                )}
              </SheetSection>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ===================================================================
// Página
// ===================================================================
export default function AdminUsersPage() {
  const { data, isLoading, isError } = useAdminUsers();
  const [segment, setSegment] = useState<UserSegment | 'todos'>('todos');
  const [fichaUser, setFichaUser] = useState<AdminUser | null>(null);

  // Usuarios reales (excluye cuentas internas: fundador / QA) para todo el análisis.
  const users = useMemo(
    () => (data?.usuarios ?? []).filter((u) => !u.is_internal),
    [data?.usuarios],
  );

  const counts = useMemo(() => countBySegment(users), [users]);
  // Snapshot al montar (lazy init): estable para las deps de los useMemo y para el render, sin
  // llamar Date.now() en cada render (React 19 lo marca como impuro).
  const [now] = useState(() => Date.now());
  // Mismo snapshot, en el formato de fecha Lima que usan los predicados del trial.
  const hoyLima = useHoyLima();

  // Los conteos comerciales excluyen a quien pidió la baja. No es cosmético: el plan NO se toca
  // al dar de baja (quien pagó conserva su Pro si vuelve), así que sin este filtro la tarjeta
  // "Pro pagado" contaba 2 cuentas borradas que el MRR de esta misma pantalla ya descuenta, y
  // dos números de la misma pantalla decían cosas distintas sobre las mismas personas.
  // Siguen apareciendo en la LISTA, con su chip — lo que no hacen es contar como negocio.
  const usersComerciales = useMemo(() => users.filter((u) => !u.cuenta_borrada_at), [users]);

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

  // Las pruebas que se acaban. NO las ve `proExpiring`, que filtra por `premium_vence` — NULL
  // durante el trial por diseño. Es la lista comercialmente más urgente que tiene el panel:
  // cada fila es alguien que hoy tiene Pro y en N días deja de tenerlo sin haber pagado.
  const trialExpiring = useMemo(
    () =>
      usersComerciales
        .filter((u) => isTrialExpiringSoon(u, 5, hoyLima))
        .sort(
          (a, b) =>
            (diasHastaFinTrial(a, hoyLima) ?? 99) - (diasHastaFinTrial(b, hoyLima) ?? 99),
        ),
    [usersComerciales, hoyLima],
  );

  const countsEstado = useMemo(() => countByEstado(usersComerciales), [usersComerciales]);

  const nuevasConversiones = useMemo(
    () =>
      usersComerciales
        // `plan === 'premium' && premium_desde` contaba como conversión a cualquiera con Pro,
        // y durante la prueba eso es todo el mundo. Se pide el estado PAGADO explícitamente.
        .filter((u) => estadoComercial(u) === 'pro_pagado' && u.premium_desde)
        .sort((a, b) => +new Date(b.premium_desde!) - +new Date(a.premium_desde!))
        .slice(0, 8),
    [usersComerciales],
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
      const list = usersComerciales.filter((u) => u.canal === canal);
      // "Cómo convierte cada canal a Pro" tiene que contar PAGOS. Con `plan === 'premium'`
      // sumaba a todos los que están probando: al 27-ago-2026 eso era 31 "Pro" cuando los
      // pagadores eran 3, o sea una tasa de conversión inflada 10x en la pantalla que se usa
      // justo para decidir en qué canal invertir.
      const pro = list.filter((u) => estadoComercial(u) === 'pro_pagado').length;
      const enPrueba = list.filter((u) => estadoComercial(u) === 'trial').length;
      const conv = list.length > 0 ? Math.round((pro / list.length) * 1000) / 10 : 0;
      return { canal, total: list.length, pro, enPrueba, conv };
    });
  }, [usersComerciales]);

  const listedUsers = useMemo(() => {
    const list =
      segment === 'todos' ? users : users.filter((u) => classifyUser(u) === segment);
    // Ordena por la misma señal que pinta la columna "Última actividad", no por última tx.
    return [...list].sort(
      (a, b) => +new Date(b.last_activity_at ?? 0) - +new Date(a.last_activity_at ?? 0),
    );
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

      {/* Estado comercial. Va ARRIBA de los segmentos de actividad a propósito: "cuántos pagan"
          es la primera pregunta del panel, y hasta hoy no se podía contestar desde acá. */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-base font-semibold text-[#F0EFE8]">Estado comercial</h3>
          <span className="text-xs text-[#8A877D]">
            Durante la prueba el plan es Pro, así que “Pro” no significa “paga”
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          {ESTADO_ORDER.map((e) => (
            <div
              key={e}
              className="glass-card px-3 py-3"
              title={ESTADO_HINT[e]}
            >
              <div
                className="font-mono text-xl tabular-nums"
                style={{ color: ESTADO_TONE[e] }}
              >
                {countsEstado[e]}
              </div>
              <div className="mt-0.5 text-xs font-medium text-[#C8C6BC]">{ESTADO_LABEL[e]}</div>
            </div>
          ))}
        </div>
        {trialExpiring.length > 0 && (
          <div className="rounded-xl border border-[rgba(239,159,39,0.35)] bg-[rgba(239,159,39,0.08)] px-4 py-3 text-sm text-[#EF9F27]">
            {trialExpiring.length}{' '}
            {trialExpiring.length === 1 ? 'prueba termina' : 'pruebas terminan'} en ≤5 días. Al
            vencer caen al muro: siguen anotando gastos, pero dejan de poder leerlos.
          </div>
        )}
      </section>

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
          <span className="text-xs text-[#8A877D]">
            {listedUsers.length} usuarios · click para ver la ficha
          </span>
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
                    onClick={() => setFichaUser(u)}
                    className="cursor-pointer border-b border-[rgba(255,255,255,0.04)] transition-colors last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#F0EFE8]">{userLabel(u)}</div>
                      <div className="text-xs text-[#8A877D]">{u.email || u.whatsapp}</div>
                    </td>
                    <td className="px-4 py-3">
                      <EstadoBadge user={u} hoyLima={hoyLima} />
                    </td>
                    <td className="px-4 py-3 text-[#C8C6BC]">{CANAL_LABEL[u.canal]}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-[#C8C6BC]">
                      {u.transacciones}
                    </td>
                    <td className="px-4 py-3 text-[#C8C6BC]">{daysAgoLabel(u.last_activity_at)}</td>
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
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
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
            {/* Acá sí manda last_tx_at: el segmento "en riesgo" se define por dejar de
                registrar gastos, así que mostrar otra fecha contradiría el criterio. */}
            {enfriandose.map((u) => (
              <FeedRow key={u.id} name={userLabel(u)} right={daysAgoLabel(u.last_tx_at)} />
            ))}
          </MiniList>
          <MiniList title="Pruebas por vencer" empty={trialExpiring.length === 0}>
            {trialExpiring.map((u) => {
              const d = diasHastaFinTrial(u, hoyLima);
              return (
                <FeedRow
                  key={u.id}
                  name={userLabel(u)}
                  right={d === 0 ? 'vence hoy' : `en ${d}d`}
                />
              );
            })}
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
                    {c.total} usuarios · {c.pro} pagan · {c.enPrueba} probando{' '}
                    <span className="text-[#5A584F]">({c.conv}% conversión)</span>
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${usersComerciales.length > 0 ? (c.total / usersComerciales.length) * 100 : 0}%`,
                      backgroundColor: '#1D9E75',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <UserFichaSheet user={fichaUser} onClose={() => setFichaUser(null)} />
    </div>
  );
}
