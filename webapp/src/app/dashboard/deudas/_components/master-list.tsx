'use client';

import { Coins, Users, ChevronRight } from 'lucide-react';
import type { Deuda, DebtGroup } from '@/lib/hooks/use-debts';
import { VencimientoBadge, RecurrenteBadge } from './leaves/badges';
import { fmtMulti, fmtMoneda, sortDebts } from '../_lib/debt-helpers';
import type { Selection } from './selection';

type DebtTipoTab = 'debo' | 'me_deben' | 'pagadas';

const amountColor = (tab: DebtTipoTab) =>
  tab === 'debo' ? 'text-negative' : tab === 'me_deben' ? 'text-primary' : 'text-muted-foreground';

/** Panel izquierdo (desktop): filas seleccionables, agrupadas por persona o planas. */
export function MasterList({
  mode,
  groups,
  debts,
  tab,
  selection,
  onSelect,
}: {
  mode: 'grouped' | 'flat';
  groups: DebtGroup[];
  debts: Deuda[];
  tab: DebtTipoTab;
  selection: Selection;
  onSelect: (sel: Selection) => void;
}) {
  const color = amountColor(tab);

  if (mode === 'grouped') {
    return (
      <div className="space-y-1.5">
        {groups.map((group) => {
          const active = selection?.kind === 'group' && selection.key === group.contraparte.toLowerCase().trim();
          const urgente = sortDebts(group.debts)[0];
          return (
            <button
              key={group.contraparte}
              onClick={() => onSelect({ kind: 'group', key: group.contraparte.toLowerCase().trim() })}
              className={`w-full text-left rounded-xl p-3 flex items-center gap-3 transition-colors border ${
                active
                  ? 'bg-primary/8 border-primary/30'
                  : 'bg-foreground/2 border-transparent hover:bg-foreground/4'
              }`}
            >
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Users className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm text-foreground truncate">{group.contraparte}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    {group.debts.length} deuda{group.debts.length !== 1 ? 's' : ''}
                  </span>
                  {urgente && <VencimientoBadge debt={urgente} />}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className={`text-sm font-bold tabular-nums ${color}`}>{fmtMulti(group.pen, group.usd)}</p>
              </div>
              <ChevronRight className={`h-4 w-4 shrink-0 transition-colors ${active ? 'text-primary' : 'text-muted-foreground'}`} />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {debts.map((debt) => {
        const active = selection?.kind === 'debt' && selection.id === debt.id;
        const esDebo = debt.tipo === 'debo';
        const isPagada = debt.estado === 'pagada';
        const rowColor = isPagada ? 'text-muted-foreground' : esDebo ? 'text-negative' : 'text-primary';
        return (
          <button
            key={debt.id}
            onClick={() => onSelect({ kind: 'debt', id: debt.id })}
            className={`w-full text-left rounded-xl p-3 flex items-center gap-3 transition-colors border ${
              active
                ? 'bg-primary/8 border-primary/30'
                : 'bg-foreground/2 border-transparent hover:bg-foreground/4'
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              isPagada ? 'bg-foreground/5' : esDebo ? 'bg-negative/10' : 'bg-primary/10'
            }`}>
              <Coins className={`h-4 w-4 ${rowColor}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={`font-semibold text-sm truncate flex items-center gap-1.5 ${isPagada ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                {debt.contraparte}
                <RecurrenteBadge debt={debt} />
              </p>
              <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                {debt.descripcion && <span className="text-[10px] text-muted-foreground truncate">{debt.descripcion}</span>}
                {!isPagada && <VencimientoBadge debt={debt} />}
              </div>
            </div>
            <p className={`text-sm font-bold tabular-nums shrink-0 ${rowColor}`}>{fmtMoneda(debt.moneda, debt.monto_pendiente)}</p>
          </button>
        );
      })}
    </div>
  );
}
