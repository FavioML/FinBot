'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
// Los precios salen de una sola fuente (lib/constants), nunca escritos a mano.
import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from '@/lib/constants';
import { toCsv, downloadCsv } from '@/lib/csv-export';
import { avisosReferido, type ResumenReferido } from '@/lib/admin-referido';
import {
  useAdminStats,
  useAdminUsers,
  useAdminNlpErrors,
  useAdminTickets,
  useAdminTicketThread,
  type AdminUser,
  type TicketMensaje,
  type NlpError,
} from '@/lib/hooks/use-admin-operacion';
import { ErrorState } from '@/components/shared/error-state';
// El motor de estado comercial, el MISMO que usa /admin/users. No se reimplementa acá: es
// la fuente única de qué significa cada combinación de `plan` + `trial_estado`.
import { estadoComercial, ESTADO_LABEL, ESTADO_HINT, type EstadoComercial } from '@/lib/admin-user-segments';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

/**
 * Cómo se nombra a un usuario en una pantalla de admin (F16).
 *
 * `nombre || whatsapp` era la forma vieja y falla en el caso que la identidad dual hizo
 * posible: el usuario web-first sin nombre tiene las DOS columnas en null, y un template
 * literal acepta null sin chistar — así que el diálogo decía "Eliminar a null?". El
 * compilador no lo ve porque `${null}` es válido, así que el guard es este helper y no un
 * tipo. Los mapas `whatsapp -> nombre` NO lo usan: ahí la clave ya garantiza el número.
 */
function etiquetaUsuario(u?: { nombre?: string | null; whatsapp?: string | null } | null): string {
  return u?.nombre || u?.whatsapp || 'este usuario (sin nombre)';
}

/**
 * Los `error_tipo` de `nlp_errors` que son una PERSONA esperando respuesta, y no diagnostico.
 *
 * La tabla mezcla las dos cosas: `rate_limit` es un 429 de OpenAI, `desconocido` es un mensaje
 * que la NLP no entendio, y ninguno de los dos hizo una pregunta. `feedback` y `queja` si — y
 * hasta hoy la unica forma de contestarles era escribirles desde un celular.
 *
 * Si agregas un tipo que espera respuesta, va aca. Un `includes` suelto en el JSX haria que la
 * decision viva en el unico lugar donde nadie la busca.
 */
const ESPERAN_RESPUESTA = new Set(['feedback', 'queja']);

/**
 * El hilo de una conversación de soporte (migración 079).
 *
 * Hasta el 28-ago-2026 esta pantalla mostraba UNA línea por lado: `tickets_soporte` guarda un
 * `mensaje_usuario` y un `mensaje_admin`, y cada turno PISABA al anterior. De una conversación
 * de cinco mensajes sobrevivía el último de cada lado, así que retomarla era imposible: no
 * había forma de saber qué se había contestado ya.
 *
 * Se monta sólo cuando el admin abre la respuesta, para no disparar una query por ticket.
 */
/**
 * El desenlace de un turno del admin, en tres estados que NO se colapsan.
 *
 * `null` es "no se sabe", y es distinto de "no llego": pasa cuando el envio no dejo wamid
 * (Meta lo rechazo de entrada) o cuando el turno es anterior a la migracion 079b. Pintar eso
 * como no entregado seria inventar un fallo; pintarlo como entregado seria el bug B23 otra vez.
 */
function EstadoEntrega({ entrega }: { entrega: TicketMensaje['entrega'] }) {
  if (!entrega) return <span className="text-muted-foreground">sin dato de entrega</span>;
  if (entrega.delivered_at) return <span className="text-primary">entregado</span>;
  if (entrega.failed_at) {
    // 131047 es la ventana de 24h de Meta, y es el 98% de los fallos. Nombrarla evita que el
    // admin reintente: lo que hay que hacer es esperar a que la persona escriba.
    const ventana = entrega.code === 131047;
    return (
      <span className="text-warning/90">
        {ventana ? 'no entregado · fuera de la ventana de 24h' : 'no entregado'}
        {!ventana && entrega.code ? ` (code ${entrega.code})` : ''}
      </span>
    );
  }
  return <span className="text-muted-foreground">enviado, sin confirmacion aun</span>;
}

function HiloTicket({ ticketId }: { ticketId: string }) {
  const { data, isLoading, isError, refetch } = useAdminTicketThread(ticketId);

  if (isLoading) return <div className="py-2 text-xs text-muted-foreground">Cargando conversación…</div>;

  // "Falló la lectura" NO se pinta como "no hay mensajes": eso le diría al admin que la
  // persona nunca escribió, que es la conclusión opuesta a la verdadera.
  // ErrorState compartido, no un botón propio: `error-state-callsites.test.ts` marca las copias
  // a mano, y con razón — este bloque ya se pegó a mano en media docena de pantallas.
  if (isError) {
    return (
      <div className="py-2">
        <ErrorState
          titulo="la conversación"
          variante="card"
          descripcion="La lectura falló. Es distinto de que no haya mensajes en el hilo."
          onReintentar={() => refetch()}
        />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="py-2 text-xs text-muted-foreground">
        Sin mensajes en el hilo. Las conversaciones anteriores al 28-ago-2026 no se guardaron turno a turno.
      </div>
    );
  }

  return (
    <div className="max-h-64 space-y-2 overflow-y-auto py-2">
      {data.map((m) => (
        <div
          key={m.id}
          className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
            m.rol === 'admin'
              ? 'ml-auto bg-primary/15 text-foreground'
              : 'mr-auto bg-foreground/[0.04] text-foreground-soft'
          }`}
        >
          <div className="whitespace-pre-wrap break-words">{m.mensaje}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {m.rol === 'admin' ? 'Neto' : 'Usuario'} · {formatDateTime(m.created_at)}
            {m.rol === 'admin' && <> · <EstadoEntrega entrega={m.entrega} /></>}
          </div>
        </div>
      ))}
    </div>
  );
}

interface Pago {
  id: string;
  monto: number | null;
  moneda: string | null;
  tipo_plan: string | null;
  metodo_pago: string | null;
  estado: string;
  origen: string | null;
  comprobante_signed_url: string | null;
  monto_detectado: number | null;
  premium_desde: string | null;
  premium_vence: string | null;
  detectado_at: string | null;
  aprobado_at: string | null;
  created_at: string;
}

function hasTimezone(s: string) {
  return /Z$|[+-]\d{2}:?\d{2}$/.test(s);
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  const d = new Date(hasTimezone(dateStr) ? dateStr : dateStr + 'Z');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'America/Lima',
  });
}

function formatDateTime(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  const d = new Date(hasTimezone(dateStr) ? dateStr : dateStr + 'Z');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Lima',
  });
}

// `bajaAt` no es cosmetica: el plan NO se toca cuando alguien pide borrar su cuenta (quien
// pago conserva su Pro si vuelve), asi que sin esto operacion mostraba "Pro" a secas sobre los
// dos usuarios que se fueron, uno con `premium_vence` en 2027. Es la misma marca que los saca
// del MRR en admin-revenue.ts.
// **Seis estados, no dos.** Decía `plan === 'premium' ? 'Pro' : 'Free'`, y bajo el modelo
// de trial eso miente en las dos direcciones: durante la prueba `plan` vale 'premium' a
// propósito (migración 052), así que los ~30 en prueba se veían idénticos a los 2 que pagan;
// y "Free" colapsaba tres poblaciones con acciones OPUESTAS (activar / cobrar / recuperar).
//
// Es el mismo arreglo que /admin/users recibió el 27-ago (commit 1f02357) y que esta
// pantalla no recibió, porque el panel tiene DOS tablas de usuarios y sólo se tocó una.
const ESTADO_COLOR: Record<EstadoComercial, string> = {
  pro_pagado: 'bg-primary/20 text-primary-ink',
  // Violeta y no verde: tiene Pro, pero no es plata. El verde de la marca queda para quien
  // paga. Tampoco ambar ni celeste, que ya son el pago por aprobar y la prueba.
  pro_cortesia: 'bg-chart-5/15 text-chart-5',
  pago_pendiente: 'bg-warning/15 text-warning-ink',
  trial: 'bg-info/15 text-info-ink',
  muro_vencido: 'bg-foreground/5 text-muted-foreground',
  muro_ex_pagador: 'bg-foreground/5 text-muted-foreground',
  sin_estrenar: 'bg-foreground/5 text-muted-foreground',
};

function PlanBadge({ estado, bajaAt }: { estado: EstadoComercial; bajaAt?: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        title={ESTADO_HINT[estado]}
        className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${ESTADO_COLOR[estado]}`}
      >
        {ESTADO_LABEL[estado]}
      </span>
      {bajaAt && (
        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-negative/15 px-2 py-0.5 text-xs font-medium text-negative-ink">
          Baja
        </span>
      )}
    </span>
  );
}

/**
 * Punto de estado. `warn` pinta ámbar sobre un activo: está conectado, pero algo no funciona.
 * Hoy lo usa Gmail para "la autorización se cayó" — verde y apagado no alcanzan para eso,
 * porque el verde diría que el correo se está leyendo y el apagado diría que nunca se conectó.
 */
function StatusDot({ active, warn = false, title }: { active: boolean; warn?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-block h-2 w-2 rounded-full ${
        active ? (warn ? 'bg-warning' : 'bg-primary') : 'bg-foreground/20'
      }`}
    />
  );
}

/** Qué dice el tooltip del punto de Gmail. Los tres estados tienen acciones distintas. */
function gmailTitle(u: AdminUser): string {
  if (!u.tiene_gmail) return 'Sin Gmail conectado';
  if (u.gmail_caido) return 'Gmail conectado pero con la autorización caída: hay que reconectar';
  return 'Gmail conectado';
}

function CanalBadge({ canal }: { canal: 'whatsapp' | 'google' | 'magic_link' }) {
  const styles = {
    whatsapp: 'bg-[#25D366]/15 text-foreground',
    google: 'bg-info/15 text-info-ink',
    magic_link: 'bg-chart-5/15 text-chart-5',
  };
  const labels = {
    whatsapp: 'WhatsApp',
    google: 'Google',
    magic_link: 'Magic Link',
  };
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${styles[canal]}`}>
      {labels[canal]}
    </span>
  );
}

