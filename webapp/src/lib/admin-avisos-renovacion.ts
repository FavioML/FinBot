import type { AdminAvisoEntrega, AdminRenovacion } from '@/lib/types-admin';

/**
 * El bloque de Renovaciones de /admin/pagos: ¿le llegó a cada cliente el aviso de vencimiento?
 *
 * Los avisos salen solos desde `cron/checks.js` (3 días antes, el día que vence y al día siguiente,
 * cuando el plan baja), por WhatsApp, la campana y, desde el 30-sep-2026 (`6bedcb8`), por correo.
 * Cada envío deja una fila en `notification_deliveries` por canal. Esto las lee y marca SOLO lo
 * que pide atención: nadie tiene que escribirle a mano a nadie.
 *
 * El WhatsApp de estos avisos es texto libre y no llega fuera de la ventana de 24h de Meta
 * (131047): al 30-sep, 0 de 20 entregados en toda la historia. Por eso un WhatsApp fallido NO es
 * excepción (es lo esperado) y el correo sí: es el canal que de verdad llega.
 *
 * **Un aviso se juzga recién el día siguiente al que le tocaba.** `checkPremiumExpiry` corre cada
 * hora sin `alBoot` (`cron/schedule.js`), así que su fase depende de cuándo arrancó el proceso: un
 * deploy a las 8:10 corre el aviso a las 9:10, y en la base hay avisos del día que salieron a las
 * 13:29. Cualquier hora de corte dentro del día daba "no salió" falsos (revisión del 30-sep).
 *
 * Límite conocido: el cron manda el aviso de 3 días solo si ese día el vencimiento ya era el
 * mismo. Un vencimiento fijado con menos de 3 días de margen nunca lo recibe y acá saldría "no
 * salió". Hoy no ocurre con pagadores: aprobar un pago corre el vencimiento un mes o un año.
 */

export const TIPOS_AVISO = ['premium_expiry_3d', 'premium_expiry_hoy', 'premium_expired'] as const;

/**
 * `mismoDia`: el cron manda ese aviso solo el día exacto (`premium_vence = hoy + 3` o `= hoy`), así
 * que una fila de otro día es de otro vencimiento, p. ej. el de antes de que el admin extendiera el
 * plan. El de plan vencido sale cuando el cron baja el plan (`premium_vence < hoy`), que puede
 * reintentarse días después si el downgrade falla: vale desde su fecha en adelante.
 */
export const AVISOS: readonly {
  tipo: AdminAvisoEntrega['tipo'];
  etiqueta: string;
  nombre: string;
  desfase: number;
  mismoDia: boolean;
}[] = [
  { tipo: 'premium_expiry_3d', etiqueta: '3 días antes', nombre: 'aviso de 3 días', desfase: -3, mismoDia: true },
  { tipo: 'premium_expiry_hoy', etiqueta: 'El día que vence', nombre: 'aviso del día que vence', desfase: 0, mismoDia: true },
  { tipo: 'premium_expired', etiqueta: 'Al vencer', nombre: 'aviso de plan vencido', desfase: 1, mismoDia: false },
];

/**
 * Primer día completo con correo en producción. Un aviso anterior se muestra como historia, sin
 * excepciones: entonces solo existía WhatsApp, y marcar hoy lo que ya no tiene arreglo es ruido.
 */
export const MONITOR_DESDE = '2026-10-01';

/**
 * Resend confirma la entrega en segundos. Un correo aceptado que pasadas 24h sigue sin
 * `delivered_at` ni `failed_at` es un correo perdido o un webhook caído (`routes/public.js`), y
 * sin este plazo quedaba en "enviado" para siempre con el panel en verde.
 */
export const HORAS_SIN_CONFIRMAR = 24;

export type Tono = 'ok' | 'neutro' | 'alerta';
export interface EstadoCanal {
  texto: string;
  tono: Tono;
}
export type EstadoAviso = 'futuro' | 'pendiente' | 'salio' | 'no_salio';
export interface AvisoMonitor {
  tipo: AdminAvisoEntrega['tipo'];
  etiqueta: string;
  nombre: string;
  fecha: string; // 'YYYY-MM-DD', día en que le toca salir
  estado: EstadoAviso;
  historia: boolean; // anterior a MONITOR_DESDE: se muestra, no se juzga
  whatsapp: EstadoCanal | null;
  correo: EstadoCanal | null;
}
export interface MonitorRenovacion {
  avisos: AvisoMonitor[];
  excepciones: string[];
}

