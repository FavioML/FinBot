'use client';

import { TrendingDown, TrendingUp } from 'lucide-react';
import { fmtMulti } from '../_lib/debt-helpers';

/** Cards de resumen: lo que debes / te deben (multi-moneda). */
export function DebtSummary({
  deboPen,
  deboUsd,
  deboCount,
  meDebenPen,
  meDebenUsd,
  meDebenCount,
}: {
  deboPen: number;
  deboUsd: number;
  deboCount: number;
  meDebenPen: number;
  meDebenUsd: number;
  meDebenCount: number;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="glass-card glass-card-glow p-4 flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-[rgba(216,90,48,0.12)] flex items-center justify-center shrink-0">
          <TrendingDown className="h-5 w-5 text-[#D85A30]" />
        </div>
        <div>
          <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-0.5">Lo que debes</p>
          <p className="text-xl font-bold text-[#D85A30]">{fmtMulti(deboPen, deboUsd)}</p>
          <p className="text-xs text-[#8A877D]">{deboCount} deuda{deboCount !== 1 ? 's' : ''} activa{deboCount !== 1 ? 's' : ''}</p>
        </div>
      </div>
      <div className="glass-card glass-card-glow p-4 flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-[rgba(29,158,117,0.12)] flex items-center justify-center shrink-0">
          <TrendingUp className="h-5 w-5 text-[#1D9E75]" />
        </div>
        <div>
          <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-0.5">Te deben</p>
          <p className="text-xl font-bold text-[#1D9E75]">{fmtMulti(meDebenPen, meDebenUsd)}</p>
          <p className="text-xs text-[#8A877D]">{meDebenCount} deuda{meDebenCount !== 1 ? 's' : ''} activa{meDebenCount !== 1 ? 's' : ''}</p>
        </div>
      </div>
    </div>
  );
}
