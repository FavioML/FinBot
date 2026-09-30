import { todayIsoLima } from '@/lib/date-lima';
import type { AdminPagoFila } from '@/lib/types-admin';

/**
 * Lógica de /admin/pagos que no depende del render. Vive acá y no en la página porque los tests
 * de la webapp corren sin jsdom: una decisión dentro del JSX no se puede probar.
 */

// Años 2000-2099: Postgres rechaza el año 0, y un `0000-01` que pasara llegaba como 500.
const MES_RE = /^(20\d{2})-(0[1-9]|1[0-2])$/;

/**
 * El mes pedido por `?mes=`. Sin parámetro es el mes en curso EN LIMA (no el del servidor, que
 * en Vercel corre en UTC y el último día del mes a partir de las 19:00 ya está en el siguiente).
 * Un valor mal formado devuelve null: la ruta responde 400 en vez de mostrar otro mes callada.
 */
export function resolverMes(raw: string | null | undefined, ahora: Date = new Date()): string | null {
  if (raw == null || raw === '') return todayIsoLima(ahora).slice(0, 7);
  return MES_RE.test(raw) ? raw : null;
}

/** 'YYYY-MM' → 'YYYY-MM-01', el parámetro DATE que recibe la RPC. */
export function primerDiaDelMes(mes: string): string {
  return `${mes}-01`;
}

/** 'YYYY-MM-DD' o 'YYYY-MM' → 'YYYY-MM'. */
export function claveMes(fecha: string): string {
  return fecha.slice(0, 7);
}

/**
 * Día Lima de un instante. `cuando.slice(0, 10)` sería el día UTC: un pago de las 21:00 del 30
 * de septiembre en Lima saldría 1 de octubre, dentro de la lista de septiembre.
 */
export function fechaLima(cuando: string): string {
  return todayIsoLima(new Date(cuando));
}

/**
 * 'YYYY-MM' → "Setiembre de 2026" (es-PE escribe "setiembre"). Se formatea desde el día 15 en
 * UTC para no correrse de mes. La mayúscula va acá y no con la clase `capitalize`, que también
 * levanta el "de".
 */
export function etiquetaMes(mes: string): string {
  const [y, m] = claveMes(mes).split('-').map(Number);
  const texto = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('es-PE', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * Cómo se nombra a quien pagó. La cuenta borrada va primero: su fila queda como lápida con
 * nombre y número vaciados (migración 073), y sin este caso la pantalla diría "Sin nombre" sobre
 * un cliente que pagó y se fue, que es otra cosa.
 */
export function etiquetaPagador(
  f: Pick<AdminPagoFila, 'nombre' | 'whatsapp' | 'email' | 'cuenta_borrada'>,
): string {
  if (f.cuenta_borrada) return 'Cuenta eliminada';
  return f.nombre || f.whatsapp || f.email || 'Sin nombre';
}

const PLAN_LABEL: Record<string, string> = { mensual: 'mensual', anual: 'anual' };

/**
 * Primer pago, renovación, cortesía, pendiente o rechazado.
 *
 * `n_pago` lo numera la RPC sobre toda la historia del usuario, así que acá solo se lee. Un
 * aprobado sin número es un aprobado sin plata (cortesía): no es un pago, aunque tenga fila.
 */
export function etiquetaTipoPago(
  f: Pick<AdminPagoFila, 'estado' | 'n_pago' | 'monto' | 'tipo_plan' | 'tipo_plan_anterior'>,
): string {
  if (f.estado === 'pendiente') return 'Pendiente';
  if (f.estado === 'rechazado') return 'Rechazado';
  if (f.estado !== 'aprobado') return f.estado;
  // Sin monto no es un regalo: es un pago cuyo monto no se llegó a escribir (el update que
  // completa la fila después del claim falló). Leerlo como cortesía escondería la plata.
  if (f.n_pago == null) return f.monto == null ? 'Aprobado sin monto registrado' : 'Cortesía';
  if (f.n_pago === 1) return 'Primer pago';
  const cambio =
    f.tipo_plan_anterior && f.tipo_plan && f.tipo_plan_anterior !== f.tipo_plan
      ? ` · antes ${PLAN_LABEL[f.tipo_plan_anterior] ?? f.tipo_plan_anterior}`
      : '';
  return `Renovación (pago n.º ${f.n_pago})${cambio}`;
}

/** "1 pago", "3 pagos". */
export function contar(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * La nota de lo que se listó y no suma ("1 rechazado"). Solo nombra lo que existe: un "0
 * cortesías, 0 pendientes" delante del dato real lo esconde. null si no hay nada que decir.
 */
export function notaNoSuma(r: { n_cortesia: number; n_pendiente: number; n_rechazado: number }): string | null {
  const partes = [
    // `n_cortesia` cuenta todo aprobado SIN PLATA: monto 0 (cortesía) y monto sin registrar. La
    // fila los distingue; la nota no, así que no los llama "cortesías".
    r.n_cortesia > 0 ? contar(r.n_cortesia, 'aprobado sin plata', 'aprobados sin plata') : null,
    r.n_pendiente > 0 ? contar(r.n_pendiente, 'pendiente', 'pendientes') : null,
    r.n_rechazado > 0 ? contar(r.n_rechazado, 'rechazado', 'rechazados') : null,
  ].filter(Boolean);
  return partes.length ? `Además: ${partes.join(', ')}. No suman a la caja.` : null;
}

/** ¿Esta fila suma a la caja del mes? La misma regla que la RPC y que `admin_pnl_monthly`. */
export function sumaALaCaja(f: Pick<AdminPagoFila, 'estado' | 'monto' | 'interno'>): boolean {
  return f.estado === 'aprobado' && f.monto != null && !f.interno;
}

export const CSV_HEADERS = [
  'Fecha',
  'Usuario',
  'WhatsApp',
  'Monto (PEN)',
  'Plan',
  'Tipo',
  'Canal',
  'Cubre hasta',
  'Estado',
  'Suma a la caja',
];

export function filasCsv(pagos: AdminPagoFila[]): unknown[][] {
  return pagos.map((p) => [
    fechaLima(p.cuando),
    etiquetaPagador(p),
    p.cuenta_borrada ? '' : p.whatsapp || '',
    p.monto == null ? '' : Number(p.monto),
    p.tipo_plan || '',
    etiquetaTipoPago(p),
    p.origen || '',
    p.premium_vence || '',
    p.estado,
    sumaALaCaja(p) ? 'sí' : 'no',
  ]);
}
