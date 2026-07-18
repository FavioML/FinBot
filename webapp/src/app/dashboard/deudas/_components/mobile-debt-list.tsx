'use client';

import { Users } from 'lucide-react';
import type { Deuda, DebtGroup } from '@/lib/hooks/use-debts';
import type { DebtHandlers } from './types';
import { StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { DebtCard } from './debt-card';
import { fmtMulti } from '../_lib/debt-helpers';

type DebtTipoTab = 'debo' | 'me_deben' | 'pagadas';

/** Lista de deudas para mobile / narrow: cards planas o agrupadas por persona con encabezado. */
export function MobileDebtList({
  mode,
  groups,
  debts,
  tab,
  handlers,
}: {
  mode: 'grouped' | 'flat';
  groups: DebtGroup[];
  debts: Deuda[];
  tab: DebtTipoTab;
  handlers: DebtHandlers;
}) {
  const color = tab === 'debo' ? 'text-[#D85A30]' : 'text-[#1D9E75]';

  if (mode === 'grouped') {
    return (
      <StaggerContainer className="space-y-4">
        {groups.map((group) => (
          <StaggerItem key={group.contraparte}>
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-[rgba(29,158,117,0.1)] flex items-center justify-center shrink-0">
                    <Users className="h-3.5 w-3.5 text-[#1D9E75]" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-[#F0EFE8] truncate">{group.contraparte}</p>
                    <p className="text-[10px] text-[#8A877D]">{group.debts.length} deuda{group.debts.length !== 1 ? 's' : ''}</p>
                  </div>
                </div>
                <p className={`text-sm font-bold tabular-nums shrink-0 ${color}`}>{fmtMulti(group.pen, group.usd)}</p>
              </div>
              <div className="space-y-2">
                {group.debts.map((debt) => (
                  <DebtCard key={debt.id} debt={debt} handlers={handlers} />
                ))}
              </div>
            </div>
          </StaggerItem>
        ))}
      </StaggerContainer>
    );
  }

  return (
    <StaggerContainer className="space-y-3">
      {debts.map((debt) => (
        <StaggerItem key={debt.id}>
          <DebtCard debt={debt} handlers={handlers} />
        </StaggerItem>
      ))}
    </StaggerContainer>
  );
}
