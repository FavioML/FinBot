'use client';

import { useState, useMemo } from 'react';
import { Plus, Target, Wallet, TrendingDown } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { BudgetCard } from '@/components/dashboard/budget-card';
import { BudgetForm, DeleteBudgetDialog } from '@/components/dashboard/budget-form';
import { useUser } from '@/lib/hooks/use-user';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { formatCurrency } from '@/lib/utils';
import { MESES } from '@/lib/constants';
import type { Presupuesto } from '@/lib/types';

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

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [editBudget, setEditBudget] = useState<Presupuesto | null>(null);
  const [deleteBudget, setDeleteBudget] = useState<Presupuesto | null>(null);

  // Compute spending per category (and optionally subcategory)
  const spendingByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of transactions) {
      // Category-level spending
      const catKey = t.categoria;
      map.set(catKey, (map.get(catKey) || 0) + t.monto_pen);
      // Subcategory-level spending
      if (t.subcategoria) {
        const subKey = `${t.categoria}::${t.subcategoria}`;
        map.set(subKey, (map.get(subKey) || 0) + t.monto_pen);
      }
    }
    return map;
  }, [transactions]);

  function getSpentForBudget(budget: Presupuesto): number {
    if (budget.subcategoria) {
      return spendingByKey.get(`${budget.categoria}::${budget.subcategoria}`) || 0;
    }
    return spendingByKey.get(budget.categoria) || 0;
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
            {budgets.map((budget) => (
              <BudgetCard
                key={budget.id}
                budget={budget}
                spent={getSpentForBudget(budget)}
                onEdit={(b) => setEditBudget(b)}
                onDelete={(b) => setDeleteBudget(b)}
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
      />

      {/* Edit dialog */}
      <BudgetForm
        open={!!editBudget}
        onOpenChange={(open) => { if (!open) setEditBudget(null); }}
        budget={editBudget}
      />

      {/* Delete confirmation dialog */}
      <DeleteBudgetDialog
        open={!!deleteBudget}
        onOpenChange={(open) => { if (!open) setDeleteBudget(null); }}
        budget={deleteBudget}
      />
    </div>
  );
}
