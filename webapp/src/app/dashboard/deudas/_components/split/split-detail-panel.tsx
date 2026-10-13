'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Calendar, Edit2, Trash2, MousePointerClick } from 'lucide-react';
import type { GastoCompartido } from '@/lib/hooks/use-split';
import type { SplitHandlers } from '../types';
import { SplitParticipants } from './split-participants';
import { fmtMoneda, fechaCorta } from '../../_lib/debt-helpers';

/** Panel derecho (desktop) de Compartidos: detalle del gasto seleccionado. */
export function SplitDetailPanel({
  gasto,
  handlers,
}: {
  gasto: GastoCompartido | null;
  handlers: SplitHandlers;
}) {
  const reduce = useReducedMotion();

  if (!gasto) {
    return (
      <div className="glass-card flex flex-col items-center justify-center text-center h-full min-h-[320px] p-8">
        <div className="w-12 h-12 rounded-full bg-foreground/3 flex items-center justify-center mb-3">
          <MousePointerClick className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">Selecciona un gasto para ver el detalle</p>
      </div>
    );
  }

  const parts = gasto.gasto_participantes || [];
  const pagados = parts.filter((p) => p.pagado).length;
  const total = parts.length;
  const allPaid = pagados === total && total > 0;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={gasto.id}
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
        transition={reduce ? { duration: 0 } : { duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="glass-card p-5"
      >
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-border">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-semibold text-base text-foreground truncate">{gasto.descripcion}</p>
              {allPaid && <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/12 text-primary-ink">Liquidado</span>}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{fechaCorta(gasto.fecha)} · {pagados}/{total} pagados</p>
            {gasto.fecha_limite && (
              <p className="text-xs text-accent-pro flex items-center gap-1 mt-0.5">
                <Calendar className="h-3 w-3" /> Vence: {fechaCorta(gasto.fecha_limite)}
              </p>
            )}
            {gasto.notas && <p className="text-xs text-muted-foreground mt-1 italic">{gasto.notas}</p>}
          </div>
          <div className="text-right shrink-0">
            <p className="text-lg font-bold text-accent-pro tabular-nums">{fmtMoneda(gasto.moneda, gasto.monto_total)}</p>
            <div className="flex gap-1 justify-end mt-1">
              <button onClick={() => handlers.onEdit(gasto)} className="p-1.5 rounded-lg text-muted-foreground hover:text-accent-pro hover:bg-warning/8 transition-colors" title="Editar">
                <Edit2 className="h-4 w-4" />
              </button>
              <button onClick={() => handlers.onDelete(gasto.id)} className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors" title="Eliminar">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
        <div className="mt-4">
          <SplitParticipants gasto={gasto} handlers={handlers} />
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
