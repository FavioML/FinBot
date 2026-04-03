'use client';

import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { Plus, Target, Wallet, TrendingDown, PiggyBank } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { ProBadge } from '@/components/shared/upgrade-prompt';
import { FREE_LIMITS, hasReachedLimit } from '@/lib/plan';
import { BudgetCard } from '@/components/dashboard/budget-card';
import { BudgetForm, DeleteBudgetDialog } from '@/components/dashboard/budget-form';
import type { CategoriaOption } from '@/components/dashboard/budget-form';
import { useUser } from '@/lib/hooks/use-user';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { formatCurrency, formatFecha } from '@/lib/utils';
import { capitalizeDisplay } from '@/lib/format';
import { MESES, getCategoriaEmoji } from '@/lib/constants';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { HeaderActions } from '@/components/dashboard/topbar';
import type { Presupuesto, Transaccion } from '@/lib/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TransactionForm } from '@/components/dashboard/transaction-form';
import { Pencil } from 'lucide-react';

/**
 * Normalize budget/transaction category names so DB-stored budget categories
 * (lowercase: "auto", "comida", "hogar") match transaction categories
 * (mixed case: "Auto", "Alimentación", "Vivienda").
 */
function normalizeCatForMatch(cat: string): string {
  // Only normalize encoding variants, NOT different categories
  // "Auto" stays "Auto", "Viajes" stays "Viajes"
  const map: Record<string, string[]> = {
    'alimentación': ['alimentacion', 'alimentación'],
    'educación': ['educacion', 'educación'],
  };
  const lower = cat.toLowerCase();
  for (const [canonical, aliases] of Object.entries(map)) {
    if (aliases.includes(lower) || lower === canonical) return canonical;
  }
  return lower;
}

