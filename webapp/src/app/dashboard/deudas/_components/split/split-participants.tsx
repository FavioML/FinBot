'use client';

import { Check, Link2, Share2 } from 'lucide-react';
import type { GastoCompartido } from '@/lib/hooks/use-split';
import type { SplitHandlers } from '../types';
import { fmtMoneda } from '../../_lib/debt-helpers';

/** Lista de participantes de un gasto compartido (compartida entre card mobile y panel desktop). */
export function SplitParticipants({ gasto, handlers }: { gasto: GastoCompartido; handlers: SplitHandlers }) {
  const parts = gasto.gasto_participantes || [];

  return (
    <div className="space-y-1.5">
      {parts.map((p) => {
        const montoPagado = Number(p.monto_pagado || 0);
        const montoDebe = Number(p.monto_debe);
        const pctPagado = montoDebe > 0 ? Math.min(100, (montoPagado / montoDebe) * 100) : 0;

        return (
          <div key={p.id} className="py-1.5 border-t border-border first:border-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => handlers.onTogglePaid(gasto.id, p)}
                  className={`w-5 h-5 rounded border flex items-center justify-center transition-colors shrink-0 ${
                    p.pagado ? 'bg-primary border-primary' : 'border-foreground/15 hover:border-primary'
                  }`}
                >
                  {p.pagado && <Check className="h-3 w-3 text-primary-foreground" />}
                </button>
                <div className="min-w-0">
                  <span className={`text-xs ${p.pagado ? 'text-muted-foreground line-through' : 'text-foreground-soft'}`}>{p.nombre}</span>
                  {montoPagado > 0 && !p.pagado && (
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-0.5">
                      <div className="w-16 h-1 rounded-full bg-foreground/6 overflow-hidden">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${pctPagado}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground"><span className="whitespace-nowrap">{fmtMoneda(gasto.moneda, montoPagado)}</span> de <span className="whitespace-nowrap">{fmtMoneda(gasto.moneda, montoDebe)}</span></span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {!p.pagado && (
                  <button
                    onClick={() => handlers.onShare(gasto.id, p)}
                    className="p-1 rounded transition-colors hover:bg-foreground/4"
                    title={p.invite_code ? 'Copiar link de cobro' : 'Generar link de cobro'}
                  >
                    {p.invite_code ? <Link2 className="h-3 w-3 text-primary" /> : <Share2 className="h-3 w-3 text-muted-foreground" />}
                  </button>
                )}
                <span className={`text-xs font-medium tabular-nums ${p.pagado ? 'text-muted-foreground' : 'text-accent-pro'}`}>
                  {fmtMoneda(gasto.moneda, montoDebe)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
