'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Target, Wallet, TrendingDown } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { BudgetCard } from '@/components/dashboard/budget-card';
import { BudgetForm, DeleteBudgetDialog } from '@/components/dashboard/budget-form';
import type { CategoriaOption } from '@/components/dashboard/budget-form';
import { useUser } from '@/lib/hooks/use-user';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { formatCurrency, formatFecha } from '@/lib/utils';
import { MESES, getCategoriaEmoji } from '@/lib/constants';
import type { Presupuesto, Transaccion } from '@/lib/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Normalize budget/transaction category names so DB-stored budget categories
 * (lowercase: "auto", "comida", "hogar") match transaction categories
 * (mixed case: "Auto", "Alimentación", "Vivienda").
 */
function normalizeCatForMatch(cat: string): string {
  const map: Record<string, string[]> = {
    'alimentación': ['comida', 'alimentacion', 'alimentación'],
    'vivienda': ['hogar', 'vivienda', 'casa'],
    'transporte': ['auto', 'transporte'],
    'entretenimiento': ['entretenimiento', 'entretención'],
    'compras': ['compras'],
    'salud': ['salud'],
    'educación': ['educacion', 'educación'],
    'finanzas': ['finanzas'],
    'trabajo_negocio': ['trabajo_negocio', 'trabajo'],
    'otros': ['otros', 'viajes'],
  };
  const lower = cat.toLowerCase();
  for (const [canonical, aliases] of Object.entries(map)) {
    if (aliases.includes(lower) || lower === canonical) return canonical;
  }
  return lower;
}

