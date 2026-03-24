'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { formatCurrency, formatFecha } from '@/lib/utils';
import { getCategoriaEmoji } from '@/lib/constants';
import type { Transaccion } from '@/lib/types';

interface RecentTransactionsProps {
  transactions: Transaccion[];
}

export function RecentTransactions({ transactions }: RecentTransactionsProps) {
  if (transactions.length === 0) {
    return (
      <div className="glass-card p-5 flex items-center justify-center py-12">
        <p className="text-sm text-[#8A877D]">Sin transacciones recientes</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[#C8C6BC]">Transacciones Recientes</h3>
        <Link
          href="/dashboard/transacciones"
          className="inline-flex items-center gap-1 text-xs font-medium text-[#1D9E75] hover:text-[#1D9E75]/80 transition-colors"
        >
          Ver todas
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="space-y-1">
        {transactions.slice(0, 10).map((tx) => {
          const emoji = getCategoriaEmoji(tx.categoria);
          const isIngreso = tx.tipo === 'ingreso';

          return (
            <div
              key={tx.id}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-[rgba(255,255,255,0.03)] cursor-pointer"
            >
              {/* Date */}
              <span className="text-xs text-[#8A877D] w-[72px] shrink-0">
                {formatFecha(tx.fecha)}
              </span>

              {/* Category badge */}
              <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(255,255,255,0.05)] px-2 py-0.5 text-xs text-[#C8C6BC] shrink-0">
                {emoji} {tx.categoria}
              </span>

              {/* Comercio */}
              <span className="truncate text-sm text-[#F0EFE8] flex-1 min-w-0">
                {tx.comercio || tx.descripcion_original || tx.subcategoria}
              </span>

              {/* Amount */}
              <span
                className="text-sm font-semibold tabular-nums shrink-0"
                style={{ color: isIngreso ? '#1D9E75' : '#D85A30' }}
              >
                {isIngreso ? '+' : '-'}{formatCurrency(tx.monto_pen)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
