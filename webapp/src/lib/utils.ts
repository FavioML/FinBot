import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Currency formatting
//
// Acepta null/undefined/NaN y devuelve "S/ —" en vez de reventar: `monto_pen`
// es una columna NULLABLE y un `null.toLocaleString()` acá tiraba el dashboard
// completo al error boundary. El guion es el piso de seguridad, no el display
// deseado — para una transacción usa `formatTxMonto()` (tx-monto.ts), que sabe
// caer al monto original con su moneda.
export function formatCurrency(amount: number | null | undefined, currency: string = 'PEN'): string {
  const symbol = currency === 'USD' ? '$' : 'S/';
  if (amount == null || !Number.isFinite(amount)) return `${symbol} —`;
  return `${symbol} ${amount.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Date formatting in Spanish
export function formatFecha(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  const mesesCortos = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${date.getDate()} ${mesesCortos[date.getMonth()]} ${date.getFullYear()}`;
}

// Escala del Neto Score: la MISMA en toda la webapp y en el bot (services/neto-score.js usa
// estas cuatro etiquetas por WhatsApp). Antes había una de 3 tramos acá y otra de 4 en el gauge
// y en kpi-cards, y un 50 salía ámbar en un sitio y "Atención" en otro.
export function getScoreColor(score: number): string {
  if (score >= 80) return 'var(--positive)';
  if (score >= 60) return 'var(--info)';
  if (score >= 40) return 'var(--warning)';
  return 'var(--negative)';
}

export function getScoreLabel(score: number): string {
  if (score >= 80) return 'Excelente';
  if (score >= 60) return 'En camino';
  if (score >= 40) return 'Puede mejorar';
  return 'Atención';
}

// Percentage with sign
export function formatPorcentaje(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}
