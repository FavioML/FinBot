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

// Score financiero — fórmula oficial NETO
// Base 75, +15 si ratio ≤0.7, +5 si ≤1.0, -20 si >1.0, -8 por presupuesto excedido
export function calcularScoreFinanciero(gastos: number, ingresos: number, presupuestosExcedidos: number = 0): number {
  let score = 75;
  if (ingresos > 0) {
    const ratio = gastos / ingresos;
    if (ratio <= 0.7) score += 15;
    else if (ratio <= 1.0) score += 5;
    else score -= 20;
  }
  score -= presupuestosExcedidos * 8;
  return Math.max(0, Math.min(100, score));
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
