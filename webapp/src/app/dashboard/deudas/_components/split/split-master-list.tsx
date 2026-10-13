'use client';

import { Users, ChevronRight } from 'lucide-react';
import type { GastoCompartido } from '@/lib/hooks/use-split';
import { fmtMoneda } from '../../_lib/debt-helpers';

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
        return (
          <button
            key={gasto.id}
            onClick={() => onSelect(gasto.id)}
            className={`w-full text-left rounded-xl p-3 flex items-center gap-3 transition-colors border ${
              active
                ? 'bg-warning/8 border-accent-pro/30'
                : 'bg-foreground/2 border-transparent hover:bg-foreground/4'
            } ${allPaid ? 'opacity-60' : ''}`}
          >
            <div className="w-8 h-8 rounded-full bg-warning/10 flex items-center justify-center shrink-0">
              <Users className="h-4 w-4 text-accent-pro-ink" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-foreground truncate">{gasto.descripcion}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {pagados}/{total} pagados{allPaid && ' · liquidado'}
              </p>
            </div>
            <p className="text-sm font-bold tabular-nums text-accent-pro-ink shrink-0">{fmtMoneda(gasto.moneda, gasto.monto_total)}</p>
            <ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-accent-pro-ink' : 'text-muted-foreground'}`} />
          </button>
        );
      })}
    </div>
  );
}
