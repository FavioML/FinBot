'use client';

import { Calendar, Edit2, Trash2 } from 'lucide-react';
import type { GastoCompartido } from '@/lib/hooks/use-split';
import type { SplitHandlers } from '../types';
import { SplitParticipants } from './split-participants';
import { monedaSym, fechaCorta } from '../../_lib/debt-helpers';

/** Card completa de un gasto compartido (lista mobile / vista plana). */
export function SplitCard({ gasto, handlers }: { gasto: GastoCompartido; handlers: SplitHandlers }) {
  const parts = gasto.gasto_participantes || [];
  const pagados = parts.filter((p) => p.pagado).length;
  const total = parts.length;
  const allPaid = pagados === total && total > 0;
  const sym = monedaSym(gasto.moneda);

  return (
    <div className={`glass-card glass-card-glow p-5 group ${allPaid ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-sm text-[#F0EFE8]">{gasto.descripcion}</p>
            {allPaid && <span className="text-[10px] px-2 py-0.5 rounded-full bg-[rgba(29,158,117,0.12)] text-[#1D9E75]">Liquidado</span>}
          </div>
          <p className="text-xs text-[#8A877D] mt-0.5">
            {fechaCorta(gasto.fecha)} · {pagados}/{total} pagados
          </p>
          {gasto.fecha_limite && (
            <p className="text-xs text-[#EF9F27] flex items-center gap-1 mt-0.5">
              <Calendar className="h-3 w-3" /> Vence: {fechaCorta(gasto.fecha_limite)}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-base font-bold text-[#EF9F27] tabular-nums">{sym} {Number(gasto.monto_total).toFixed(2)}</p>
          <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-all mt-1">
            <button onClick={() => handlers.onEdit(gasto)} className="p-1 rounded text-[#8A877D] hover:text-[#EF9F27]" title="Editar">
              <Edit2 className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => handlers.onDelete(gasto.id)} className="p-1 rounded text-[#8A877D] hover:text-[#D85A30]" title="Eliminar">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
      <div className="mt-3">
        <SplitParticipants gasto={gasto} handlers={handlers} />
      </div>
    </div>
  );
}
