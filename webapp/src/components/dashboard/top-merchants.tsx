'use client';

import { useMemo } from 'react';
import { Store } from 'lucide-react';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import { montoPen } from '@/lib/tx-monto';
import { getCategoriaEmoji } from '@/lib/constants';
import type { Transaccion } from '@/lib/types';

interface TopMerchantsProps {
  transactions: Transaccion[];
  onMerchantClick?: (name: string) => void;
}

export function TopMerchants({ transactions, onMerchantClick }: TopMerchantsProps) {
  const merchants = useMemo(() => {
    const gastos = transactions.filter(
      (t) => t.tipo === 'gasto' && t.comercio && t.comercio.trim() !== ''
    );

    const map = new Map<string, { total: number; count: number; categoria: string }>();
    for (const t of gastos) {
      const key = t.comercio!.toLowerCase().trim();
      const prev = map.get(key) || { total: 0, count: 0, categoria: t.categoria };
      prev.total += montoPen(t);
      prev.count += 1;
      map.set(key, prev);
    }

    return Array.from(map.entries())
      .map(([, data]) => data)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  }, [transactions]);

  // Los tres `useMemo` van ANTES de cualquier `return`. El corte por lista vacía estaba en
  // el medio, así que el primer render (sin transacciones todavía) ejecutaba UN hook y el
  // siguiente TRES: React #310, "rendered more hooks than during the previous render", que
  // tira el árbol al error boundary del dashboard. No es hipotético — con la caché fría, la
  // home pasa siempre por esos dos estados.
  const merchantNames = useMemo(() => {
    const gastos = transactions.filter(
      (t) => t.tipo === 'gasto' && t.comercio && t.comercio.trim() !== ''
    );
    const nameMap = new Map<string, string>();
    for (const t of gastos) {
      const key = t.comercio!.toLowerCase().trim();
      if (!nameMap.has(key)) nameMap.set(key, t.comercio!);
    }
    return nameMap;
  }, [transactions]);

  const orderedNames = useMemo(() => {
    const gastos = transactions.filter(
      (t) => t.tipo === 'gasto' && t.comercio && t.comercio.trim() !== ''
    );
    const map = new Map<string, number>();
    for (const t of gastos) {
      const key = t.comercio!.toLowerCase().trim();
      map.set(key, (map.get(key) || 0) + montoPen(t));
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key]) => key);
  }, [transactions]);

  if (merchants.length === 0) return null;

  const maxTotal = merchants[0]?.total || 1;

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
    >
      <div className="flex items-center gap-2 mb-4">
        <Store className="h-4 w-4 text-[#8A877D]" />
        <h3 className="text-sm font-medium md:text-base md:font-semibold text-[#C8C6BC]">Top comercios</h3>
      </div>

      <div className="space-y-3">
        {orderedNames.map((key, i) => {
          const data = merchants[i];
          if (!data) return null;
          const name = merchantNames.get(key) || key;
          const barPct = (data.total / maxTotal) * 100;

          return (
            <div
              key={key}
              className={`space-y-1 ${onMerchantClick ? 'cursor-pointer rounded-lg px-2 py-1.5 -mx-2 hover:bg-[rgba(255,255,255,0.04)] transition-colors' : ''}`}
              onClick={onMerchantClick ? () => onMerchantClick(name) : undefined}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-xs shrink-0">{getCategoriaEmoji(data.categoria)}</span>
                  <span className="text-sm text-[#F0EFE8] truncate">{name}</span>
                  <span className="text-[10px] text-[#8A877D] shrink-0">{data.count}x</span>
                </div>
                <span className="text-sm font-medium text-[#D85A30] tabular-nums shrink-0 ml-2">
                  {formatCurrency(data.total)}
                </span>
              </div>
              <div className="h-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-[#D85A30]"
                  initial={{ width: 0 }}
                  animate={{ width: `${barPct}%` }}
                  transition={{ duration: 0.6, delay: i * 0.08, ease: [0.25, 0.46, 0.45, 0.94] }}
                  style={{ opacity: 1 - i * 0.12 }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
