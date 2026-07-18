'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import type { Deuda } from '@/lib/hooks/use-debts';
import { sortAbonos, fechaCorta, monedaSym } from '../../_lib/debt-helpers';

/**
 * Historial de abonos de una deuda. Muestra TODOS los abonos (ordenados del más
 * reciente al más antiguo). Con `collapsible`, colapsa a `initialCount` y ofrece
 * expandir inline (para cards mobile). Sin `collapsible`, los muestra todos y deja
 * que el contenedor haga scroll (panel de detalle desktop).
 */
export function DebtHistory({
  debt,
  collapsible = false,
  initialCount = 3,
}: {
  debt: Deuda;
  collapsible?: boolean;
  initialCount?: number;
}) {
  const reduce = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const abonos = sortAbonos(debt.deuda_abonos ?? []);
  if (abonos.length === 0) return null;

  const sym = monedaSym(debt.moneda);
  const hidden = collapsible && !expanded ? Math.max(0, abonos.length - initialCount) : 0;
  const visibles = hidden > 0 ? abonos.slice(0, initialCount) : abonos;

  return (
    <div>
      <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-1.5">
        Historial de abonos
        <span className="ml-1.5 text-[#6A6760] normal-case tracking-normal">{abonos.length}</span>
      </p>
      <div className="space-y-1">
        {visibles.map((a) => (
          <div key={a.id} className="flex justify-between text-xs">
            <span className="text-[#8A877D] min-w-0 truncate">
              {fechaCorta(a.fecha)}
              {a.nota && <span className="ml-1 text-[#6A6760]">· {a.nota}</span>}
            </span>
            <span className="text-[#C8C6BC] tabular-nums font-medium shrink-0 ml-2">
              {sym} {Number(a.monto).toFixed(2)}
            </span>
          </div>
        ))}
        <AnimatePresence initial={false}>
          {hidden === 0 && collapsible && abonos.length > initialCount && (
            <motion.div
              key="rest"
              initial={reduce ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="space-y-1 overflow-hidden"
            >
              {abonos.slice(initialCount).map((a) => (
                <div key={a.id} className="flex justify-between text-xs">
                  <span className="text-[#8A877D] min-w-0 truncate">
                    {fechaCorta(a.fecha)}
                    {a.nota && <span className="ml-1 text-[#6A6760]">· {a.nota}</span>}
                  </span>
                  <span className="text-[#C8C6BC] tabular-nums font-medium shrink-0 ml-2">
                    {sym} {Number(a.monto).toFixed(2)}
                  </span>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {collapsible && abonos.length > initialCount && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Ver menos' : `Ver los ${abonos.length} abonos`}
        </button>
      )}
    </div>
  );
}
