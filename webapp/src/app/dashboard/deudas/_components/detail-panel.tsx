'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Coins, Users, Calendar, MousePointerClick } from 'lucide-react';
import type { Deuda, DebtGroup } from '@/lib/hooks/use-debts';
import type { DebtHandlers } from './types';
import type { Selection } from './selection';
import { groupKey } from './selection';
import { RecurrenteBadge, VencimientoBadge } from './leaves/badges';
import { DebtProgress } from './leaves/debt-progress';
import { DebtHistory } from './leaves/debt-history';
import { DebtActions } from './leaves/debt-actions';
import { fmtMulti, monedaSym, fechaLarga, fechaCorta, sortDebts, getVencimientoBadge } from '../_lib/debt-helpers';

type DebtTipoTab = 'debo' | 'me_deben' | 'pagadas';

/** Un bloque de deuda dentro del panel: info + progreso + historial completo + acciones. */
function DebtDetailBlock({ debt, handlers, titleMode }: { debt: Deuda; handlers: DebtHandlers; titleMode: 'contraparte' | 'motivo' }) {
  const esDebo = debt.tipo === 'debo';
  const isPagada = debt.estado === 'pagada';
  const sym = monedaSym(debt.moneda);
  const periodos = debt.periodos_pagados || 0;
  const title = titleMode === 'contraparte' ? debt.contraparte : debt.descripcion || 'Sin motivo';

  return (
    <div className="glass-card-elevated rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`font-semibold text-sm flex items-center gap-1.5 flex-wrap ${isPagada ? 'text-[#8A877D] line-through' : 'text-[#F0EFE8]'}`}>
            {title}
            <RecurrenteBadge debt={debt} />
            {!isPagada && <VencimientoBadge debt={debt} />}
          </p>
          {titleMode === 'contraparte' && debt.descripcion && (
            <p className="text-xs text-[#8A877D] mt-0.5">{debt.descripcion}</p>
          )}
          {debt.es_recurrente && !isPagada && (
            <p className="text-[10px] text-[#8A877D] mt-0.5">
              {debt.fecha_fin ? `Hasta ${fechaLarga(debt.fecha_fin)}` : 'Indefinido'}
              {periodos > 0 && ` · ${periodos} periodo${periodos !== 1 ? 's' : ''} cobrado${periodos !== 1 ? 's' : ''}`}
            </p>
          )}
          {!debt.es_recurrente && debt.fecha_vencimiento && !isPagada && !getVencimientoBadge(debt) && (
            <p className="text-[10px] text-[#8A877D] mt-0.5">Vence: {fechaLarga(debt.fecha_vencimiento)}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className={`text-lg font-bold tabular-nums ${isPagada ? 'text-[#8A877D]' : esDebo ? 'text-[#D85A30]' : 'text-[#1D9E75]'}`}>
            {sym} {Number(debt.monto_pendiente).toFixed(2)}
          </p>
          <p className="text-[10px] text-[#8A877D] tabular-nums">de {sym} {Number(debt.monto_original).toFixed(2)}</p>
        </div>
      </div>

      {!isPagada && <DebtProgress debt={debt} className="mt-3" />}

      {(debt.deuda_abonos?.length ?? 0) > 0 && (
        <div className="mt-3 pt-3 border-t border-[rgba(255,255,255,0.05)]">
          <DebtHistory debt={debt} />
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-[rgba(255,255,255,0.05)] flex justify-end">
        <DebtActions debt={debt} handlers={handlers} size="md" />
      </div>
    </div>
  );
}

/** Panel derecho (desktop): detalle rico de la selección. */
export function DetailPanel({
  selection,
  groups,
  debts,
  tab,
  handlers,
}: {
  selection: Selection;
  groups: DebtGroup[];
  debts: Deuda[];
  tab: DebtTipoTab;
  handlers: DebtHandlers;
}) {
  const reduce = useReducedMotion();

  const group = selection?.kind === 'group' ? groups.find((g) => groupKey(g.contraparte) === selection.key) ?? null : null;
  const debt = selection?.kind === 'debt' ? debts.find((d) => d.id === selection.id) ?? null : null;

  if (!group && !debt) {
    return (
      <div className="glass-card flex flex-col items-center justify-center text-center h-full min-h-[320px] p-8">
        <div className="w-12 h-12 rounded-full bg-[rgba(255,255,255,0.03)] flex items-center justify-center mb-3">
          <MousePointerClick className="h-5 w-5 text-[#8A877D]" />
        </div>
        <p className="text-sm text-[#8A877D]">Selecciona una deuda para ver el detalle</p>
      </div>
    );
  }

  const animKey = group ? `g-${group.contraparte}` : `d-${debt!.id}`;
  const esDebo = tab === 'debo';

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={animKey}
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
        transition={reduce ? { duration: 0 } : { duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="glass-card p-5"
      >
        {group ? (
          <>
            {/* Header agregado por persona */}
            <div className="flex items-start justify-between gap-3 pb-4 border-b border-[rgba(255,255,255,0.06)]">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-full bg-[rgba(29,158,117,0.1)] flex items-center justify-center shrink-0">
                  <Users className="h-5 w-5 text-[#1D9E75]" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-base text-[#F0EFE8] truncate">{group.contraparte}</p>
                  <p className="text-xs text-[#8A877D]">
                    {group.debts.length} deuda{group.debts.length !== 1 ? 's' : ''}
                    {group.vencidas > 0 && <span className="text-[#D85A30]"> · {group.vencidas} vencida{group.vencidas !== 1 ? 's' : ''}</span>}
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] text-[#8A877D] uppercase tracking-wider">{esDebo ? 'Le debes' : 'Te debe'}</p>
                <p className={`text-lg font-bold tabular-nums ${esDebo ? 'text-[#D85A30]' : 'text-[#1D9E75]'}`}>
                  {fmtMulti(group.pen, group.usd)}
                </p>
                {group.proximoVencimiento && (
                  <p className="text-[10px] text-[#8A877D] flex items-center gap-1 justify-end mt-0.5">
                    <Calendar className="h-3 w-3" /> Próx. {fechaCorta(group.proximoVencimiento)}
                  </p>
                )}
              </div>
            </div>
            {/* Deudas de la persona */}
            <div className="space-y-3 mt-4">
              {sortDebts(group.debts).map((d) => (
                <DebtDetailBlock key={d.id} debt={d} handlers={handlers} titleMode="motivo" />
              ))}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3 mb-1">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              debt!.estado === 'pagada' ? 'bg-[rgba(255,255,255,0.05)]' : esDebo ? 'bg-[rgba(216,90,48,0.1)]' : 'bg-[rgba(29,158,117,0.1)]'
            }`}>
              <Coins className={`h-5 w-5 ${debt!.estado === 'pagada' ? 'text-[#8A877D]' : esDebo ? 'text-[#D85A30]' : 'text-[#1D9E75]'}`} />
            </div>
            <p className="text-sm text-[#8A877D]">Detalle de la deuda</p>
          </div>
        )}
        {debt && (
          <div className="mt-3">
            <DebtDetailBlock debt={debt} handlers={handlers} titleMode="contraparte" />
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
