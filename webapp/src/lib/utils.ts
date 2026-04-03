import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Currency formatting
export function formatCurrency(amount: number, currency: string = 'PEN'): string {
  const symbol = currency === 'USD' ? '$' : 'S/';
  return `${symbol} ${amount.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Date formatting in Spanish
export function formatFecha(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  const mesesCortos = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${date.getDate()} ${mesesCortos[date.getMonth()]} ${date.getFullYear()}`;
}

// Score color
export function getScoreColor(score: number): string {
  if (score >= 80) return '#1D9E75';
  if (score >= 60) return '#EF9F27';
  return '#D85A30';
}

// Score label
export function getScoreLabel(score: number): string {
  if (score >= 80) return 'Excelente';
  if (score >= 60) return 'En camino';
  return 'Atención';
}

// Percentage with sign
export function formatPorcentaje(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}
