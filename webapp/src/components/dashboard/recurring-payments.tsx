'use client';

import { useMemo } from 'react';
import { Repeat, Calendar } from 'lucide-react';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import { SUBSCRIPTION_PATTERNS } from '@/lib/subscriptions-catalog';
import type { Transaccion } from '@/lib/types';

interface RecurringPaymentsProps {
  transactions: Transaccion[];
}

interface RecurringPayment {
  comercio: string;
  categoria: string;
  avgAmount: number;
  monthsDetected: number;
  lastDate: string;
  dayOfMonth: number;
  nextExpected: string;
}

export function RecurringPayments({ transactions }: RecurringPaymentsProps) {
  const recurring = useMemo<RecurringPayment[]>(() => {
    const gastos = transactions.filter(
      (t) => t.tipo === 'gasto' && t.comercio && t.comercio.trim() !== ''
    );

    // Group by comercio + similar amount (within 20%)
    const byComercio = new Map<string, Transaccion[]>();
    for (const t of gastos) {
      const key = t.comercio!.toLowerCase().trim();
      const list = byComercio.get(key) || [];
      list.push(t);
      byComercio.set(key, list);
    }

    // Build a set of all subscription pattern keywords to exclude
    const subPatterns = SUBSCRIPTION_PATTERNS.flatMap((s) => s.patrones.map((p) => p.toLowerCase()));

    const results: RecurringPayment[] = [];

    for (const [key, txs] of byComercio) {
      if (txs.length < 2) continue;

      // Skip if this comercio matches a known subscription pattern
      if (subPatterns.some((p) => key.includes(p))) continue;

      // Check if amounts are consistent (within 20% of median)
      const amounts = txs.map((t) => t.monto_pen).sort((a, b) => a - b);
      const median = amounts[Math.floor(amounts.length / 2)];
      const consistent = amounts.every(
        (a) => Math.abs(a - median) / median < 0.2
      );
      if (!consistent) continue;

      // Check if payments span multiple months
      const months = new Set(
        txs.map((t) => {
          const d = new Date(t.fecha + 'T00:00:00');
          return `${d.getFullYear()}-${d.getMonth()}`;
        })
      );
      if (months.size < 2) continue;

      // Detect approximate day of month
      const days = txs.map((t) => new Date(t.fecha + 'T00:00:00').getDate());
      const avgDay = Math.round(days.reduce((s, d) => s + d, 0) / days.length);

      // Compute next expected date
      const lastTx = txs.sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
      const lastDate = new Date(lastTx.fecha + 'T00:00:00');
      const nextMonth = new Date(lastDate);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      nextMonth.setDate(Math.min(avgDay, new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate()));

      results.push({
        comercio: lastTx.comercio!,
        categoria: lastTx.categoria,
        avgAmount: amounts.reduce((s, a) => s + a, 0) / amounts.length,
        monthsDetected: months.size,
        lastDate: lastTx.fecha,
        dayOfMonth: avgDay,
        nextExpected: nextMonth.toISOString().slice(0, 10),
      });
    }

    return results.sort((a, b) => b.avgAmount - a.avgAmount).slice(0, 6);
  }, [transactions]);

  if (recurring.length === 0) return null;

  const totalMonthly = recurring.reduce((s, r) => s + r.avgAmount, 0);

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.35 }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-[#8A877D]" />
          <h3 className="text-sm font-medium md:text-base md:font-semibold text-[#C8C6BC]">Pagos recurrentes</h3>
        </div>
        <span className="text-xs text-[#8A877D]">~{formatCurrency(totalMonthly)}/mes</span>
      </div>

      <div className="space-y-2">
        {recurring.map((r) => {
          const nextDate = new Date(r.nextExpected + 'T12:00:00');
          const today = new Date();
          const daysUntil = Math.ceil((nextDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          const isPast = daysUntil < 0;
          const isSoon = daysUntil >= 0 && daysUntil <= 5;

          return (
            <div
              key={r.comercio}
              className="flex items-center justify-between rounded-lg px-3 py-2 -mx-1 hover:bg-[rgba(255,255,255,0.03)] transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-[#F0EFE8] truncate">{r.comercio}</p>
                  <span className="shrink-0 rounded bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 text-[9px] text-[#8A877D]">
                    {r.monthsDetected} meses
                  </span>
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <Calendar className="h-2.5 w-2.5 text-[#8A877D]" />
                  <span
                    className="text-[10px]"
                    style={{
                      color: isPast ? '#D85A30' : isSoon ? '#EF9F27' : '#8A877D',
                    }}
                  >
                    {isPast
                      ? `Esperado hace ${Math.abs(daysUntil)} dias`
                      : daysUntil === 0
                      ? 'Hoy'
                      : `En ${daysUntil} dias (~dia ${r.dayOfMonth})`}
                  </span>
                </div>
              </div>
              <span className="text-sm font-medium text-[#D85A30] tabular-nums shrink-0 ml-3">
                {formatCurrency(r.avgAmount)}
              </span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
