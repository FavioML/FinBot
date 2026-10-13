'use client';

import { Share2, Link2, Pencil, Check, Trash2 } from 'lucide-react';
import type { Deuda } from '@/lib/hooks/use-debts';
import type { DebtHandlers } from '../types';

/**
 * Botonera de acciones de una deuda. Reutilizada en la card mobile y en el panel
 * de detalle desktop. En deudas saldadas solo queda eliminar.
 */
export function DebtActions({
  debt,
  handlers,
  size = 'sm',
}: {
  debt: Deuda;
  handlers: DebtHandlers;
  size?: 'sm' | 'md';
}) {
  const isPagada = debt.estado === 'pagada';
  const iconCls = size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5';
  const btnCls = size === 'md' ? 'p-2' : 'p-1.5';

  if (isPagada) {
    return (
      <button
        onClick={() => handlers.onDelete(debt)}
        className={`${btnCls} rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors`}
        title="Eliminar"
      >
        <Trash2 className={iconCls} />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => handlers.onAbonar(debt)}
        className="px-2.5 py-1 rounded-lg text-xs font-medium bg-primary/12 text-primary-ink hover:bg-primary/20 transition-colors"
        title="Registrar abono"
      >
        Abonar
      </button>
      {debt.tipo === 'me_deben' && (
        <button
          onClick={() => handlers.onShare(debt)}
          className={`${btnCls} rounded-lg transition-colors ${
            debt.invite_code
              ? 'text-primary-ink hover:bg-primary/8'
              : 'text-muted-foreground hover:text-primary hover:bg-primary/8'
          }`}
          title={debt.invite_code ? 'Copiar link de cobro' : 'Generar link de cobro'}
        >
          {debt.invite_code ? <Link2 className={iconCls} /> : <Share2 className={iconCls} />}
        </button>
      )}
      <button
        onClick={() => handlers.onEdit(debt)}
        className={`${btnCls} rounded-lg text-muted-foreground hover:text-warning hover:bg-warning/8 transition-colors`}
        title="Editar"
      >
        <Pencil className={iconCls} />
      </button>
      <button
        onClick={() => handlers.onMarkPaid(debt)}
        className={`${btnCls} rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/8 transition-colors`}
        title="Marcar como saldada"
      >
        <Check className={iconCls} />
      </button>
      <button
        onClick={() => handlers.onDelete(debt)}
        className={`${btnCls} rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors`}
        title="Eliminar"
      >
        <Trash2 className={iconCls} />
      </button>
    </div>
  );
}
