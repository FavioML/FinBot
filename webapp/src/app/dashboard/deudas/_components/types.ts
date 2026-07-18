import type { Deuda } from '@/lib/hooks/use-debts';
import type { GastoCompartido, GastoParticipante } from '@/lib/hooks/use-split';

/** Callbacks de acciones sobre una deuda, compartidos entre card (mobile) y panel (desktop). */
export interface DebtHandlers {
  onAbonar: (debt: Deuda) => void;
  onShare: (debt: Deuda) => void;
  onEdit: (debt: Deuda) => void;
  onMarkPaid: (debt: Deuda) => void;
  onDelete: (debt: Deuda) => void;
}

/** Callbacks de acciones sobre un gasto compartido / participante. */
export interface SplitHandlers {
  onEdit: (gasto: GastoCompartido) => void;
  onDelete: (gastoId: string) => void;
  onTogglePaid: (gastoId: string, participante: GastoParticipante) => void;
  onShare: (gastoId: string, participante: GastoParticipante) => void;
}
