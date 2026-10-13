'use client';

import { Coins } from 'lucide-react';
import type { Deuda } from '@/lib/hooks/use-debts';
import type { DebtHandlers } from './types';
import { RecurrenteBadge, VencimientoBadge } from './leaves/badges';
import { DebtProgress } from './leaves/debt-progress';
import { DebtHistory } from './leaves/debt-history';
import { DebtActions } from './leaves/debt-actions';
import { fmtMoneda, fechaLarga } from '../_lib/debt-helpers';

/**
 * Card completa de una deuda. Es la unidad de la lista apilada en mobile y de la
 * vista plana (toggle "agrupar" apagado) en cualquier breakpoint.
 */
export function DebtCard({ debt, handlers }: { debt: Deuda; handlers: DebtHandlers }) {
  const esDebo = debt.tipo === 'debo';
  const isPagada = debt.estado === 'pagada';
  const periodos = debt.periodos_pagados || 0;

  return (
    <div className="glass-card glass-card-glow p-5 group">
      {/* Bajo `sm` la botonera (Abonar + 4 iconos, ~170 px) baja a su propia fila: en la columna derecha le
          dejaba ~60 px al texto y la pastilla "Vencida hace 66d" (nowrap) pisaba "Abonar". Desde `sm` la
          info ocupa las dos filas y la botonera vuelve debajo del monto. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">
        {/* Izquierda: icono + info */}
        <div className="flex items-start gap-3 min-w-0 sm:row-span-2">
          <div className={`mt-0.5 w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
            isPagada ? 'bg-foreground/5' : esDebo ? 'bg-negative/10' : 'bg-primary/10'
          }`}>
            <Coins className={`h-4 w-4 ${isPagada ? 'text-muted-foreground' : esDebo ? 'text-negative-ink' : 'text-primary-ink'}`} />
          </div>
          <div className="min-w-0">
            <p className={`font-semibold text-sm ${isPagada ? 'text-muted-foreground line-through' : 'text-foreground'} flex items-center gap-1.5 flex-wrap`}>
              {debt.contraparte}
              <RecurrenteBadge debt={debt} />
            </p>
            {debt.descripcion && <p className="text-xs text-muted-foreground truncate">{debt.descripcion}</p>}
            {debt.es_recurrente && !isPagada && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {debt.fecha_fin ? `Hasta ${fechaLarga(debt.fecha_fin)}` : 'Indefinido'}
                {periodos > 0 && ` · ${periodos} periodo${periodos !== 1 ? 's' : ''} cobrado${periodos !== 1 ? 's' : ''}`}
              </p>
            )}
            {!isPagada && <VencimientoBadge debt={debt} className="mt-1" />}
          </div>
        </div>

        {/* Derecha: montos */}
        <div className="text-right">
          <p className={`text-base font-bold tabular-nums whitespace-nowrap ${isPagada ? 'text-muted-foreground' : esDebo ? 'text-negative' : 'text-primary'}`}>
            {fmtMoneda(debt.moneda, debt.monto_pendiente)}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">de {fmtMoneda(debt.moneda, debt.monto_original)}</p>
        </div>

        {/* Acciones: fila propia en celular, bajo el monto desde `sm` */}
        <div className="col-span-2 justify-self-end sm:col-span-1 sm:col-start-2 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
          <DebtActions debt={debt} handlers={handlers} />
        </div>
      </div>

      {!isPagada && <DebtProgress debt={debt} className="mt-3" />}

      {(debt.deuda_abonos?.length ?? 0) > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <DebtHistory debt={debt} collapsible />
        </div>
      )}
    </div>
  );
}
