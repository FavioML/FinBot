import { hoyPeru } from '@/lib/dates';
import type { Deuda, DeudaAbono, Frecuencia } from '@/lib/hooks/use-debts';

export interface VencBadge {
  label: string;
  color: string;
  bgColor: string;
  /** 0 = vencida, 1 = hoy, 2 = <=3d, 3 = <=7d. Menor = más urgente. */
  priority: number;
}

/** Midnight de hoy en zona Lima, como Date comparable. */
function hoyLimaDate(): Date {
  const d = new Date(hoyPeru() + 'T00:00:00');
  return d;
}

/** Días hasta el vencimiento (negativo si ya venció). null si no aplica. */
export function diasHastaVencimiento(debt: Deuda): number | null {
  if (!debt.fecha_vencimiento || debt.estado === 'pagada') return null;
  const hoy = hoyLimaDate();
  const venc = new Date(debt.fecha_vencimiento + 'T00:00:00');
  return Math.round((venc.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
}

/** Badge de vencimiento (vencida / vence hoy / vence en Nd). null si no urge. */
export function getVencimientoBadge(debt: Deuda): VencBadge | null {
  const diffDays = diasHastaVencimiento(debt);
  if (diffDays === null) return null;
  if (diffDays < 0) return { label: `Vencida hace ${Math.abs(diffDays)}d`, color: '#D85A30', bgColor: 'rgba(216,90,48,0.12)', priority: 0 };
  if (diffDays === 0) return { label: 'Vence hoy', color: '#D85A30', bgColor: 'rgba(216,90,48,0.12)', priority: 1 };
  if (diffDays <= 3) return { label: `Vence en ${diffDays}d`, color: '#EF9F27', bgColor: 'rgba(239,159,39,0.12)', priority: 2 };
  if (diffDays <= 7) return { label: `Vence en ${diffDays}d`, color: '#8A877D', bgColor: 'rgba(138,135,125,0.1)', priority: 3 };
  return null;
}

/** Ordena por urgencia de vencimiento y luego por monto pendiente desc. */
export function sortDebts(debts: Deuda[]): Deuda[] {
  return [...debts].sort((a, b) => {
    const prioA = getVencimientoBadge(a)?.priority ?? 99;
    const prioB = getVencimientoBadge(b)?.priority ?? 99;
    if (prioA !== prioB) return prioA - prioB;
    return Number(b.monto_pendiente) - Number(a.monto_pendiente);
  });
}

/** Ordena abonos del más reciente al más antiguo (la API los devuelve sin orden). */
export function sortAbonos(abonos: DeudaAbono[]): DeudaAbono[] {
  return [...abonos].sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha < b.fecha ? 1 : -1;
    return (a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1;
  });
}

const FRECUENCIA_LABELS: Record<Frecuencia, string> = {
  semanal: 'Semanal',
  quincenal: 'Quincenal',
  mensual: 'Mensual',
  anual: 'Anual',
};

export function frecuenciaLabel(f: Frecuencia | null | undefined): string {
  return f ? FRECUENCIA_LABELS[f] : '';
}

/** Símbolo de moneda de la deuda. */
export function monedaSym(moneda: 'PEN' | 'USD' | string): string {
  return moneda === 'USD' ? '$' : 'S/';
}

/** Monto con símbolo y separador de miles: "S/ 1,500.00". */
export function fmtMoneda(moneda: string, monto: number): string {
  return `${monedaSym(moneda)} ${Number(monto).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "S/ 1,200.00 + $ 50.00" a partir de totales por moneda. */
export function fmtMulti(pen: number, usd: number): string {
  const parts: string[] = [];
  if (pen > 0) parts.push('S/ ' + pen.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  if (usd > 0) parts.push('$ ' + usd.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return parts.length > 0 ? parts.join(' + ') : 'S/ 0.00';
}

/** Fecha corta es-PE: "5 mar". */
export function fechaCorta(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
}

/** Fecha larga es-PE: "5 mar 2026". */
export function fechaLarga(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** % pagado de una deuda (0-100). */
export function pctPagado(debt: Deuda): number {
  const original = Number(debt.monto_original);
  if (original <= 0) return 0;
  const pagado = original - Number(debt.monto_pendiente);
  return Math.min(100, Math.max(0, (pagado / original) * 100));
}