export default function PresupuestosPage() {
  const { data: user, isLoading: userLoading } = useUser();

  const searchParams = useSearchParams();
  const now = new Date();
  const monthParam = searchParams.get('mes');
  const [currentYear, currentMonth] = monthParam
    ? monthParam.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

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

  // All transactions for spending average calculation
  const { data: allTransactions = [] } = useTransactions({
    usuarioId: user?.id,
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
  const [detailCategoria, setDetailCategoria] = useState<string | null>(null);
  const [editTransaction, setEditTransaction] = useState<Transaccion | null>(null);

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['budgets'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
  }, [queryClient]);

  // Compute user's unique categories from ALL transactions (not just current month) AND budgets
  const userCategorias = useMemo<CategoriaOption[]>(() => {
    const catMap = new Map<string, Set<string>>();
    // From ALL transactions (so subcategories from any month appear in dropdowns)
    for (const t of allTransactions) {
      if (!catMap.has(t.categoria)) catMap.set(t.categoria, new Set());
      if (t.subcategoria && t.subcategoria !== 'null' && t.subcategoria !== 'sin_categoria') {
        catMap.get(t.categoria)!.add(t.subcategoria);
      }
    }
    // From budgets (includes subcategories created as budgets but with no transactions yet)
    for (const b of budgets) {
      if (!catMap.has(b.categoria)) catMap.set(b.categoria, new Set());
      if (b.subcategoria) {
        catMap.get(b.categoria)!.add(b.subcategoria);
      }
    }
    return Array.from(catMap.entries()).map(([nombre, subs]) => ({
      nombre,
      emoji: getCategoriaEmoji(nombre),
      subs: Array.from(subs),
    }));
  }, [allTransactions, budgets]);

  // Compute average monthly spending per category (last 3 months)
  const spendingAvgByCategory = useMemo(() => {
    const map = new Map<string, Map<string, number>>(); // cat -> monthKey -> total
    for (const t of allTransactions.filter(tx => tx.tipo === 'gasto')) {
      const d = new Date(t.fecha + 'T00:00:00');
      const monthKey = `${d.getFullYear()}-${d.getMonth() + 1}`;
      const cat = t.categoria.toLowerCase();
      if (!map.has(cat)) map.set(cat, new Map());
      const catMap = map.get(cat)!;
      catMap.set(monthKey, (catMap.get(monthKey) || 0) + t.monto_pen);
    }
    const avgMap = new Map<string, number>();
    for (const [cat, monthMap] of map.entries()) {
      const months = Math.max(1, monthMap.size);
      const total = Array.from(monthMap.values()).reduce((s, v) => s + v, 0);
      avgMap.set(cat, total / months);
    }
    return avgMap;
  }, [allTransactions]);

  // Compute spending per normalized category and subcategory
  const spendingByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of transactions) {
      const catKey = normalizeCatForMatch(t.categoria);
      map.set(catKey, (map.get(catKey) || 0) + t.monto_pen);
      if (t.subcategoria) {
        const subKey = `${catKey}::${t.subcategoria.toLowerCase()}`;
        map.set(subKey, (map.get(subKey) || 0) + t.monto_pen);
      }
    }
    return map;
  }, [transactions]);

  // Group budgets by category: one card per category
  const groupedBudgets = useMemo(() => {
    const groups = new Map<string, { total: Presupuesto | null; subs: Presupuesto[] }>();
    for (const b of budgets) {
      const cat = b.categoria;
      if (!groups.has(cat)) groups.set(cat, { total: null, subs: [] });
      const group = groups.get(cat)!;
      if (b.subcategoria) {
        group.subs.push(b);
      } else {
        group.total = b;
      }
    }
    // Sort subs alphabetically
    for (const group of groups.values()) {
      group.subs.sort((a, b) => (a.subcategoria || '').localeCompare(b.subcategoria || ''));
    }
    return groups;
  }, [budgets]);

  // Get transactions for a category (for detail view)
  function getTransactionsForCategory(categoria: string): Transaccion[] {
    const budgetCatNorm = normalizeCatForMatch(categoria);
    return transactions
      .filter((t) => normalizeCatForMatch(t.categoria) === budgetCatNorm)
      .sort((a, b) => new Date(b.fecha + 'T00:00:00').getTime() - new Date(a.fecha + 'T00:00:00').getTime());
  }

  // Summary calculations: only count total rows (or sum of subs if no total)
  const summary = useMemo(() => {
    let totalPresupuestado = 0;
    let totalGastado = 0;

    for (const [cat, group] of groupedBudgets.entries()) {
      const catKey = normalizeCatForMatch(cat);
      const limit = group.total
        ? group.total.monto_limite
        : group.subs.reduce((sum, b) => sum + b.monto_limite, 0);
      totalPresupuestado += limit;
      totalGastado += spendingByKey.get(catKey) || 0;
    }

    return { totalPresupuestado, totalGastado, restante: totalPresupuestado - totalGastado };
  }, [groupedBudgets, spendingByKey]);

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
        title="Inicia sesion para ver tus presupuestos"
        description="Conecta tu cuenta para gestionar tus limites de gasto."
        icon={Target}
      />
    );
  }

  const isPremium = user?.plan === 'premium';
  const budgetsLimitReached = hasReachedLimit(user?.plan, 'budgets', groupedBudgets.size);
  const hasBudgets = groupedBudgets.size > 0;
  const restanteColor = summary.restante >= 0 ? '#1D9E75' : '#D85A30';

  // Detail dialog data
  const detailGroup = detailCategoria ? groupedBudgets.get(detailCategoria) : null;
  const detailTxs = detailCategoria ? getTransactionsForCategory(detailCategoria) : [];
  const detailCatKey = detailCategoria ? normalizeCatForMatch(detailCategoria) : '';
  const detailTotalSpent = detailCatKey ? (spendingByKey.get(detailCatKey) || 0) : 0;
  const detailTotalLimit = detailGroup
    ? (detailGroup.total ? detailGroup.total.monto_limite : detailGroup.subs.reduce((s, b) => s + b.monto_limite, 0))
    : 0;
  const detailPct = detailTotalLimit > 0 ? Math.round((detailTotalSpent / detailTotalLimit) * 100) : 0;

  // Group detail transactions by subcategory (computed inline, not memoized with unstable dep)
  const detailTxsBySubcat = (() => {
    if (!detailCategoria) return new Map<string, Transaccion[]>();
    const map = new Map<string, Transaccion[]>();
    for (const tx of detailTxs) {
      const sub = (tx.subcategoria && tx.subcategoria !== 'sin_categoria') ? tx.subcategoria : '(General)';
      if (!map.has(sub)) map.set(sub, []);
      map.get(sub)!.push(tx);
    }
    return map;
  })();

  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#F0EFE8]">Presupuestos</h1>
        </div>
        <HeaderActions>
          <MonthSelector />
          {budgetsLimitReached && !isPremium && (
            <ProBadge text={`Límite: ${FREE_LIMITS.budgets} presupuestos`} />
          )}
          <Button
            className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-1.5"
            onClick={() => setCreateOpen(true)}
            disabled={budgetsLimitReached && !isPremium}
          >
            <Plus className="h-4 w-4" />
            Nuevo presupuesto
          </Button>
        </HeaderActions>
      </div>

      {hasBudgets ? (
        <>
          {/* Summary cards */}
          <StaggerContainer className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StaggerItem>
            <div className="glass-card glass-card-glow p-5">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-4 w-4 text-[#8A877D]" />
                <span className="text-xs font-medium text-[#8A877D]">Total presupuestado</span>
              </div>
              <p className="text-xl font-bold text-[#F0EFE8]">
                {formatCurrency(summary.totalPresupuestado)}
              </p>
            </div>
            </StaggerItem>
            <StaggerItem>
            <div className="glass-card glass-card-glow p-5">
              <div className="flex items-center gap-2 mb-2">
                <TrendingDown className="h-4 w-4 text-[#8A877D]" />
                <span className="text-xs font-medium text-[#8A877D]">Total gastado</span>
              </div>
              <p className="text-xl font-bold text-[#D85A30]">
                {formatCurrency(summary.totalGastado)}
              </p>
            </div>
            </StaggerItem>
            <StaggerItem>
            <div className="glass-card glass-card-glow p-5">
              <div className="flex items-center gap-2 mb-2">
                <Wallet className="h-4 w-4 text-[#8A877D]" />
                <span className="text-xs font-medium text-[#8A877D]">Restante</span>
              </div>
              <p className="text-xl font-bold" style={{ color: restanteColor }}>
                {formatCurrency(summary.restante)}
              </p>
            </div>
            </StaggerItem>
          </StaggerContainer>

          {/* Global progress bar */}
          {summary.totalPresupuestado > 0 && (
            <div className="glass-card p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[#8A877D]">Uso total del presupuesto</span>
                <span
                  className="text-xs font-medium"
                  style={{
                    color: summary.totalGastado / summary.totalPresupuestado >= 1
                      ? '#D85A30'
                      : summary.totalGastado / summary.totalPresupuestado >= 0.8
                        ? '#EF9F27'
                        : '#1D9E75',
                  }}
                >
                  {Math.round((summary.totalGastado / summary.totalPresupuestado) * 100)}%
                </span>
              </div>
              <div className="h-3 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.min(100, (summary.totalGastado / summary.totalPresupuestado) * 100)}%`,
                    backgroundColor: summary.totalGastado / summary.totalPresupuestado >= 1
                      ? '#D85A30'
                      : summary.totalGastado / summary.totalPresupuestado >= 0.8
                        ? '#EF9F27'
                        : '#1D9E75',
                  }}
                />
              </div>
              <div className="flex items-center justify-between mt-1.5 text-[10px] text-[#8A877D]">
                <span>{formatCurrency(summary.totalGastado)} gastado</span>
                <span>{formatCurrency(summary.totalPresupuestado)} presupuestado</span>
              </div>
            </div>
          )}

          {/* Budget cards grid — one card per CATEGORY */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from(groupedBudgets.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([cat, group]) => (
                <BudgetCard
                  key={cat}
                  categoria={cat}
                  totalBudget={group.total}
                  subBudgets={group.subs}
                  spendingByKey={spendingByKey}
                  onEdit={(b) => setEditBudget(b)}
                  onDelete={(b) => setDeleteBudget(b)}
                  onClick={(c) => setDetailCategoria(c)}
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
        spendingAvgByCategory={spendingAvgByCategory}
        mes={currentMonth}
        anio={currentYear}
      />

      {/* Edit dialog */}
      <BudgetForm
        open={!!editBudget}
        onOpenChange={(open) => { if (!open) setEditBudget(null); }}
        budget={editBudget}
        onSuccess={refreshBudgets}
        userCategorias={userCategorias}
        existingBudgets={budgets}
        groupSubBudgets={
          editBudget
            ? (groupedBudgets.get(editBudget.categoria)?.subs ?? [])
            : undefined
        }
        mes={currentMonth}
        anio={currentYear}
      />

      {/* Delete confirmation dialog */}
      <DeleteBudgetDialog
        open={!!deleteBudget}
        onOpenChange={(open) => { if (!open) setDeleteBudget(null); }}
        budget={deleteBudget}
        onSuccess={refreshBudgets}
      />

      {/* Category detail dialog — shows transactions grouped by subcategory */}
      <Dialog open={!!detailCategoria} onOpenChange={(open) => { if (!open) setDetailCategoria(null); }}>
        <DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-lg max-h-[80vh] overflow-y-auto glass-card-depth">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8]">
              {detailCategoria && `${getCategoriaEmoji(detailCategoria)} ${capitalizeDisplay(detailCategoria)}`}
            </DialogTitle>
          </DialogHeader>
          {detailCategoria && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-[#8A877D]">Gastado / Límite</span>
                <span className="font-semibold" style={{ color: detailPct > 100 ? '#D85A30' : detailPct > 80 ? '#EF9F27' : '#1D9E75' }}>
                  {formatCurrency(detailTotalSpent)} / {formatCurrency(detailTotalLimit)} ({detailPct}%)
                </span>
              </div>
              {/* Progress bar */}
              <div className="h-2 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.min(detailPct, 100)}%`,
                    backgroundColor: detailPct > 100 ? '#D85A30' : detailPct > 80 ? '#EF9F27' : '#1D9E75',
                  }}
                />
              </div>

              {/* Sub-budget breakdown */}
              {detailGroup?.subs && detailGroup.subs.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-[#C8C6BC]">Presupuestos por subcategoría</h4>
                  {detailGroup.subs.map(sub => {
                    const subKey = `${detailCatKey}::${(sub.subcategoria || '').toLowerCase()}`;
                    const subSpent = spendingByKey.get(subKey) || 0;
                    const subLimit = Number(sub.monto_limite);
                    const subPct = subLimit > 0 ? Math.round((subSpent / subLimit) * 100) : 0;
                    const subColor = subPct >= 90 ? '#D85A30' : subPct >= 60 ? '#EF9F27' : '#1D9E75';
                    return (
                      <div key={sub.id} className="space-y-1">
                        <div className="flex justify-between text-sm">
                          <span className="text-[#F0EFE8]">{capitalizeDisplay(sub.subcategoria || '')}</span>
                          <span style={{ color: subColor }}>
                            S/ {subSpent.toFixed(2)} / S/ {subLimit.toFixed(2)} ({subPct}%)
                          </span>
                        </div>
                        <div className="h-1.5 bg-[#2A2A28] rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{ width: `${Math.min(subPct, 100)}%`, backgroundColor: subColor }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Transactions grouped by subcategory */}
              <div className="space-y-3">
                <p className="text-xs text-[#8A877D] font-medium">{detailTxs.length} transacciones</p>
                {detailTxs.length === 0 ? (
                  <p className="text-sm text-[#8A877D] py-4 text-center">Sin gastos en esta categoría este mes</p>
                ) : (
                  <div className="space-y-4 max-h-[400px] overflow-y-auto">
                    {Array.from(detailTxsBySubcat.entries())
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([subName, txs]) => (
                        <div key={subName}>
                          <p className="text-xs font-medium text-[#C8C6BC] mb-1.5">
                            {subName === '(General)' ? subName : capitalizeDisplay(subName)}
                          </p>
                          <div className="space-y-1">
                            {txs.map((tx) => (
                              <div
                                key={tx.id}
                                className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.04)] cursor-pointer hover:bg-[rgba(255,255,255,0.03)] rounded px-1 -mx-1 transition-colors group"
                                onClick={() => setEditTransaction(tx)}
                              >
                                <div className="min-w-0">
                                  <p className="text-sm text-[#F0EFE8] truncate">{tx.comercio || 'Sin comercio'}</p>
                                  <p className="text-xs text-[#8A877D]">{formatFecha(tx.fecha)}</p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0 ml-3">
                                  <span className="text-sm font-medium text-[#D85A30]">
                                    -{formatCurrency(tx.monto_pen)}
                                  </span>
                                  <Pencil className="h-3 w-3 text-[#8A877D] opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity" />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit transaction dialog (from budget detail) */}
      <TransactionForm
        open={!!editTransaction}
        onOpenChange={(open) => { if (!open) setEditTransaction(null); }}
        tipo={editTransaction?.tipo === 'ingreso' ? 'ingreso' : 'gasto'}
        transaction={editTransaction}
        onSuccess={refreshAll}
        userCategorias={userCategorias}
      />
    </div>
    </FadeIn>
  );
}