/**
 * Menú de acciones por usuario.
 *
 * **El popup se renderiza en un PORTAL, y eso no es un detalle de implementación.** La versión
 * anterior era un `div.absolute` dentro de la celda, o sea dentro del contenedor de la tabla,
 * que tiene `max-h-[65dvh] overflow-auto` (y un padre con `overflow-hidden`). Un elemento
 * absoluto se recorta contra el primer ancestro con overflow, así que el menú se veía completo
 * solo mientras la tabla fuera más alta que él: al filtrar hasta dejar una o dos filas —justo
 * cuando buscás a UNA persona para actuar sobre ella— el contenedor medía menos que el menú y
 * las opciones de abajo (desactivar, eliminar) quedaban fuera de la vista, sin scroll que las
 * alcanzara. Base UI lo saca del flujo con `Portal` y lo ancla con `Positioner`, que además
 * voltea el menú hacia arriba cuando no hay espacio abajo. No volver a un `absolute` acá.
 *
 * El sub-panel de confirmación sigue viviendo DENTRO del popup, y los dos disparadores que lo
 * abren llevan `closeOnClick={false}`: sin eso el menú se cierra en el mismo click que pide la
 * confirmación y la pregunta nunca se ve.
 *
 * **Cancelar y Confirmar son `DropdownMenuItem`, no `<button>` sueltos**, y eso también se
 * paga si se cambia. `Menu.Popup` maneja el foco como un composite: captura Tab y las flechas
 * y solo navega entre sus items, así que un botón suelto adentro queda inalcanzable por
 * teclado — con el `div.absolute` de antes eran tabbables normales, o sea que la migración al
 * portal se lo habría llevado puesto en silencio. Una acción irreversible detrás de un control
 * que solo responde al mouse es peor que la que se recortaba.
 */
function UserActions({
  user,
  onAction,
}: {
  user: AdminUser;
  onAction: (userId: string, action: string, data?: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exec = async (action: string, data?: Record<string, unknown>) => {
    setBusy(true);
    await onAction(user.id, action, data);
    setBusy(false);
    setOpen(false);
    setConfirming(null);
  };

  // **Acá `plan` es lo correcto y no se toca.** Este menú decide qué ACCIÓN ofrecer, y las
  // acciones operan sobre la capability (`set_plan` prende o apaga `plan`), no sobre quién
  // paga. A alguien en prueba no se le ofrece "Activar Pro" porque ya lo tiene. Lo que
  // mentía era la ETIQUETA, que es lo que se arregló arriba.
  const isPro = user.plan === 'premium';

  const itemClass =
    'flex w-full cursor-pointer items-center gap-2 rounded-none px-4 py-2.5 text-left text-sm text-foreground-soft focus:bg-foreground/5 focus:text-foreground';

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        // La confirmación es una pregunta abierta, no un estado que sobreviva al cierre: si
        // se reabre el menú tiene que empezar por el listado, no por "¿Eliminar a X?".
        if (!o) setConfirming(null);
      }}
    >
      <DropdownMenuTrigger
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        title="Acciones"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-56 rounded-xl border border-border bg-surface-elevated p-0 py-1 text-foreground shadow-xl shadow-scrim/60"
      >
        {confirming && (
          <div className="p-3">
            <p className="mb-3 text-xs text-foreground-soft">
              {confirming === 'delete'
                ? `Eliminar a ${etiquetaUsuario(user)}? Se borran TODOS sus datos. Irreversible.`
                : confirming === 'deactivate'
                  ? `Desactivar a ${etiquetaUsuario(user)}? Se pasa a Free y se desconecta Gmail.`
                  : `Confirmar accion?`}
            </p>
            <div className="flex gap-2">
              <DropdownMenuItem
                closeOnClick={false}
                onClick={() => setConfirming(null)}
                disabled={busy}
                className="flex-1 justify-center rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground focus:bg-foreground/5"
              >
                Cancelar
              </DropdownMenuItem>
              <DropdownMenuItem
                // `closeOnClick={false}` igual que Cancelar, y no es simetría: sin él Base UI
                // desmonta el popup en el mismo click, así que el `{busy ? 'Procesando...'}`
                // no se renderiza nunca y un DELETE lento no da ninguna señal. Peor: si el
                // admin reabre el menú mientras la acción está en vuelo —probable, justo
                // porque no pasó nada visible— `onOpenChange` ya limpió `confirming` y ve el
                // listado con todos los items en `disabled` sin explicación. `exec` cierra
                // solo, al final, cuando de verdad terminó.
                closeOnClick={false}
                onClick={() => exec(confirming)}
                disabled={busy}
                className={`flex-1 justify-center rounded-lg px-3 py-1.5 text-xs font-medium ${
                  confirming === 'delete'
                    ? 'bg-negative text-negative-foreground focus:bg-negative/90'
                    : 'bg-warning text-warning-foreground focus:bg-warning/90'
                }`}
              >
                {busy ? 'Procesando...' : 'Confirmar'}
              </DropdownMenuItem>
            </div>
          </div>
        )}

        {!confirming && (
          <>
            <DropdownMenuItem
              onClick={() => exec('view_payments')}
              disabled={busy}
              className={itemClass}
            >
              <span className="text-muted-foreground">&#128179;</span> Ver pagos / comprobante
              {user.pago_pendiente && <span className="ml-auto rounded-full bg-warning/15 px-1.5 py-0.5 text-xs text-warning-ink">pendiente</span>}
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-1 bg-foreground/5" />

            {!isPro && (
              <DropdownMenuItem
                onClick={() => exec('set_plan', { plan: 'premium' })}
                disabled={busy}
                className={itemClass}
              >
                <span className="text-primary-ink">&#9733;</span> Activar Pro (30 dias)
              </DropdownMenuItem>
            )}
            {isPro && (
              <>
                <DropdownMenuItem
                  onClick={() => exec('notify_pro', { tipo_plan: user.tipo_plan || 'mensual' })}
                  disabled={busy}
                  className={itemClass}
                >
                  <span className="text-positive-ink">&#128172;</span> Notificar Pro por WhatsApp
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => exec('extend_premium', { days: 30 })}
                  disabled={busy}
                  className={itemClass}
                >
                  <span className="text-primary-ink">+</span> Extender +30 dias
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => exec('set_plan', { plan: 'free' })}
                  disabled={busy}
                  className={itemClass}
                >
                  <span className="text-muted-foreground">&#9744;</span> Pasar a Free
                </DropdownMenuItem>
              </>
            )}

            <DropdownMenuSeparator className="my-1 bg-foreground/5" />

            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => setConfirming('deactivate')}
              disabled={busy}
              className={`${itemClass} text-warning-ink/80 focus:text-warning-ink`}
            >
              <span>&#9888;</span> Desactivar cuenta
            </DropdownMenuItem>

            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => setConfirming('delete')}
              disabled={busy}
              className={`${itemClass} text-destructive-ink/80 focus:text-destructive-ink`}
            >
              <span>&#10005;</span> Eliminar usuario
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PagoEstadoBadge({ estado }: { estado: string }) {
  const styles: Record<string, string> = {
    aprobado: 'bg-primary/20 text-primary-ink',
    pendiente: 'bg-warning/15 text-warning-ink',
    rechazado: 'bg-negative/15 text-negative-ink',
  };
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${styles[estado] || 'bg-foreground/5 text-muted-foreground'}`}>
      {estado}
    </span>
  );
}

function PaymentsModal({
  user,
  onClose,
  onApproved,
  setToast,
}: {
  user: AdminUser;
  onClose: () => void;
  onApproved: () => void;
  setToast: (m: string) => void;
}) {
  const [pagos, setPagos] = useState<Pago[]>([]);
  // El tipo sale de `@/lib/admin-referido` y no se escribe inline: le faltaba `parcial`, que
  // es justo el campo que el backend manda y esta pantalla ignoraba.
  const [referido, setReferido] = useState<ResumenReferido | null>(null);
  const [loading, setLoading] = useState(true);
  // **"No se pudo leer" no es "no hay".** Con el GET caído `pagos` queda en `[]` y la
  // pantalla decía "Sin pagos registrados todavía." sobre un historial que no se pudo
  // consultar — el mismo colapso que este modal acaba de arreglar para el contexto de
  // referido, dos líneas más abajo, y el que `routes/admin.js` convirtió en 500 a propósito
  // ("una lista vacía por caída se lee igual que este usuario nunca pagó"). El toast es
  // transitorio y el botón de aprobar se pinta igual, porque `hasPending` sale de la fila
  // del usuario y no del fetch: el admin podía aprobar sin historial y sin aviso de
  // referido, creyendo que los había visto.
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planSel, setPlanSel] = useState<string>(user.tipo_plan || 'mensual');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErrorCarga(null);
      const res = await fetch(`/api/admin/payments?user_id=${user.id}`);
      if (res.ok) {
        const json = await res.json();
        setPagos(json.pagos || []);
        setReferido(json.referido || null);
      } else {
        const json = await res.json().catch(() => ({}));
        const msg = json.error || 'Error cargando pagos';
        setErrorCarga(msg);
        setToast(msg);
      }
      setLoading(false);
    })();
  }, [user.id, setToast]);

  const hasPending = user.pago_pendiente || pagos.some((p) => p.estado === 'pendiente');
  const avisos = avisosReferido(referido);

  const approve = async () => {
    setBusy(true);
    const res = await fetch('/api/admin/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.id, tipo_plan: planSel }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && json.ok) {
      setToast('Pro activado y usuario notificado por WhatsApp');
      onApproved();
      onClose();
    } else {
      setToast(json.error || 'Error aprobando pago');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <div
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface-elevated p-5 shadow-xl shadow-scrim/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-foreground">Pagos de {etiquetaUsuario(user)}</h3>
            <p className="text-xs text-muted-foreground">
              {ESTADO_LABEL[estadoComercial(user)]}
              {estadoComercial(user) === 'pro_pagado' && user.premium_vence
                ? ` · vence ${formatDate(user.premium_vence)}`
                : ''}
              {user.cuenta_borrada_at
                ? ` · pidió la baja el ${formatDate(user.cuenta_borrada_at)}`
                : ''}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
            &#10005;
          </button>
        </div>

        {/*
          La condición de render vivía acá y era `descuentoPct > 0 || referrerNombre`, que es
          exactamente FALSA cuando la lectura del contexto de referido falló: el default de
          `resumenReferidoParaAdmin` (0% y sin referrer) es idéntico al de un usuario sin
          referido. O sea que la pantalla donde se aprueba el pago no mostraba nada justo
          cuando había algo que decir. Ahora decide `avisosReferido`, que es una función pura
          con su test — los tests de la webapp corren sin jsdom, así que una decisión adentro
          del JSX sólo se puede vigilar con un guard de forma, y un guard de forma no ve qué
          se muestra cuando algo falla.
        */}
        {avisos.length > 0 && (
          <div className="mb-4 space-y-1 rounded-xl border border-primary/20 bg-primary/[0.06] p-3 text-xs text-foreground-soft">
            {avisos.map((a, i) => (
              <div key={i} className={a.tono === 'advertencia' ? 'font-medium text-warning-ink' : undefined}>
                {a.tono === 'advertencia' ? '\u26A0\uFE0F ' : '\u2022 '}{a.texto}
              </div>
            ))}
          </div>
        )}

        {hasPending && (
          <div className="mb-4 rounded-xl border border-warning/20 bg-warning/[0.06] p-3">
            <div className="mb-2 text-sm font-medium text-warning-ink">Pago pendiente de aprobación</div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={planSel}
                onChange={(e) => setPlanSel(e.target.value)}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="mensual" className="bg-surface-elevated">Mensual (S/{PRO_PRICE_MONTHLY_PEN})</option>
                <option value="anual" className="bg-surface-elevated">Anual (S/{PRO_PRICE_YEARLY_PEN})</option>
              </select>
              <button
                onClick={approve}
                disabled={busy}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-50"
              >
                {busy ? 'Activando...' : 'Aprobar y notificar'}
              </button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Activa Pro y le manda el WhatsApp de confirmación + link de Gmail.</p>
          </div>
        )}

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Cargando...</div>
        ) : errorCarga ? (
          <div className="py-8 text-center text-sm font-medium text-warning-ink">
            {'\u26A0\uFE0F '}No se pudo leer el historial de pagos. No es que no haya: reintenta antes de aprobar.
          </div>
        ) : pagos.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Sin pagos registrados todavía.</div>
        ) : (
          <div className="space-y-3">
            {pagos.map((p) => (
              <div key={p.id} className="rounded-xl border border-border bg-foreground/[0.02] p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PagoEstadoBadge estado={p.estado} />
                    <span className="text-sm font-medium">
                      {p.monto != null ? `S/ ${Number(p.monto).toFixed(2)}` : '—'}
                    </span>
                    <span className="text-xs text-muted-foreground">{p.tipo_plan || '—'} · {p.metodo_pago || '—'}</span>
                    {p.origen && (
                      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs font-medium ${p.origen === 'webapp' ? 'bg-primary/15 text-primary-ink' : 'bg-warning/15 text-warning-ink'}`}>
                        {p.origen === 'webapp' ? 'webapp' : 'whatsapp'}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDateTime(p.created_at)}</span>
                </div>
                {(p.premium_desde || p.premium_vence) && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {p.premium_desde ? `Desde ${formatDate(p.premium_desde)}` : ''}
                    {p.premium_vence ? ` · Vence ${formatDate(p.premium_vence)}` : ''}
                  </div>
                )}
                {p.comprobante_signed_url ? (
                  <a
                    href={p.comprobante_signed_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.comprobante_signed_url}
                      alt="Comprobante de pago"
                      className="max-h-40 rounded-lg border border-border object-contain"
                    />
                  </a>
                ) : (
                  <div className="mt-2 text-xs text-muted-foreground">Sin comprobante adjunto</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed bottom-6 right-6 z-50 rounded-xl border border-border bg-surface-elevated px-4 py-3 text-sm text-foreground shadow-xl shadow-scrim/60">
      {message}
    </div>
  );
}

