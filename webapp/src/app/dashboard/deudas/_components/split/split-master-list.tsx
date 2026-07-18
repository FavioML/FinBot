'use client';

import { Users, ChevronRight } from 'lucide-react';
import type { GastoCompartido } from '@/lib/hooks/use-split';
import { monedaSym } from '../../_lib/debt-helpers';

/** Panel izquierdo (desktop) de Compartidos: filas seleccionables de gastos. */
export function SplitMasterList({
  gastos,
  selectedId,
  onSelect,
}: {
  gastos: GastoCompartido[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {gastos.map((gasto) => {
        const parts = gasto.gasto_participantes || [];
        const pagados = parts.filter((p) => p.pagado).length;
        const total = parts.length;
        const allPaid = pagados === total && total > 0;
        const active = selectedId === gasto.id;
        const sym = monedaSym(gasto.moneda);
        return (
          <button
            key={gasto.id}
            onClick={() => onSelect(gasto.id)}
            className={`w-full text-left rounded-xl p-3 flex items-center gap-3 transition-colors border ${
              active
                ? 'bg-[rgba(239,159,39,0.08)] border-[#EF9F27]/30'
                : 'bg-[rgba(255,255,255,0.02)] border-transparent hover:bg-[rgba(255,255,255,0.04)]'
            } ${allPaid ? 'opacity-60' : ''}`}
          >
            <div className="w-8 h-8 rounded-full bg-[rgba(239,159,39,0.1)] flex items-center justify-center shrink-0">
              <Users className="h-4 w-4 text-[#EF9F27]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-[#F0EFE8] truncate">{gasto.descripcion}</p>
              <p className="text-[10px] text-[#8A877D] mt-0.5">
                {pagados}/{total} pagados{allPaid && ' · liquidado'}
              </p>
            </div>
            <p className="text-sm font-bold tabular-nums text-[#EF9F27] shrink-0">{sym} {Number(gasto.monto_total).toFixed(2)}</p>
            <ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-[#EF9F27]' : 'text-[#6A6760]'}`} />
          </button>
        );
      })}
    </div>
  );
}