/** 'YYYY-MM-DD' + n días, en calendario (sin horas ni zona). */
export function sumarDias(fecha: string, n: number): string {
  const [y, m, d] = fecha.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** El día calendario de Lima de un instante, 'YYYY-MM-DD'. */
export function fechaLima(instante: Date | string): string {
  return new Date(instante).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

/**
 * Desde cuándo se leen las entregas de un vencimiento: las 00:00 de Lima (UTC-5, sin horario de
 * verano) del día del aviso de 3 días. Lo anterior es de un ciclo previo.
 */
export function inicioVentanaEntregas(premiumVence: string): string {
  return new Date(`${sumarDias(premiumVence, -3)}T00:00:00-05:00`).toISOString();
}

function iso(t: string | null): string | null {
  return t == null ? null : new Date(t).toISOString();
}

/**
 * Le pega a cada persona SUS entregas desde su ventana, y si apagó los recordatorios. Vive acá y no
 * en la ruta para poder probarlo sin Supabase: el oráculo de `qa-admin-panel` no puede ver una
 * ventana corrida o un `recordatorios_activos` fijo mientras los datos de producción no lo ejerciten.
 */
export function adjuntarEntregas<R extends Pick<AdminRenovacion, 'usuario_id' | 'premium_vence'>>(
  filas: R[],
  entregas: (AdminAvisoEntrega & { usuario_id: string })[],
  recordatorios: Map<string, boolean>,
): (R & Pick<AdminRenovacion, 'recordatorios_activos' | 'entregas'>)[] {
  return filas.map((r) => {
    const desde = new Date(inicioVentanaEntregas(r.premium_vence)).getTime();
    return {
      ...r,
      // Sin fila en `usuarios` (no debería pasar: la RPC sale de ahí) se espera el correo, que es
      // el lado que termina en una excepción visible y no en un silencio.
      recordatorios_activos: recordatorios.get(r.usuario_id) ?? true,
      entregas: entregas
        .filter((e) => e.usuario_id === r.usuario_id && new Date(e.created_at).getTime() >= desde)
        .map((e) => ({
          tipo: e.tipo,
          canal: e.canal,
          estado: e.estado,
          // En ISO con milisegundos y Z: PostgREST manda 5-6 decimales y `+00:00`, que V8 lee
          // bien pero que no se le deja al navegador (un `Invalid Date` descartaría toda fila).
          created_at: iso(e.created_at)!,
          delivered_at: iso(e.delivered_at),
          failed_at: iso(e.failed_at),
          read_at: iso(e.read_at),
          fail_code: e.fail_code,
          error: e.error,
        })),
    };
  });
}

/** 'YYYY-MM-DD' → '03/07'. */
export function diaMes(fecha: string): string {
  const [, m, d] = fecha.slice(0, 10).split('-');
  return `${d}/${m}`;
}

/** "vence hoy", "vence mañana", "vence en 4 días", "venció ayer", "venció hace 40 días". */
export function etiquetaPlazo(r: Pick<AdminRenovacion, 'dias'>): string {
  if (r.dias === 0) return 'vence hoy';
  if (r.dias === 1) return 'vence mañana';
  if (r.dias > 1) return `vence en ${r.dias} días`;
  if (r.dias === -1) return 'venció ayer';
  return `venció hace ${-r.dias} días`;
}

const MOTIVO_SKIP_CORREO: Record<string, string> = {
  skipped_no_email: 'no salió: sin correo',
  skipped_tope_diario: 'no salió: tope diario de correos',
  skipped_sin_proveedor: 'no salió: el canal de correo está apagado',
  skipped_sin_baja: 'no salió: falta el link de baja',
};

export function estadoCorreo(e: AdminAvisoEntrega, ahora: Date): EstadoCanal {
  if (e.estado === 'sent') {
    if (e.failed_at) return { texto: e.error === 'complained' ? 'lo marcó como spam' : 'rebotó', tono: 'alerta' };
    if (e.read_at) return { texto: 'abierto', tono: 'ok' };
    if (e.delivered_at) return { texto: 'entregado', tono: 'ok' };
    const horas = (ahora.getTime() - new Date(e.created_at).getTime()) / 3_600_000;
    if (horas >= HORAS_SIN_CONFIRMAR) return { texto: `sigue sin confirmar después de ${HORAS_SIN_CONFIRMAR}h`, tono: 'alerta' };
    return { texto: 'enviado, sin confirmar', tono: 'neutro' };
  }
  if (e.estado === 'error') return { texto: 'falló al enviarse', tono: 'alerta' };
  return { texto: MOTIVO_SKIP_CORREO[e.estado] ?? `no salió (${e.estado})`, tono: 'alerta' };
}

export function estadoWhatsapp(e: AdminAvisoEntrega): EstadoCanal {
  if (e.estado === 'sent') {
    if (e.read_at) return { texto: 'leído', tono: 'ok' };
    if (e.delivered_at) return { texto: 'entregado', tono: 'ok' };
    if (e.failed_at) {
      return { texto: e.fail_code === 131047 ? 'fuera de la ventana de 24h' : `falló (${e.fail_code ?? 'sin código'})`, tono: 'neutro' };
    }
    return { texto: 'enviado, sin confirmar', tono: 'neutro' };
  }
  if (e.estado === 'skipped_no_whatsapp') return { texto: 'no tiene', tono: 'neutro' };
  if (e.estado === 'error') return { texto: 'falló al enviarse', tono: 'neutro' };
  return { texto: e.estado, tono: 'neutro' };
}

/**
 * La fila más reciente de ese aviso por ese canal, en el día que le corresponde (ver `mismoDia`).
 * Las de fixtures (`skipped_test`) no cuentan en ningún canal.
 */
function ultima(
  entregas: AdminAvisoEntrega[],
  aviso: (typeof AVISOS)[number],
  fecha: string,
  canal: AdminAvisoEntrega['canal'],
): AdminAvisoEntrega | null {
  let mejor: AdminAvisoEntrega | null = null;
  for (const e of entregas) {
    if (e.tipo !== aviso.tipo || e.canal !== canal || e.estado === 'skipped_test') continue;
    const dia = fechaLima(e.created_at);
    if (aviso.mismoDia ? dia !== fecha : dia < fecha) continue;
    if (!mejor || e.created_at > mejor.created_at) mejor = e;
  }
  return mejor;
}

export function monitorRenovacion(
  r: Pick<AdminRenovacion, 'premium_vence' | 'email_web' | 'recordatorios_activos' | 'entregas'>,
  ahora: Date,
): MonitorRenovacion {
  const hoy = fechaLima(ahora);
  const correoEsperado = !!r.email_web && r.recordatorios_activos !== false;

  const avisos: AvisoMonitor[] = AVISOS.map((a) => {
    const fecha = sumarDias(r.premium_vence, a.desfase);
    const wa = ultima(r.entregas, a, fecha, 'whatsapp');
    const correo = ultima(r.entregas, a, fecha, 'email');
    const estado: EstadoAviso =
      wa || correo ? 'salio' : fecha > hoy ? 'futuro' : fecha === hoy ? 'pendiente' : 'no_salio';
    return {
      tipo: a.tipo,
      etiqueta: a.etiqueta,
      nombre: a.nombre,
      fecha,
      estado,
      historia: fecha < MONITOR_DESDE,
      whatsapp: wa ? estadoWhatsapp(wa) : null,
      correo: correo ? estadoCorreo(correo, ahora) : null,
    };
  });

  const excepciones: string[] = [];
  const vigentes = avisos.filter((a) => !a.historia);
  if (vigentes.length > 0) {
    if (!r.email_web) {
      // Sin cuenta web tampoco hay campana: lo único que se intenta es el WhatsApp.
      excepciones.push(
        'Sin correo probado (no tiene cuenta web): el aviso solo sale por WhatsApp, que no llega si no escribió en las últimas 24h.',
      );
    } else if (r.recordatorios_activos === false) {
      excepciones.push('Apagó los recordatorios: los avisos no le llegan por correo.');
    }
  }
  for (const a of vigentes) {
    const cual = `${a.nombre} (${diaMes(a.fecha)})`;
    if (a.estado === 'no_salio') {
      excepciones.push(`No salió el ${cual}.`);
    } else if (a.estado === 'salio' && correoEsperado) {
      if (!a.correo) excepciones.push(`El ${cual} salió sin correo.`);
      else if (a.correo.tono === 'alerta') excepciones.push(`El correo del ${cual} ${a.correo.texto}.`);
    }
  }
  return { avisos, excepciones };
}