function OperacionKpiSkeleton() {
  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-foreground/[0.02] p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-foreground/[0.02] p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-5 w-16" />
          </div>
        ))}
      </div>
    </>
  );
}

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export default function AdminOperacionPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'users' | 'feedback' | 'nlp' | 'tickets'>('users');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [paymentsUser, setPaymentsUser] = useState<AdminUser | null>(null);
  const [nlpSearch, setNlpSearch] = useState('');
  const [nlpTipoFilter, setNlpTipoFilter] = useState<string>('all');
  const [nlpUserFilter, setNlpUserFilter] = useState<string>('all');

  const [ticketEstadoFilter, setTicketEstadoFilter] = useState<string>('todos');
  const [ticketSearch, setTicketSearch] = useState('');
  const [ticketPage, setTicketPage] = useState(0);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);

  // Responder un feedback/queja del tab NLP. Estado propio y no el de tickets: son dos tablas
  // distintas, y compartir `replyingTo` haria que abrir uno cerrara el otro.
  const [nlpReplyTo, setNlpReplyTo] = useState<string | null>(null);
  const [nlpReplyText, setNlpReplyText] = useState('');
  const [nlpReplyBusy, setNlpReplyBusy] = useState(false);

  const [userPlanFilter, setUserPlanFilter] = useState<string>('todos');
  const [userOnboardingFilter, setUserOnboardingFilter] = useState<string>('todos');
  const [userGmailFilter, setUserGmailFilter] = useState<string>('todos');
  const [userWebappFilter, setUserWebappFilter] = useState<string>('todos');
  const [userCanalFilter, setUserCanalFilter] = useState<string>('todos');
  const [userPage, setUserPage] = useState(0);

  // Data via React Query (cache compartido del AdminQueryProvider): sobrevive a la navegación,
  // sin re-fetch en cada visita. Las mutaciones invalidan keys puntuales en vez de refetchear a
  // mano. Ver use-admin-operacion.ts.
  const usersQuery = useAdminUsers();
  const statsQuery = useAdminStats();
  const nlpQuery = useAdminNlpErrors();
  const ticketsQuery = useAdminTickets({
    page: ticketPage,
    estado: ticketEstadoFilter,
    search: ticketSearch,
  });

  // useMemo: `users` alimenta las deps de handleUserAction (useCallback); sin ref estable se
  // recrearía en cada render.
  const users = useMemo(() => usersQuery.data?.usuarios ?? [], [usersQuery.data?.usuarios]);
  const stats = statsQuery.data ?? null;
  const nlpErrors = nlpQuery.data?.errors ?? [];
  // Feedback y queja son PERSONAS esperando respuesta; el resto es diagnóstico. Estaban
  // mezclados en un solo tab llamado "NLP Errors", así que una sugerencia de un usuario se
  // leía como un error del parser y no se le contestaba a nadie. Misma lectura, dos vistas.
  const nlpDeGente = nlpErrors.filter((e) => ESPERAN_RESPUESTA.has(e.error_tipo));
  const nlpDeMaquina = nlpErrors.filter((e) => !ESPERAN_RESPUESTA.has(e.error_tipo));
  const nlpTotal = nlpQuery.data?.total ?? 0;
  const nlpRateLimit = nlpQuery.data?.rateLimitTotal ?? 0;
  const tickets = ticketsQuery.data?.tickets ?? [];
  const ticketsTotal = ticketsQuery.data?.total ?? 0;

  /**
   * F8 — los `?? []` y `?? 0` de arriba se quedan, pero ya no deciden solos qué se ve.
   *
   * Con el default puesto y sin mirar `isError`, una caída de la API pintaba `S/—` de MRR
   * y *"No hay errores NLP registrados aun"*: exactamente lo que se ve cuando todo está
   * bien y no hay nada que mostrar. En un panel que se abre para saber si el negocio está
   * vivo, "cero" y "no pude preguntar" son respuestas opuestas.
   *
   * La condición es `isError && <sin data cacheada>`, no `isError` a secas: React Query
   * conserva la respuesta anterior mientras reintenta, y tapar una tabla que el admin está
   * mirando por un refetch fallido es peor que el fallo (eso fue F15). Con data en mano el
   * panel sigue mostrándola y el reintento corre por debajo.
   */
  const usersFallo = usersQuery.isError && users.length === 0;
  const statsFallo = statsQuery.isError && !stats;
  const nlpFallo = nlpQuery.isError && nlpErrors.length === 0;
  const ticketsFallo = ticketsQuery.isError && tickets.length === 0;

  const handleUserAction = useCallback(
    async (userId: string, action: string, data?: Record<string, unknown>) => {
      if (action === 'view_payments') {
        const u = users.find((x) => x.id === userId);
        if (u) setPaymentsUser(u);
        return;
      }

      if (action === 'notify_pro') {
        const res = await fetch('/api/admin/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, tipo_plan: data?.tipo_plan || 'mensual' }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.ok) {
          setToast('Pro confirmado y WhatsApp enviado');
          queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
        } else {
          setToast(json.error || 'Error notificando');
        }
        return;
      }

      if (action === 'delete') {
        const doDelete = async (force: boolean) =>
          fetch(`/api/admin/users?id=${userId}${force ? '&force=1' : ''}`, { method: 'DELETE' });

        let res = await doDelete(false);
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          // Pagador protegido: pedir confirmación y reintentar forzado.
          if (res.status === 409 && json.requiresForce) {
            const u = users.find((x) => x.id === userId);
            if (!window.confirm(`${etiquetaUsuario(u)} tiene un pago aprobado. ¿Borrarlo igual? Se pierde su historial de pagos.`)) {
              return;
            }
            res = await doDelete(true);
          } else {
            setToast(json.message || json.error || 'Error al eliminar');
            return;
          }
        }
        if (res.ok) {
          queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
          setToast('Usuario eliminado');
        } else {
          const json = await res.json().catch(() => ({}));
          setToast(json.message || json.error || 'Error al eliminar');
        }
        return;
      }

      const res = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, action, ...data }),
      });

      if (res.ok) {
        const messages: Record<string, string> = {
          set_plan: data?.plan === 'premium' ? 'Plan Pro activado' : 'Cambiado a Free',
          extend_premium: 'Pro extendido +30 dias',
          deactivate: 'Cuenta desactivada',
        };
        setToast(messages[action] || 'Accion completada');
        queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      } else {
        setToast('Error en la accion');
      }
    },
    [queryClient, users],
  );

  const filteredUsers = users.filter((u) => {
    if (search) {
      const s = search.toLowerCase();
      const matches =
        (u.nombre && u.nombre.toLowerCase().includes(s)) ||
        (u.email && u.email.toLowerCase().includes(s)) ||
        (u.whatsapp && u.whatsapp.includes(s)) ||
        u.plan.includes(s);
      if (!matches) return false;
    }
    // El filtro tenía el mismo bug que la etiqueta y no lo vi hasta que lo delató el guard:
    // "Pro" traía a los ~30 que prueban (durante el trial `plan` vale 'premium') y "Free"
    // no traía a ninguno de ellos, así que las dos opciones mentían a la vez sobre la misma
    // población. Ahora cada opción significa lo que dice.
    const estadoU = estadoComercial(u);
    if (userPlanFilter === 'pro' && estadoU !== 'pro_pagado') return false;
    // La cortesía tiene filtro propio. Sin él quedaba visible solo en "Todos": no es Pro
    // pagado, no está en prueba y no está en el muro, así que los tres filtros la escondían
    // — justo la población que se quiere revisar de vez en cuando para ver a quién se le
    // regaló Pro y hasta cuándo.
    if (userPlanFilter === 'cortesia' && estadoU !== 'pro_cortesia') return false;
    if (userPlanFilter === 'trial' && estadoU !== 'trial') return false;
    if (userPlanFilter === 'muro' && !estadoU.startsWith('muro') && estadoU !== 'sin_estrenar') return false;
    if (userOnboardingFilter === 'completado' && !u.onboarding_completado) return false;
    if (userOnboardingFilter === 'pendiente' && u.onboarding_completado) return false;
    if (userGmailFilter === 'conectado' && !u.tiene_gmail) return false;
    if (userGmailFilter === 'no conectado' && u.tiene_gmail) return false;
    if (userWebappFilter === 'conectado' && !u.tiene_webapp) return false;
    if (userWebappFilter === 'no conectado' && u.tiene_webapp) return false;
    if (userCanalFilter !== 'todos' && u.canal !== userCanalFilter) return false;
    return true;
  });

  const USERS_PAGE_SIZE = 25;
  const totalUserPages = Math.max(1, Math.ceil(filteredUsers.length / USERS_PAGE_SIZE));
  const pagedUsers = filteredUsers.slice(
    userPage * USERS_PAGE_SIZE,
    userPage * USERS_PAGE_SIZE + USERS_PAGE_SIZE,
  );

  // Volver a la primera página cuando cambian filtros o búsqueda (evita quedar en página vacía).
  useEffect(() => {
    setUserPage(0);
  }, [search, userPlanFilter, userOnboardingFilter, userGmailFilter, userWebappFilter, userCanalFilter]);

  // Este export tenía su propio CSV a mano y le hacía `.replace()` a cada celda, así que un
  // usuario web-first (whatsapp NULL, y hay dos en prod) reventaba con TypeError y la descarga
  // no salía: no fallaba la columna, fallaba el archivo entero (F5). `toCsv` escapa null-safe
  // en un solo sitio, que es donde tiene que vivir esa regla.
  const handleExportCSV = () => {
    const headers = ['nombre', 'email', 'whatsapp', 'plan', 'estado_pago', 'tiene_gmail', 'tiene_webapp', 'transacciones', 'created_at'];
    const rows = filteredUsers.map((u) => [
      u.nombre,
      u.email,
      u.whatsapp,
      u.plan,
      u.estado_pago,
      u.tiene_gmail ? 'si' : 'no',
      u.tiene_webapp ? 'si' : 'no',
      u.transacciones,
      u.created_at,
    ]);
    downloadCsv(`neto-usuarios-${new Date().toISOString().split('T')[0]}.csv`, toCsv(headers, rows));
  };

  const handleTicketReply = async (ticketId: string) => {
    if (!replyText.trim()) return;
    setReplyBusy(true);
    const res = await fetch('/api/admin/tickets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ticketId, action: 'respond', respuesta: replyText.trim() }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setToast(json.msg || 'Respuesta enviada');
      setReplyingTo(null);
      setReplyText('');
      queryClient.invalidateQueries({ queryKey: ['admin', 'tickets'] });
    } else {
      // El motivo del backend, no un "Error al responder" generico. La causa mas comun es la
      // ventana de 24h de Meta, y esa distincion decide que hacer: esperar a que escriba, no
      // reintentar. El panel la tiraba.
      setToast(json.error || 'Error al responder');
    }
    setReplyBusy(false);
  };

  /**
   * Responde un feedback o una queja. Aca no hay ticket que responder: esas dos cosas viven en
   * `nlp_errors`, asi que el envio va por /api/admin/nlp-errors y el backend decide si ademas
   * abre la conversacion (ver contactarUsuario en lib/support-tickets).
   */
  // El nombre lo pasa el llamador: `whatsappToName` se arma dentro del IIFE de cada tab.
  const handleNlpReply = async (err: NlpError, nombre: string | null) => {
    if (!nlpReplyText.trim() || !err.whatsapp) return;
    setNlpReplyBusy(true);
    const res = await fetch('/api/admin/nlp-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        whatsapp: err.whatsapp,
        mensaje: nlpReplyText.trim(),
        usuario_id: err.usuario_id,
        nombre,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setToast(json.msg || 'Mensaje enviado');
      setNlpReplyTo(null);
      setNlpReplyText('');
      // La respuesta crea el ticket SIEMPRE, así que el listado de tickets siempre cambia.
      queryClient.invalidateQueries({ queryKey: ['admin', 'tickets'] });
    } else {
      setToast(json.error || 'No se pudo enviar');
    }
    setNlpReplyBusy(false);
  };

  const handleTicketEstado = async (ticketId: string, estado: string) => {
    const res = await fetch('/api/admin/tickets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ticketId, action: 'set_estado', estado }),
    });
    if (res.ok) {
      setToast(`Estado cambiado a ${estado}`);
      queryClient.invalidateQueries({ queryKey: ['admin', 'tickets'] });
    } else {
      setToast('Error al cambiar estado');
    }
  };

  /**
   * Los agregados derivados de `users` viven en el bloque de KPIs, que está gateado por
   * `statsFallo` — o sea por la OTRA query. Si `/api/admin/users` se cae y `/stats`
   * responde, el bloque se pinta entero con estos números en cero: "Total Usuarios: 0",
   * "0 txs total", "Canales Webapp: 0". Y el `ErrorState` de usuarios sólo aparece si el
   * admin está parado en el tab de usuarios, así que desde NLP o Tickets el fallo es
   * invisible mientras la pantalla afirma que no hay nadie.
   *
   * `null` (y no 0) es lo que dice "no lo sé", y `numeroKpi` lo pinta como raya.
   */
  const numeroKpi = (n: number) => (usersFallo ? '—' : n.toLocaleString('es-PE'));
  // Contaba `plan === 'premium'` crudo: ~30 "Pro" donde hay 2 pagadores, o sea la cifra
  // inflada 15x en la tarjeta de MRR. Y excluye bajas declaradas, igual que /admin/users —
  // sin eso contaba cuentas borradas que el MRR de la misma pantalla ya descuenta.
  const totalPro = usersFallo
    ? null
    : users.filter((u) => !u.cuenta_borrada_at && estadoComercial(u) === 'pro_pagado').length;
  const totalWebapp = users.filter((u) => u.tiene_webapp).length;
  const totalTx = users.reduce((s, u) => s + u.transacciones, 0);

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-foreground">Operación</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Usuarios, KPIs, embudo de onboarding, errores NLP y tickets de soporte.
        </p>
      </div>

      {statsQuery.isLoading ? (
        <OperacionKpiSkeleton />
      ) : statsFallo ? (
        <div className="mb-6">
          <ErrorState
            titulo="No pudimos cargar los KPIs"
            variante="card"
            descripcion="El MRR, el MAU y el embudo no se pudieron leer. No es que estén en cero."
            onReintentar={() => statsQuery.refetch()}
          />
        </div>
      ) : (
        <>
      {/* KPI Cards — Row 1: Core metrics */}
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="glass-card rounded-xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">MRR</span>
            <span className="text-xs text-muted-foreground" title="Ingreso anual recurrente">
              ARR S/{(stats?.kpis.arr ?? 0).toLocaleString('es-PE')}
            </span>
          </div>
          <div className="mt-1 text-2xl font-semibold text-primary">
            S/{stats?.kpis.mrr ?? '—'}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>{stats?.kpis.proReal ?? totalPro ?? '—'} Pro</span>
            <span className="text-muted-foreground">·</span>
            <span>{stats?.kpis.proYearly ?? 0} anual</span>
            <span>{stats?.kpis.proMonthly ?? 0} mensual</span>
            {/* Sin esto, el MRR de esta pantalla baja S/18 sin ninguna explicación al lado y
                se lee como un bug del panel. La misma nota vive pegada al KPI de MRR en
                /admin/economics; acá faltaba, que es donde se mira todos los días. */}
            {(stats?.kpis.bajasDeclaradas ?? 0) > 0 && (
              <span className="text-negative">
                {stats!.kpis.bajasDeclaradas} de baja sin contar
              </span>
            )}
          </div>
        </div>
        {/* El detalle de este número (quién pagó) vive en /admin/pagos. */}
        <Link
          href="/admin/pagos"
          className="glass-card block rounded-xl p-4 transition-colors hover:border-primary/35"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-2">
            <span className="whitespace-nowrap text-xs text-muted-foreground">Caja del mes</span>
            <span className="whitespace-nowrap text-xs text-primary">Ver pagos →</span>
          </div>
          <div className="mt-1 text-2xl font-semibold text-foreground">
            S/{stats?.kpis.cajaMes ?? '—'}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Conversion {stats?.kpis.conversionRate ?? 0}% · {stats?.kpis.proReal ?? totalPro ?? '—'} de {numeroKpi(users.length)}
          </div>
        </Link>
        <div className="glass-card rounded-xl p-4">
          <div className="text-xs text-muted-foreground">Usuarios Activos</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold">{stats?.kpis.mau ?? '—'}</span>
            <span className="text-xs text-muted-foreground">MAU</span>
          </div>
          <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
            <span>WAU: {stats?.kpis.wau ?? '—'}</span>
            <span>DAU: {stats?.kpis.dau ?? '—'}</span>
          </div>
        </div>
        <div className="glass-card rounded-xl p-4">
          <div className="text-xs text-muted-foreground">Txs / Usuario Activo</div>
          <div className="mt-1 text-2xl font-semibold">{stats?.kpis.txPerActiveUser ?? '—'}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{numeroKpi(totalTx)} txs total</div>
        </div>
      </div>

      {/* KPI Cards — Row 2: Secondary metrics */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="glass-card rounded-xl p-3">
          <div className="text-xs text-muted-foreground">Churn Rate</div>
          <div className={`mt-1 text-lg font-semibold ${(stats?.kpis.churnRate ?? 0) > 10 ? 'text-negative' : 'text-foreground'}`}>
            {stats?.kpis.churnRate ?? '—'}%
          </div>
        </div>
        <div className="glass-card rounded-xl p-3">
          <div className="text-xs text-muted-foreground">Avg 1a Transaccion</div>
          <div className="mt-1 text-lg font-semibold">
            {stats?.kpis.avgTimeToFirstTx ?? '—'} <span className="text-xs font-normal text-muted-foreground">dias</span>
          </div>
        </div>
        <div className="glass-card rounded-xl p-3">
          <div className="text-xs text-muted-foreground">Canales Webapp</div>
          <div className="mt-1 text-lg font-semibold">{numeroKpi(totalWebapp)}</div>
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span>Google: {numeroKpi(users.filter(u => u.canal === 'google').length)}</span>
            <span>ML: {numeroKpi(users.filter(u => u.canal === 'magic_link').length)}</span>
          </div>
        </div>
        <div className="glass-card rounded-xl p-3">
          <div className="text-xs text-muted-foreground">Total Usuarios</div>
          <div className="mt-1 text-lg font-semibold">{numeroKpi(users.length)}</div>
          <div className="text-xs text-muted-foreground">Onboarding: {stats?.funnel.onboardingComplete ?? '—'}</div>
        </div>
      </div>

      {/* Charts Section */}
      {stats && (
        <div className="mb-6 grid gap-4 lg:grid-cols-3">
          <div className="glass-card rounded-xl p-4">
            <h3 className="mb-3 text-sm font-medium text-foreground">Crecimiento Usuarios (12 semanas)</h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.userGrowth} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="gradFree" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--foreground)" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="var(--foreground)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradPro" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--foreground) 5%, transparent)" />
                  <XAxis dataKey="week" tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip itemStyle={{ color: 'var(--foreground)' }}
                    contentStyle={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--foreground)' }}
                  />
                  <Area type="monotone" dataKey="free" stackId="1" stroke="var(--muted-foreground)" fill="url(#gradFree)" name="Free" />
                  <Area type="monotone" dataKey="pro" stackId="1" stroke="var(--primary)" fill="url(#gradPro)" name="Pro" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="glass-card rounded-xl p-4">
            <h3 className="mb-3 text-sm font-medium text-foreground">Embudo de Onboarding</h3>
            <div className="space-y-2.5">
              {[
                { label: 'Registrados', value: stats.funnel.registered, color: 'var(--foreground)' },
                { label: 'Onboarding OK', value: stats.funnel.onboardingComplete, color: 'var(--warning)' },
                { label: '1a Transaccion', value: stats.funnel.firstTransaction, color: 'var(--negative)' },
                { label: 'Pro', value: stats.funnel.pro, color: 'var(--primary)' },
              ].map((step) => {
                const pct = stats.funnel.registered > 0 ? Math.round((step.value / stats.funnel.registered) * 100) : 0;
                return (
                  <div key={step.label}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{step.label}</span>
                      <span className="font-mono text-foreground-soft">{step.value} <span className="text-muted-foreground">({pct}%)</span></span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-foreground/5">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${pct}%`, backgroundColor: step.color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Webapp: métrica transversal (no downstream de 1a tx), fuera del embudo. */}
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs">
              <span className="text-muted-foreground">Cobertura webapp (Google + ML)</span>
              <span className="font-mono text-chart-5">
                {stats.webappCoverage}
                <span className="text-muted-foreground">
                  {' '}({stats.funnel.registered > 0 ? Math.round((stats.webappCoverage / stats.funnel.registered) * 100) : 0}%)
                </span>
              </span>
            </div>
          </div>

          <div className="glass-card rounded-xl p-4">
            <h3 className="mb-3 text-sm font-medium text-foreground">Errores NLP (30 dias)</h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats.nlpActivity} margin={{ top: 4, right: 12, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--foreground) 5%, transparent)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    interval={6}
                  />
                  <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip itemStyle={{ color: 'var(--foreground)' }}
                    contentStyle={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--foreground)' }}
                  />
                  <Line type="monotone" dataKey="errors" stroke="var(--negative)" strokeWidth={1.5} dot={false} name="Errores" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
        </>
      )}

      {/* Tabs: en celular no entran las cuatro y la página se arrastraba de costado. */}
      <div className="mb-4 overflow-x-auto">
        <div className="flex w-max gap-1 rounded-lg bg-foreground/[0.03] p-1">
          <button
            onClick={() => setTab('users')}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'users'
                ? 'bg-primary/20 text-primary-ink'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Usuarios ({usersFallo ? '—' : users.length})
          </button>
          <button
            onClick={() => setTab('feedback')}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'feedback'
                ? 'bg-primary/20 text-primary-ink'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Feedback ({nlpFallo ? '—' : nlpDeGente.length})
          </button>
          <button
            onClick={() => setTab('nlp')}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'nlp'
                ? 'bg-primary/20 text-primary-ink'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {/* El contador del tab también miente en el fallo: "NLP Errors (0)" se lee como
                "no hay ninguno". Con la lectura caída no hay número que dar. */}
            Errores NLP ({nlpFallo ? '—' : nlpDeMaquina.length})
          </button>
          <button
            onClick={() => setTab('tickets')}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'tickets'
                ? 'bg-primary/20 text-primary-ink'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Tickets (
            {ticketsFallo
              ? '—'
              : tickets.filter((t) => t.estado === 'pendiente' || t.estado === 'esperando_mensaje').length}
            )
          </button>
        </div>
      </div>

      {/* Users Tab */}
      {tab === 'users' && usersFallo && (
        <ErrorState
          titulo="No pudimos cargar los usuarios"
          variante="card"
          descripcion="La lista no se pudo leer. No significa que no haya usuarios."
          onReintentar={() => usersQuery.refetch()}
        />
      )}

      {tab === 'users' && !usersFallo && (
        <>
          <div className="mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                placeholder="Buscar por nombre, email o WhatsApp..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="form-input w-full max-w-md px-4 py-2.5 text-sm"
              />
              <button
                onClick={handleExportCSV}
                className="rounded-lg border border-border bg-foreground/[0.03] px-4 py-2.5 text-sm text-foreground-soft hover:bg-foreground/5 hover:text-foreground transition-colors"
              >
                Exportar CSV
              </button>
            </div>
            <div className="flex flex-wrap gap-3">
              <select
                value={userPlanFilter}
                onChange={(e) => setUserPlanFilter(e.target.value)}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="todos" className="bg-surface-elevated">Estado: Todos</option>
                <option value="pro" className="bg-surface-elevated">Pro pagado</option>
                <option value="cortesia" className="bg-surface-elevated">Pro cortesía</option>
                <option value="trial" className="bg-surface-elevated">En prueba</option>
                <option value="muro" className="bg-surface-elevated">En el muro</option>
              </select>
              <select
                value={userOnboardingFilter}
                onChange={(e) => setUserOnboardingFilter(e.target.value)}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="todos" className="bg-surface-elevated">Onboarding: Todos</option>
                <option value="completado" className="bg-surface-elevated">Completado</option>
                <option value="pendiente" className="bg-surface-elevated">Pendiente</option>
              </select>
              <select
                value={userGmailFilter}
                onChange={(e) => setUserGmailFilter(e.target.value)}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="todos" className="bg-surface-elevated">Gmail: Todos</option>
                <option value="conectado" className="bg-surface-elevated">Conectado</option>
                <option value="no conectado" className="bg-surface-elevated">No conectado</option>
              </select>
              <select
                value={userWebappFilter}
                onChange={(e) => setUserWebappFilter(e.target.value)}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="todos" className="bg-surface-elevated">Webapp: Todos</option>
                <option value="conectado" className="bg-surface-elevated">Conectado</option>
                <option value="no conectado" className="bg-surface-elevated">No conectado</option>
              </select>
              <select
                value={userCanalFilter}
                onChange={(e) => setUserCanalFilter(e.target.value)}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="todos" className="bg-surface-elevated">Canal: Todos</option>
                <option value="whatsapp" className="bg-surface-elevated">Solo WhatsApp</option>
                <option value="google" className="bg-surface-elevated">Google OAuth</option>
                <option value="magic_link" className="bg-surface-elevated">Magic Link</option>
              </select>
              {(userPlanFilter !== 'todos' || userOnboardingFilter !== 'todos' || userGmailFilter !== 'todos' || userWebappFilter !== 'todos' || userCanalFilter !== 'todos') && (
                <button
                  onClick={() => { setUserPlanFilter('todos'); setUserOnboardingFilter('todos'); setUserGmailFilter('todos'); setUserWebappFilter('todos'); setUserCanalFilter('todos'); }}
                  className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                >
                  Limpiar filtros
                </button>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {filteredUsers.length} de {users.length} usuarios
              {filteredUsers.length > USERS_PAGE_SIZE && (
                <>
                  {' · mostrando '}
                  {userPage * USERS_PAGE_SIZE + 1}–
                  {Math.min(filteredUsers.length, (userPage + 1) * USERS_PAGE_SIZE)}
                </>
              )}
            </div>
          </div>

          {/* Desktop table */}
          <div className="hidden glass-card md:block overflow-hidden">
            <div className="max-h-[65dvh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Usuario</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">WhatsApp</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Plan</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Pago</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground">Gmail</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground">Webapp</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground">Txs</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Canal</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Registro</th>
                  <th className="w-10 px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {usersQuery.isLoading && users.length === 0 &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={`sk-${i}`}>
                      <td colSpan={10} className="px-4 py-3">
                        <Skeleton className="h-8 w-full" />
                      </td>
                    </tr>
                  ))}
                {pagedUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-foreground/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium">{u.nombre || 'Sin nombre'}</div>
                      <div className="text-xs text-muted-foreground">{u.email || '—'}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{u.whatsapp}</td>
                    <td className="px-4 py-3">
                      <PlanBadge estado={estadoComercial(u)} bajaAt={u.cuenta_borrada_at} />
                      {/* El tipo de plan es del que PAGA: "Anual" sobre una prueba no significa nada. */}
                      {estadoComercial(u) === 'pro_pagado' && (
                        <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
                          {u.tipo_plan === 'anual' ? 'Anual' : 'Mensual'}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {estadoComercial(u) === 'pro_pagado' ? (
                        <div>
                          <div>{u.fecha_pago ? `Pagó ${formatDate(u.fecha_pago)}` : (u.estado_pago || '—')}</div>
                          {u.premium_vence && (() => {
                            const daysLeft = Math.ceil((new Date(u.premium_vence).getTime() - Date.now()) / 86400000);
                            return (
                              <div className={daysLeft <= 7 ? 'text-negative font-medium' : 'text-muted-foreground'}>
                                {daysLeft <= 0 ? 'Vencido' : daysLeft <= 7 ? `Vence en ${daysLeft}d` : `Vence: ${formatDate(u.premium_vence)}`}
                              </div>
                            );
                          })()}
                        </div>
                      ) : u.pago_pendiente ? (
                        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning-ink">Pendiente</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-center"><StatusDot active={u.tiene_gmail} warn={u.gmail_caido} title={gmailTitle(u)} /></td>
                    <td className="px-4 py-3 text-center"><StatusDot active={u.tiene_webapp} /></td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{u.transacciones}</td>
                    <td className="px-4 py-3"><CanalBadge canal={u.canal} /></td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(u.created_at)}</td>
                    <td className="px-2 py-3"><UserActions user={u} onAction={handleUserAction} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {usersQuery.isLoading && users.length === 0 && <ListSkeleton rows={4} />}
            {pagedUsers.map((u) => (
              <div key={u.id} className="glass-card rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{u.nombre || 'Sin nombre'}</div>
                    <div className="text-xs text-muted-foreground wrap-anywhere">{u.email || '—'}</div>
                  </div>
                  {/* `shrink-0` + el `min-w-0` de al lado: con la pastilla en una línea, el email
                      largo no podía encoger y empujaba el ⋮ fuera de la pantalla. */}
                  <div className="flex shrink-0 items-center gap-2">
                    <PlanBadge estado={estadoComercial(u)} bajaAt={u.cuenta_borrada_at} />
                    <UserActions user={u} onAction={handleUserAction} />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-muted-foreground">WhatsApp:</span> <span className="font-mono">{u.whatsapp}</span></div>
                  <div><span className="text-muted-foreground">Txs:</span> {u.transacciones}</div>
                  <div className="flex items-center gap-1.5"><StatusDot active={u.tiene_gmail} warn={u.gmail_caido} title={gmailTitle(u)} /><span className="text-muted-foreground">Gmail</span></div>
                  <div className="flex items-center gap-1.5"><StatusDot active={u.tiene_webapp} /><span className="text-muted-foreground">Webapp</span></div>
                  <div className="flex items-center gap-1.5"><CanalBadge canal={u.canal} /></div>
                  {estadoComercial(u) === 'pro_pagado' && u.premium_vence && (() => {
                    const daysLeft = Math.ceil((new Date(u.premium_vence).getTime() - Date.now()) / 86400000);
                    return (
                      <div className={`col-span-2 ${daysLeft <= 7 ? 'text-negative font-medium' : ''}`}>
                        <span className="text-muted-foreground">Vence:</span>{' '}
                        {daysLeft <= 0 ? 'Vencido' : daysLeft <= 7 ? `en ${daysLeft} dias` : formatDate(u.premium_vence)}
                      </div>
                    );
                  })()}
                  <div className="col-span-2 text-muted-foreground">Registro: {formatDateTime(u.created_at)}</div>
                </div>
              </div>
            ))}
          </div>

          {totalUserPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={() => setUserPage(Math.max(0, userPage - 1))}
                disabled={userPage === 0}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-30"
              >
                Anterior
              </button>
              <span className="text-xs text-muted-foreground">
                Página {userPage + 1} de {totalUserPages}
              </span>
              <button
                onClick={() => setUserPage(Math.min(totalUserPages - 1, userPage + 1))}
                disabled={userPage >= totalUserPages - 1}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-30"
              >
                Siguiente
              </button>
            </div>
          )}
        </>
      )}

      {/* NLP Errors Tab */}
      {(tab === 'nlp' || tab === 'feedback') && (() => {
        // El MISMO bloque para los dos tabs, cambiando la lista de origen. Duplicarlo era
        // duplicar los filtros, el estado vacío y el manejo de la lectura caída — y que uno
        // de los dos se quedara atrás en el siguiente cambio.
        const esFeedback = tab === 'feedback';
        const origen = esFeedback ? nlpDeGente : nlpDeMaquina;
        const tiposUnicos = [...new Set(origen.map((e) => e.error_tipo))];
        const usersUnicos = [...new Set(origen.filter((e) => e.whatsapp).map((e) => e.whatsapp!))];

        const whatsappToName: Record<string, string> = {};
        for (const u of users) {
          if (u.whatsapp) whatsappToName[u.whatsapp] = u.nombre || u.whatsapp;
        }

        const filtered = origen.filter((err) => {
          if (nlpTipoFilter !== 'all' && err.error_tipo !== nlpTipoFilter) return false;
          if (nlpUserFilter !== 'all' && err.whatsapp !== nlpUserFilter) return false;
          if (nlpSearch) {
            const s = nlpSearch.toLowerCase();
            const matchMsg = err.mensaje.toLowerCase().includes(s);
            const matchIntent = err.intencion?.toLowerCase().includes(s);
            const matchDetail = err.error_detalle?.toLowerCase().includes(s);
            const matchWhatsapp = err.whatsapp?.includes(s);
            if (!matchMsg && !matchIntent && !matchDetail && !matchWhatsapp) return false;
          }
          return true;
        });

        return (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                placeholder="Buscar en mensajes..."
                value={nlpSearch}
                onChange={(e) => setNlpSearch(e.target.value)}
                className="form-input w-full max-w-xs px-4 py-2 text-sm"
              />
              <select
                value={nlpTipoFilter}
                onChange={(e) => setNlpTipoFilter(e.target.value)}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="all" className="bg-surface-elevated">Todos los tipos</option>
                {tiposUnicos.map((t) => (
                  <option key={t} value={t} className="bg-surface-elevated">{t}</option>
                ))}
              </select>
              <select
                value={nlpUserFilter}
                onChange={(e) => setNlpUserFilter(e.target.value)}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="all" className="bg-surface-elevated">Todos los usuarios</option>
                {usersUnicos.map((w) => (
                  <option key={w} value={w} className="bg-surface-elevated">{whatsappToName[w] || w}</option>
                ))}
              </select>
              {(nlpSearch || nlpTipoFilter !== 'all' || nlpUserFilter !== 'all') && (
                <button
                  onClick={() => { setNlpSearch(''); setNlpTipoFilter('all'); setNlpUserFilter('all'); }}
                  className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                >
                  Limpiar filtros
                </button>
              )}
            </div>

            {/* Este contador quedaba FUERA del ternario de abajo, así que con la lectura
                caída imprimía "0 de 0 errores NLP reales" justo encima del ErrorState que
                dice que falló: la página se contradecía en dos líneas seguidas. */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {nlpFallo ? (
                <span>No se pudo leer el conteo de {esFeedback ? 'los mensajes' : 'errores NLP'}</span>
              ) : (
                <span>{filtered.length} de {origen.length} {esFeedback ? 'mensajes de usuarios' : 'errores NLP reales'}</span>
              )}
              {/* El rate-limit es infra del parser: no tiene nada que hacer en Feedback. */}
              {!nlpFallo && !esFeedback && nlpRateLimit > 0 && (
                <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-muted-foreground" title="Errores 429 de OpenAI (saturación de tokens). Es infra, no NLP. Se muestran aparte.">
                  + {nlpRateLimit} rate-limit (infra, oculto)
                </span>
              )}
            </div>

            {/* Agregados de DIAGNÓSTICO. "Top 5 mensajes que fallan" sobre sugerencias de
                usuarios no significa nada: no fallan, son lo que la gente escribió. */}
            {!esFeedback && origen.length > 0 && nlpTipoFilter === 'all' && nlpUserFilter === 'all' && !nlpSearch && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="glass-card rounded-xl p-4">
                  <h4 className="mb-2 text-xs font-medium text-muted-foreground">Top 5 mensajes que fallan</h4>
                  {(() => {
                    const msgCounts: Record<string, number> = {};
                    for (const err of nlpErrors) {
                      const key = err.mensaje.toLowerCase().trim().slice(0, 80);
                      msgCounts[key] = (msgCounts[key] || 0) + 1;
                    }
                    const sorted = Object.entries(msgCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
                    const maxCount = sorted[0]?.[1] || 1;
                    return (
                      <div className="space-y-2">
                        {sorted.map(([msg, count]) => (
                          <div key={msg}>
                            <div className="flex items-center justify-between text-xs">
                              <span className="max-w-[200px] truncate text-muted-foreground">&ldquo;{msg}&rdquo;</span>
                              <span className="font-mono text-muted-foreground">{count}x</span>
                            </div>
                            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-foreground/5">
                              <div className="h-full rounded-full bg-negative/60" style={{ width: `${(count / maxCount) * 100}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                <div className="glass-card rounded-xl p-4">
                  <h4 className="mb-2 text-xs font-medium text-muted-foreground">Errores por tipo</h4>
                  {(() => {
                    const tipoCounts: Record<string, number> = {};
                    for (const err of nlpErrors) {
                      tipoCounts[err.error_tipo] = (tipoCounts[err.error_tipo] || 0) + 1;
                    }
                    return (
                      <div className="space-y-2">
                        {Object.entries(tipoCounts).sort((a, b) => b[1] - a[1]).map(([tipo, count]) => (
                          <div key={tipo} className="flex items-center justify-between text-xs">
                            <span className={`rounded-full px-2 py-0.5 ${
                              tipo === 'error' ? 'bg-negative/10 text-negative-ink' : 'bg-warning/10 text-warning-ink'
                            }`}>{tipo}</span>
                            <span className="font-mono text-muted-foreground">{count}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {nlpQuery.isLoading ? (
              <ListSkeleton rows={6} />
            ) : nlpFallo ? (
              <ErrorState
                titulo="No pudimos cargar los errores NLP"
                variante="card"
                descripcion="La lectura falló. Es distinto de que no haya errores registrados."
                onReintentar={() => nlpQuery.refetch()}
              />
            ) : filtered.length === 0 ? (
              <div className="glass-card rounded-xl p-8 text-center text-muted-foreground">
                {origen.length === 0
                  ? (esFeedback ? 'Todavía nadie dejó feedback ni una queja.' : 'No hay errores NLP registrados aun.')
                  : (esFeedback ? 'Ningún mensaje coincide con los filtros.' : 'Ningun error coincide con los filtros.')}
                <br />
                <span className="text-xs">
                  {esFeedback
                    ? 'Aparecen acá cuando alguien escribe una sugerencia o un reclamo por WhatsApp.'
                    : 'Los mensajes no procesados apareceran aqui cuando ocurran.'}
                </span>
              </div>
            ) : (
              filtered.map((err) => (
                <div key={err.id} className="glass-card rounded-xl p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="rounded-lg bg-foreground/[0.03] px-3 py-2 text-sm">&ldquo;{err.mensaje}&rdquo;</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <span className={`rounded-full px-2 py-0.5 ${
                          err.error_tipo === 'error' ? 'bg-negative/10 text-negative-ink' : 'bg-warning/10 text-warning-ink'
                        }`}>{err.error_tipo}</span>
                        {err.intencion && (
                          <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-muted-foreground">Intento: {err.intencion}</span>
                        )}
                        {err.whatsapp && (
                          <button
                            onClick={() => setNlpUserFilter(err.whatsapp!)}
                            className="font-mono text-muted-foreground hover:text-primary transition-colors"
                            title="Filtrar por este usuario"
                          >
                            {whatsappToName[err.whatsapp] || err.whatsapp}
                          </button>
                        )}
                      </div>
                      {err.error_detalle && (
                        <div className="mt-1 text-xs text-muted-foreground">{err.error_detalle}</div>
                      )}

                      {/* Solo lo que ESPERA respuesta. Un rate-limit o un "desconocido" son
                          diagnostico, no alguien escribiendo: un boton de responder ahi invita a
                          contestarle a quien no pregunto nada. */}
                      {ESPERAN_RESPUESTA.has(err.error_tipo) && err.whatsapp && (
                        <div className="mt-3 border-t border-border pt-3">
                          {nlpReplyTo === err.id ? (
                            <div className="space-y-2">
                              <textarea
                                value={nlpReplyText}
                                onChange={(e) => setNlpReplyText(e.target.value)}
                                placeholder="Tu respuesta. Le llega por WhatsApp como Neto."
                                rows={3}
                                className="form-input w-full px-3 py-2 text-xs"
                                autoFocus
                              />
                              {/* El checkbox murió: el ticket se crea siempre (es el registro),
                                  y la escucha se cierra sola por inactividad. */}
                              <p className="text-xs text-muted-foreground">
                                Le llega por WhatsApp como Neto y queda guardado en el hilo. Lo que conteste en las
                                próximas 2 horas te vuelve acá; después su asistente sigue normal.
                              </p>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleNlpReply(err, whatsappToName[err.whatsapp!] || null)}
                                  disabled={nlpReplyBusy || !nlpReplyText.trim()}
                                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-50 transition-colors"
                                >
                                  {nlpReplyBusy ? '...' : 'Enviar'}
                                </button>
                                <button
                                  onClick={() => setNlpReplyTo(null)}
                                  className="rounded-lg bg-foreground/5 px-3 py-1.5 text-xs text-muted-foreground hover:bg-foreground/10 transition-colors"
                                >
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setNlpReplyTo(err.id); setNlpReplyText(''); }}
                              className="rounded-lg bg-foreground/5 px-3 py-1.5 text-xs text-foreground-soft hover:bg-foreground/10 transition-colors"
                            >
                              Responder como Neto
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="ml-3 whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(err.created_at)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        );
      })()}

      {/* Tickets Tab */}
      {tab === 'tickets' && (() => {
        const ticketsPendientes = tickets.filter((t) => t.estado === 'pendiente' || t.estado === 'esperando_mensaje').length;
        const totalPages = Math.ceil(ticketsTotal / 50);

        const estadoBadge = (estado: string) => {
          const styles: Record<string, string> = {
            esperando_mensaje: 'bg-warning/10 text-warning-ink',
            pendiente: 'bg-warning/10 text-warning-ink',
            respondido: 'bg-primary/10 text-primary-ink',
            cerrado: 'bg-foreground/5 text-muted-foreground',
          };
          const labels: Record<string, string> = {
            esperando_mensaje: 'Esperando',
            pendiente: 'Pendiente',
            respondido: 'Respondido',
            cerrado: 'Cerrado',
          };
          return (
            <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${styles[estado] || 'bg-foreground/5 text-muted-foreground'}`}>
              {labels[estado] || estado}
            </span>
          );
        };

        const whatsappToName: Record<string, string> = {};
        for (const u of users) {
          if (u.whatsapp) whatsappToName[u.whatsapp] = u.nombre || u.whatsapp;
        }

        return (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                placeholder="Buscar en mensajes o WhatsApp..."
                value={ticketSearch}
                onChange={(e) => { setTicketSearch(e.target.value); setTicketPage(0); }}
                className="form-input w-full max-w-xs px-4 py-2 text-sm"
              />
              <select
                value={ticketEstadoFilter}
                onChange={(e) => { setTicketEstadoFilter(e.target.value); setTicketPage(0); }}
                className="form-input px-3 py-2 text-sm"
              >
                <option value="todos" className="bg-surface-elevated">Todos los estados</option>
                <option value="esperando_mensaje" className="bg-surface-elevated">Esperando mensaje</option>
                <option value="pendiente" className="bg-surface-elevated">Pendiente</option>
                <option value="respondido" className="bg-surface-elevated">Respondido</option>
                <option value="cerrado" className="bg-surface-elevated">Cerrado</option>
              </select>
              {(ticketSearch || ticketEstadoFilter !== 'todos') && (
                <button
                  onClick={() => { setTicketSearch(''); setTicketEstadoFilter('todos'); setTicketPage(0); }}
                  className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                >
                  Limpiar filtros
                </button>
              )}
            </div>

            <div className="text-xs text-muted-foreground">
              {ticketsFallo ? (
                'No se pudo leer el conteo de tickets'
              ) : (
                <>
                  {ticketsTotal} tickets total
                  {ticketsPendientes > 0 && ` (${ticketsPendientes} pendientes)`}
                </>
              )}
            </div>

            {ticketsQuery.isLoading ? (
              <ListSkeleton rows={6} />
            ) : ticketsFallo ? (
              <ErrorState
                titulo="No pudimos cargar los tickets"
                variante="card"
                descripcion="La lectura falló. Puede haber gente esperando respuesta."
                onReintentar={() => ticketsQuery.refetch()}
              />
            ) : tickets.length === 0 ? (
              <div className="glass-card rounded-xl p-8 text-center text-muted-foreground">
                No hay tickets de soporte.
              </div>
            ) : (
              <>
                <div className="hidden overflow-x-auto glass-card md:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-foreground/[0.02]">
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Usuario</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">WhatsApp</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Mensaje</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Estado</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Fecha</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {tickets.map((t) => (
                        <tr key={t.id} className="hover:bg-foreground/[0.02] transition-colors">
                          <td className="px-4 py-3 text-sm">
                            {t.whatsapp ? (whatsappToName[t.whatsapp] || 'Sin nombre') : '—'}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">{t.whatsapp || '—'}</td>
                          <td className="max-w-xs px-4 py-3">
                            <div className="truncate text-sm">{t.mensaje_usuario || <span className="text-muted-foreground">(sin mensaje aún)</span>}</div>
                            {t.mensaje_admin && (
                              <div className="mt-1 truncate text-xs text-primary/70">Respuesta: {t.mensaje_admin}</div>
                            )}
                          </td>
                          <td className="px-4 py-3">{estadoBadge(t.estado)}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(t.created_at)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              {t.estado !== 'cerrado' && (
                                <button
                                  onClick={() => { setReplyingTo(replyingTo === t.id ? null : t.id); setReplyText(''); }}
                                  className="rounded-md px-2 py-1 text-xs text-primary-ink hover:bg-primary/10 transition-colors"
                                >
                                  Responder
                                </button>
                              )}
                              {t.estado !== 'cerrado' && (
                                <button
                                  onClick={() => handleTicketEstado(t.id, 'cerrado')}
                                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5 transition-colors"
                                >
                                  Cerrar
                                </button>
                              )}
                            </div>
                            {replyingTo === t.id && (
                              <div className="mt-2 border-t border-border pt-2">
                                <HiloTicket ticketId={t.id} />
                              </div>
                            )}
                            {replyingTo === t.id && (
                              <div className="mt-2 flex gap-2">
                                <input
                                  type="text"
                                  value={replyText}
                                  onChange={(e) => setReplyText(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') handleTicketReply(t.id); }}
                                  placeholder="Escribir respuesta..."
                                  className="form-input flex-1 px-3 py-1.5 text-xs"
                                  autoFocus
                                />
                                <button
                                  onClick={() => handleTicketReply(t.id)}
                                  disabled={replyBusy || !replyText.trim()}
                                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-50 transition-colors"
                                >
                                  {replyBusy ? '...' : 'Enviar'}
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-3 md:hidden">
                  {tickets.map((t) => (
                    <div key={t.id} className="glass-card rounded-xl p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="text-sm font-medium">{t.whatsapp ? (whatsappToName[t.whatsapp] || t.whatsapp) : 'Sin usuario'}</div>
                          <div className="mt-1 text-sm text-foreground-soft">{t.mensaje_usuario || <span className="text-muted-foreground">(sin mensaje aún)</span>}</div>
                          {t.mensaje_admin && (
                            <div className="mt-1 text-xs text-primary/70">Respuesta: {t.mensaje_admin}</div>
                          )}
                        </div>
                        <div className="ml-2">{estadoBadge(t.estado)}</div>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                        <span>{formatDateTime(t.created_at)}</span>
                        <div className="flex gap-2">
                          {t.estado !== 'cerrado' && (
                            <button
                              onClick={() => { setReplyingTo(replyingTo === t.id ? null : t.id); setReplyText(''); }}
                              className="text-primary hover:text-primary/80"
                            >
                              Responder
                            </button>
                          )}
                          {t.estado !== 'cerrado' && (
                            <button
                              onClick={() => handleTicketEstado(t.id, 'cerrado')}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              Cerrar
                            </button>
                          )}
                        </div>
                      </div>
                      {replyingTo === t.id && (
                        <div className="mt-2 border-t border-border pt-2">
                          <HiloTicket ticketId={t.id} />
                        </div>
                      )}
                      {replyingTo === t.id && (
                        <div className="mt-2 flex gap-2">
                          <input
                            type="text"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleTicketReply(t.id); }}
                            placeholder="Escribir respuesta..."
                            className="form-input flex-1 px-3 py-1.5 text-xs"
                            autoFocus
                          />
                          <button
                            onClick={() => handleTicketReply(t.id)}
                            disabled={replyBusy || !replyText.trim()}
                            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-50"
                          >
                            {replyBusy ? '...' : 'Enviar'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 pt-2">
                    <button
                      onClick={() => setTicketPage(Math.max(0, ticketPage - 1))}
                      disabled={ticketPage === 0}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-foreground/5 disabled:opacity-30"
                    >
                      Anterior
                    </button>
                    <span className="text-xs text-muted-foreground">
                      Pagina {ticketPage + 1} de {totalPages}
                    </span>
                    <button
                      onClick={() => setTicketPage(Math.min(totalPages - 1, ticketPage + 1))}
                      disabled={ticketPage >= totalPages - 1}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-foreground/5 disabled:opacity-30"
                    >
                      Siguiente
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

      {paymentsUser && (
        <PaymentsModal
          user={paymentsUser}
          onClose={() => setPaymentsUser(null)}
          onApproved={() => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })}
          setToast={setToast}
        />
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </>
  );
}