export default function PresupuestosPage() {
  const { data: user, isLoading: userLoading } = useUser();

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const { data: budgets = [], isLoading: budgetsLoading } = useBudgets(
    user?.id,
    currentMonth,
    currentYear,
  );

  const { data: transactions = [], isLoading: txLoading } = useTransactions({
    usuarioId: user?.id,
    mes: currentMonth,
    anio: currentYear,
    tipo: 'gasto',
  });

  const queryClient = useQueryClient();
  const refreshBudgets = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['budgets'] }),
    [queryClient],
  );

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [editBudget, setEditBudget] = useState<Presupuesto | null>(null);
  const [deleteBudget, setDeleteBudget] = useState<Presupuesto | null>(null);
  const [detailBudget, setDetailBudget] = useState<Presupuesto | null>(null);

  // Compute user's unique categories from their transactions (includes non-canonical)
  const userCategorias = useMemo<CategoriaOption[]>(() => {
    const catMap = new Map<string, Set<string>>();
    for (const t of transactions) {
      if (!catMap.has(t.categoria)) catMap.set(t.categoria, new Set());
      if (t.subcategoria && t.subcategoria !== 'null' && t.subcategoria !== 'sin_categoria') {
        catMap.get(t.categoria)!.add(t.subcategoria);
      }
    }
    return Array.from(catMap.entries()).map(([nombre, subs]) => ({
      nombre,
      emoji: getCategoriaEmoji(nombre),
      subs: Array.from(subs),
    }));
  }, [transactions]);

  // Get transactions for a specific budget (for detail view)
  function getTransactionsForBudget(budget: Presupuesto): Transaccion[] {
    const budgetCatNorm = normalizeCatForMatch(budget.categoria);
    return transactions.filter((t) => {
      const txCatNorm = normalizeCatForMatch(t.categoria);
      if (budget.subcategoria) {
        return txCatNorm === budgetCatNorm && t.subcategoria?.toLowerCase() === budget.subcategoria.toLowerCase();
      }
      return txCatNorm === budgetCatNorm;
    }).sort((a, b) => new Date(b.fecha + 'T00:00:00').getTime() - new Date(a.fecha + 'T00:00:00').getTime());
  }

  // Compute spending per normalized category (and optionally subcategory)
  const spendingByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of transactions) {
      // Category-level spending (normalized)
      const catKey = normalizeCatForMatch(t.categoria);
      map.set(catKey, (map.get(catKey) || 0) + t.monto_pen);
      // Subcategory-level spending (normalized category + original subcategory)
      if (t.subcategoria) {
        const subKey = `${catKey}::${t.subcategoria.toLowerCase()}`;
        map.set(subKey, (map.get(subKey) || 0) + t.monto_pen);
      }
    }
    return map;
  }, [transactions]);

  function getSpentForBudget(budget: Presupuesto): number {
    const budgetCatNorm = normalizeCatForMatch(budget.categoria);
    if (budget.subcategoria) {
      return spendingByKey.get(`${budgetCatNorm}::${budget.subcategoria.toLowerCase()}`) || 0;
    }
    return spendingByKey.get(budgetCatNorm) || 0;
  }

  // Summary calculations
  const summary = useMemo(() => {
    const totalPresupuestado = budgets.reduce((sum, b) => sum + b.monto_limite, 0);
    const totalGastado = budgets.reduce((sum, b) => sum + getSpentForBudget(b), 0);
    const restante = totalPresupuestado - totalGastado;
    return { totalPresupuestado, totalGastado, restante };
  }, [budgets, spendingByKey]);

  const isLoading = userLoading || budgetsLoading || txLoading;

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-40" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[140px] rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <EmptyState
        title="Inicia sesión para ver tus presupuestos"
        description="Conecta tu cuenta para gestionar tus limites de gasto."
      />
    );
  }

  const hasBudgets = budgets.length > 0;
  const restanteColor = summary.restante >= 0 ? '#1D9E75' : '#D85A30';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#F0EFE8]">Presupuestos</h1>
          <p className="text-sm text-[#8A877D] mt-1">
            {MESES[currentMonth]} {currentYear}
          </p>
        </div>
        <Button
          className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-1.5"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Nuevo presupuesto
        </Button>
      </div>

      {hasBudgets ? (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="glass-card p-5">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-4 w-4 text-[#8A877D]" />
                <span className="text-xs font-medium text-[#8A877D]">Total presupuestado</span>
              </div>
              <p className="text-xl font-bold text-[#F0EFE8]">
                {formatCurrency(summary.totalPresupuestado)}
              </p>
            </div>
            <div className="glass-card p-5">
              <div className="flex items-center gap-2 mb-2">
                <TrendingDown className="h-4 w-4 text-[#8A877D]" />
                <span className="text-xs font-medium text-[#8A877D]">Total gastado</span>
              </div>
              <p className="text-xl font-bold text-[#D85A30]">
                {formatCurrency(summary.totalGastado)}
              </p>
            </div>
            <div className="glass-card p-5">
              <div className="flex items-center gap-2 mb-2">
                <Wallet className="h-4 w-4 text-[#8A877D]" />
                <span className="text-xs font-medium text-[#8A877D]">Restante</span>
              </div>
              <p className="text-xl font-bold" style={{ color: restanteColor }}>
                {formatCurrency(summary.restante)}
              </p>
            </div>
          </div>

          {/* Budget cards grid */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[...budgets].sort((a, b) => a.categoria.localeCompare(b.categoria)).map((budget) => (
              <BudgetCard
                key={budget.id}
                budget={budget}
                spent={getSpentForBudget(budget)}
                onEdit={(b) => setEditBudget(b)}
                onDelete={(b) => setDeleteBudget(b)}
                onClick={(b) => setDetailBudget(b)}
              />
            ))}
          </div>
        </>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-[rgba(255,255,255,0.03)] p-6 mb-4">
            <Target className="h-8 w-8 text-[#8A877D]" />
          </div>
          <h3 className="text-lg font-semibold text-[#F0EFE8] mb-2">
            Sin presupuestos aún
          </h3>
          <p className="text-sm text-[#8A877D] max-w-md mb-6">
            Define limites de gasto por categoria para mantener tus finanzas bajo control. Te avisaremos cuando estés cerca del limite.
          </p>
          <Button
            className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-1.5"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Crea tu primer presupuesto
          </Button>
        </div>
      )}

      {/* Create dialog */}
      <BudgetForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={refreshBudgets}
        userCategorias={userCategorias}
        existingBudgets={budgets}
      />

      {/* Edit dialog */}
      <BudgetForm
        open={!!editBudget}
        onOpenChange={(open) => { if (!open) setEditBudget(null); }}
        budget={editBudget}
        onSuccess={refreshBudgets}
        userCategorias={userCategorias}
        existingBudgets={budgets}
      />

      {/* Delete confirmation dialog */}
      <DeleteBudgetDialog
        open={!!deleteBudget}
        onOpenChange={(open) => { if (!open) setDeleteBudget(null); }}
        budget={deleteBudget}
        onSuccess={refreshBudgets}
      />

      {/* Budget detail dialog - shows transactions */}
      <Dialog open={!!detailBudget} onOpenChange={(open) => { if (!open) setDetailBudget(null); }}>
        <DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8]">
              {detailBudget && `${getCategoriaEmoji(detailBudget.categoria)} ${detailBudget.categoria}`}
              {detailBudget?.subcategoria && ` — ${detailBudget.subcategoria}`}
            </DialogTitle>
          </DialogHeader>
          {detailBudget && (() => {
            const txs = getTransactionsForBudget(detailBudget);
            const spent = getSpentForBudget(detailBudget);
            const pct = detailBudget.monto_limite > 0 ? Math.round((spent / detailBudget.monto_limite) * 100) : 0;
            return (
              <div className="space-y-4">
                {/* Summary */}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[#8A877D]">Gastado / Límite</span>
                  <span className="font-semibold" style={{ color: pct > 100 ? '#D85A30' : pct > 80 ? '#EF9F27' : '#1D9E75' }}>
                    {formatCurrency(spent)} / {formatCurrency(detailBudget.monto_limite)} ({pct}%)
                  </span>
                </div>
                {/* Progress bar */}
                <div className="h-2 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(pct, 100)}%`,
                      backgroundColor: pct > 100 ? '#D85A30' : pct > 80 ? '#EF9F27' : '#1D9E75',
                    }}
                  />
                </div>
                {/* Transaction list */}
                <div className="space-y-1">
                  <p className="text-xs text-[#8A877D] font-medium">{txs.length} transacciones</p>
                  {txs.length === 0 ? (
                    <p className="text-sm text-[#8A877D] py-4 text-center">Sin gastos en esta categoría este mes</p>
                  ) : (
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {txs.map((tx) => (
                        <div key={tx.id} className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.04)]">
                          <div className="min-w-0">
                            <p className="text-sm text-[#F0EFE8] truncate">{tx.comercio || 'Sin comercio'}</p>
                            <p className="text-xs text-[#8A877D]">{formatFecha(tx.fecha)}{tx.subcategoria && tx.subcategoria !== 'sin_categoria' ? ` · ${tx.subcategoria}` : ''}</p>
                          </div>
                          <span className="text-sm font-medium text-[#D85A30] shrink-0 ml-3">
                            -{formatCurrency(tx.monto_pen)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
