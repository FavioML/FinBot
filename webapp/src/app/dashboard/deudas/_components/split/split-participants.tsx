'use client';

import { Check, Link2, Share2 } from 'lucide-react';
import type { GastoCompartido } from '@/lib/hooks/use-split';
import type { SplitHandlers } from '../types';
import { monedaSym } from '../../_lib/debt-helpers';

/** Lista de participantes de un gasto compartido (compartida entre card mobile y panel desktop). */
export function SplitParticipants({ gasto, handlers }: { gasto: GastoCompartido; handlers: SplitHandlers }) {
  const parts = gasto.gasto_participantes || [];
  const sym = monedaSym(gasto.moneda);

  return (
    <div className="space-y-1.5">
      {parts.map((p) => {
        const montoPagado = Number(p.monto_pagado || 0);
        const montoDebe = Number(p.monto_debe);
        const pctPagado = montoDebe > 0 ? Math.min(100, (montoPagado / montoDebe) * 100) : 0;

        return (
          <div key={p.id} className="py-1.5 border-t border-[rgba(255,255,255,0.04)] first:border-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => handlers.onTogglePaid(gasto.id, p)}
                  className={`w-5 h-5 rounded border flex items-center justify-center transition-colors shrink-0 ${
                    p.pagado ? 'bg-[#1D9E75] border-[#1D9E75]' : 'border-[rgba(255,255,255,0.15)] hover:border-[#1D9E75]'
                  }`}
                >
                  {p.pagado && <Check className="h-3 w-3 text-white" />}
                </button>
                <div className="min-w-0">
                  <span className={`text-xs ${p.pagado ? 'text-[#8A877D] line-through' : 'text-[#C8C6BC]'}`}>{p.nombre}</span>
                  {montoPagado > 0 && !p.pagado && (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <div className="w-16 h-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                        <div className="h-full rounded-full bg-[#1D9E75]" style={{ width: `${pctPagado}%` }} />
                      </div>
                      <span className="text-[10px] text-[#8A877D]">{sym} {montoPagado.toFixed(2)} de {sym} {montoDebe.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {!p.pagado && (
                  <button
                    onClick={() => handlers.onShare(gasto.id, p)}
                    className="p-1 rounded transition-colors hover:bg-[rgba(255,255,255,0.04)]"
                    title={p.invite_code ? 'Copiar link de cobro' : 'Generar link de cobro'}
                  >
                    {p.invite_code ? <Link2 className="h-3 w-3 text-[#1D9E75]" /> : <Share2 className="h-3 w-3 text-[#8A877D]" />}
                  </button>
                )}
                <span className={`text-xs font-medium tabular-nums ${p.pagado ? 'text-[#8A877D]' : 'text-[#EF9F27]'}`}>
                  {sym} {montoDebe.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
