'use client';

import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import {
  Plus,
  TrendingUp,
  TrendingDown,
  Receipt,
  Pencil,
  Trash2,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/shared/empty-state';
import { CurrencyDisplay } from '@/components/shared/currency-display';
import { TransactionFilters } from '@/components/dashboard/transaction-filters';
import { TransactionForm, DeleteConfirmDialog } from '@/components/dashboard/transaction-form';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { UserMenu } from '@/components/dashboard/user-menu';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { formatCurrency, formatFecha } from '@/lib/utils';
import { getCategoriaEmoji, MESES } from '@/lib/constants';
import { normalizeMetodoPago } from '@/lib/format';
import type { Transaccion } from '@/lib/types';

const PAGE_SIZE = 20;

type SortField = 'fecha' | 'monto' | 'comercio';
type SortDir = 'asc' | 'desc';

export default function TransaccionesPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const queryClient = useQueryClient();
  const refreshTransactions = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
  }, [queryClient]);
  const searchParams = useSearchParams();

  const now = new Date();
  const monthParam = searchParams.get('mes');
  const [paramYear, paramMonth] = monthParam
    ? monthParam.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

  // View mode: monthly or annual
  const [viewMode, setViewMode] = useState<'mensual' | 'anual'>('mensual');
  const [selectedMonth, setSelectedMonth] = useState(paramMonth);
  const [selectedYear, setSelectedYear] = useState(paramYear);

  // Fetch all transactions to compute available years
  const { data: allTransactions = [] } = useTransactions({
    usuarioId: user?.id,
  });

  // Compute available years from transaction data
  const availableYears = useMemo(() => {
    const yearSet = new Set<number>();
    for (const t of allTransactions) {
      const y = new Date(t.fecha + 'T00:00:00').getFullYear();
      yearSet.add(y);
    }
    // Always include current year
    yearSet.add(now.getFullYear());
    return Array.from(yearSet).sort((a, b) => b - a);
  }, [allTransactions]);

  const { data: monthlyTransactions = [], isLoading: txMonthlyLoading } = useTransactions({
    usuarioId: user?.id,
    mes: selectedMonth,
    anio: selectedYear,
  });

  const { data: annualTransactions = [], isLoading: txAnnualLoading } = useTransactions({
    usuarioId: user?.id,
    anio: selectedYear,
  });

  const transactions = viewMode === 'anual' ? annualTransactions : monthlyTransactions;
  const txLoading = viewMode === 'anual' ? txAnnualLoading : txMonthlyLoading;

  // Fetch budgets to include user-created categories/subcategories
  const { data: budgets = [] } = useBudgets(user?.id, selectedMonth, selectedYear);

  // Compute user categories from transactions + budgets
  const userCategorias = useMemo(() => {
    const catMap = new Map<string, Set<string>>();
    for (const t of allTransactions) {
      if (!catMap.has(t.categoria)) catMap.set(t.categoria, new Set());
      if (t.subcategoria && t.subcategoria !== 'null' && t.subcategoria !== 'sin_categoria') {
        catMap.get(t.categoria)!.add(t.subcategoria);
      }
    }
    for (const b of budgets) {
      if (!catMap.has(b.categoria)) catMap.set(b.categoria, new Set());
      if (b.subcategoria) catMap.get(b.categoria)!.add(b.subcategoria);
    }
    return Array.from(catMap.entries()).map(([nombre, subs]) => ({
      nombre,
      emoji: getCategoriaEmoji(nombre),
      subs: Array.from(subs),
    }));
  }, [allTransactions, budgets]);

  // Filters
  const [search, setSearch] = useState('');
  const [tipoFilter, setTipoFilter] = useState('todos');
  const [categoriaFilter, setCategoriaFilter] = useState('all');
  const [subcategoriaFilter, setSubcategoriaFilter] = useState('all');
  const [metodoPagoFilter, setMetodoPagoFilter] = useState('all');

  // Sort
  const [sortField, setSortField] = useState<SortField>('fecha');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Pagination
  const [page, setPage] = useState(1);

  // Dialogs
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createTipo, setCreateTipo] = useState<'gasto' | 'ingreso'>('gasto');
  const [editTransaction, setEditTransaction] = useState<Transaccion | null>(null);
  const [deleteTransaction, setDeleteTransaction] = useState<Transaccion | null>(null);

  // Filtered + sorted transactions
  const filtered = useMemo(() => {
    let result = [...transactions];

    // Type filter
    if (tipoFilter !== 'todos') {
      result = result.filter((t) => t.tipo === tipoFilter);
    }

    // Category filter
    if (categoriaFilter !== 'all') {
      result = result.filter((t) => t.categoria === categoriaFilter);
    }

    // Subcategory filter
    if (subcategoriaFilter !== 'all') {
      result = result.filter((t) => t.subcategoria === subcategoriaFilter);
    }

    // Payment method filter
    if (metodoPagoFilter !== 'all') {
      result = result.filter((t) => normalizeMetodoPago(t.metodo_pago, t.banco) === metodoPagoFilter);
    }

    // Search by comercio
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(
        (t) =>
          t.comercio?.toLowerCase().includes(q) ||
          t.descripcion_original?.toLowerCase().includes(q)
      );
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'fecha') {
        cmp = a.fecha.localeCompare(b.fecha);
      } else if (sortField === 'monto') {
        cmp = a.monto_pen - b.monto_pen;
      } else if (sortField === 'comercio') {
        cmp = (a.comercio || '').localeCompare(b.comercio || '');
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [transactions, tipoFilter, categoriaFilter, subcategoriaFilter, metodoPagoFilter, search, sortField, sortDir]);

  // Summary
  const summary = useMemo(() => {
    const gastos = transactions.filter((t) => t.tipo === 'gasto');
    const ingresos = transactions.filter((t) => t.tipo === 'ingreso');
    return {
      totalGastos: gastos.reduce((sum, t) => sum + t.monto_pen, 0),
      totalIngresos: ingresos.reduce((sum, t) => sum + t.monto_pen, 0),
      count: transactions.length,
    };
  }, [transactions]);

  // Available payment methods (normalized, from user's data)
  const availableMetodos = useMemo(() => {
    const set = new Set<string>();
    for (const t of transactions) {
      set.add(normalizeMetodoPago(t.metodo_pago, t.banco));
    }
    return Array.from(set).sort();
  }, [transactions]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(page, totalPages);
  const paginated = filtered.slice(
    (safeCurrentPage - 1) * PAGE_SIZE,
    safeCurrentPage * PAGE_SIZE
  );

  // Reset page when filters change
  const handleFilterChange = (setter: (v: string) => void, fallback = '') => (value: string | null) => {
    setter(value ?? fallback);
    setPage(1);
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'fecha' ? 'desc' : 'asc');
    }
  };

  const openCreate = (tipo: 'gasto' | 'ingreso') => {
    setCreateTipo(tipo);
    setCreateDialogOpen(true);
  };

  // Pagination page numbers
  const getPageNumbers = (): number[] => {
    const pages: number[] = [];
    const maxVisible = 5;
    let start = Math.max(1, safeCurrentPage - Math.floor(maxVisible / 2));
    let end = start + maxVisible - 1;
    if (end > totalPages) {
      end = totalPages;
      start = Math.max(1, end - maxVisible + 1);
    }
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  };

  // Month options for selector
  const monthOptions = MESES.slice(1).map((name, idx) => ({
    value: String(idx + 1),
    label: name,
  }));

  const isLoading = userLoading || txLoading;

  // --- Loading ---
  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-[56px] rounded-2xl" />
        <Skeleton className="h-[400px] rounded-2xl" />
      </div>
    );
  }

  // --- No user ---
  if (!user) {
    return (
      <EmptyState
        title="Inicia sesion para ver tus transacciones"
        description="Conecta tu cuenta para visualizar y gestionar tus movimientos."
      />
    );
  }

  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-[#F0EFE8]">Transacciones</h1>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            className="border-[rgba(255,255,255,0.06)] text-[#C8C6BC]"
            onClick={() => openCreate('gasto')}
          >
            <Plus className="h-4 w-4" data-icon="inline-start" />
            Nuevo gasto
          </Button>
          <Button
            className="bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white"
            onClick={() => openCreate('ingreso')}
          >
            <Plus className="h-4 w-4" data-icon="inline-start" />
            Nuevo ingreso
          </Button>
          <UserMenu />
        </div>
      </div>

      {/* View mode tabs + month selector */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={viewMode} onValueChange={(val) => { setViewMode(val as 'mensual' | 'anual'); setPage(1); }}>
          <TabsList>
            <TabsTrigger value="mensual">Mensual</TabsTrigger>
            <TabsTrigger value="anual">Anual</TabsTrigger>
          </TabsList>
        </Tabs>

        {viewMode === 'mensual' && (
          <MonthSelector />
        )}

        {viewMode === 'anual' && (
          <Select value={String(selectedYear)} onValueChange={(val) => { setSelectedYear(Number(val)); setPage(1); }}>
            <SelectTrigger className="w-[120px] bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#C8C6BC]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableYears.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Summary cards */}
      <StaggerContainer className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StaggerItem>
        <div className="glass-card glass-card-glow p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="h-4 w-4 text-[#D85A30]" />
            <span className="text-xs text-[#8A877D]">
              {viewMode === 'anual' ? 'Gastos del año' : 'Gastos del mes'}
            </span>
          </div>
          <CurrencyDisplay amount={summary.totalGastos} className="text-[#D85A30]" size="md" />
        </div>
        </StaggerItem>
        <StaggerItem>
        <div className="glass-card glass-card-glow p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-4 w-4 text-[#1D9E75]" />
            <span className="text-xs text-[#8A877D]">
              {viewMode === 'anual' ? 'Ingresos del año' : 'Ingresos del mes'}
            </span>
          </div>
          <CurrencyDisplay amount={summary.totalIngresos} className="text-[#1D9E75]" size="md" />
        </div>
        </StaggerItem>
        <StaggerItem>
        <div className="glass-card glass-card-glow p-4">
          <div className="flex items-center gap-2 mb-2">
            <Receipt className="h-4 w-4 text-[#378ADD]" />
            <span className="text-xs text-[#8A877D]">Transacciones</span>
          </div>
          <span className="text-xl font-semibold text-[#F0EFE8]">{summary.count}</span>
        </div>
        </StaggerItem>
      </StaggerContainer>

      {/* Filters */}
      <TransactionFilters
        search={search}
        onSearchChange={handleFilterChange(setSearch)}
        tipoFilter={tipoFilter}
        onTipoChange={handleFilterChange(setTipoFilter, 'todos')}
        categoriaFilter={categoriaFilter}
        onCategoriaChange={handleFilterChange(setCategoriaFilter, 'all')}
        subcategoriaFilter={subcategoriaFilter}
        onSubcategoriaChange={handleFilterChange(setSubcategoriaFilter, 'all')}
        metodoPagoFilter={metodoPagoFilter}
        onMetodoPagoChange={handleFilterChange(setMetodoPagoFilter, 'all')}
        availableMetodos={availableMetodos}
      />

      {/* Transaction list */}
      {filtered.length === 0 ? (
        <EmptyState
          title="Sin transacciones"
          description={
            transactions.length === 0
              ? 'Envia tus comprobantes por WhatsApp y NETO los registra automaticamente.'
              : 'No se encontraron transacciones con los filtros seleccionados.'
          }
          showWhatsApp={transactions.length === 0}
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block glass-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-[rgba(255,255,255,0.06)] hover:bg-transparent">
                  <TableHead>
                    <button
                      onClick={() => toggleSort('fecha')}
                      className="inline-flex items-center gap-1 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                    >
                      Fecha
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      onClick={() => toggleSort('comercio')}
                      className="inline-flex items-center gap-1 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                    >
                      Comercio
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead className="text-[#8A877D]">Categoria</TableHead>
                  <TableHead className="text-[#8A877D]">Subcategoria</TableHead>
                  <TableHead className="text-[#8A877D]">Metodo</TableHead>
                  <TableHead>
                    <button
                      onClick={() => toggleSort('monto')}
                      className="inline-flex items-center gap-1 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                    >
                      Monto
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead className="text-[#8A877D] w-[80px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.map((tx) => (
                  <TransactionTableRow
                    key={tx.id}
                    tx={tx}
                    onEdit={() => setEditTransaction(tx)}
                    onDelete={() => setDeleteTransaction(tx)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-2">
            {paginated.map((tx) => (
              <TransactionCard
                key={tx.id}
                tx={tx}
                onEdit={() => setEditTransaction(tx)}
                onDelete={() => setDeleteTransaction(tx)}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex flex-col gap-2 sm:flex-row items-center justify-between pt-2">
              <span className="text-xs text-[#8A877D]">
                {filtered.length} transacciones
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={safeCurrentPage <= 1}
                  onClick={() => setPage(1)}
                  className="border-[rgba(255,255,255,0.06)] text-[#C8C6BC]"
                  title="Primera"
                >
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={safeCurrentPage <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="border-[rgba(255,255,255,0.06)] text-[#C8C6BC]"
                  title="Anterior"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {getPageNumbers().map((p) => (
                  <Button
                    key={p}
                    variant={p === safeCurrentPage ? 'default' : 'outline'}
                    size="icon-sm"
                    onClick={() => setPage(p)}
                    className={
                      p === safeCurrentPage
                        ? 'bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white border-[#1D9E75]'
                        : 'border-[rgba(255,255,255,0.06)] text-[#C8C6BC]'
                    }
                  >
                    {p}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={safeCurrentPage >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="border-[rgba(255,255,255,0.06)] text-[#C8C6BC]"
                  title="Siguiente"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={safeCurrentPage >= totalPages}
                  onClick={() => setPage(totalPages)}
                  className="border-[rgba(255,255,255,0.06)] text-[#C8C6BC]"
                  title="Última"
                >
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
              <span className="text-xs text-[#8A877D]">
                Página {safeCurrentPage} de {totalPages}
              </span>
            </div>
          )}
        </>
      )}

      {/* Dialogs */}
      <TransactionForm
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        tipo={createTipo}
        onSuccess={refreshTransactions}
        userCategorias={userCategorias}
      />

      <TransactionForm
        open={!!editTransaction}
        onOpenChange={(open) => { if (!open) setEditTransaction(null); }}
        tipo={editTransaction?.tipo || 'gasto'}
        transaction={editTransaction}
        onSuccess={refreshTransactions}
        userCategorias={userCategorias}
      />

      <DeleteConfirmDialog
        open={!!deleteTransaction}
        onOpenChange={(open) => { if (!open) setDeleteTransaction(null); }}
        transaction={deleteTransaction}
        onSuccess={refreshTransactions}
      />
    </div>
    </FadeIn>
  );
}

// --- Desktop table row ---

function TransactionTableRow({
  tx,
  onEdit,
  onDelete,
}: {
  tx: Transaccion;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isIngreso = tx.tipo === 'ingreso';
  const emoji = getCategoriaEmoji(tx.categoria);

  return (
    <TableRow className="border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.02)]">
      <TableCell className="text-xs text-[#8A877D]">{formatFecha(tx.fecha)}</TableCell>
      <TableCell className="text-sm text-[#F0EFE8]">
        {tx.comercio || tx.descripcion_original || '-'}
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className="border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[#C8C6BC] text-xs"
        >
          {emoji} {tx.categoria}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-[#8A877D] capitalize">
        {tx.subcategoria?.replace(/_/g, ' ') || '-'}
      </TableCell>
      <TableCell className="text-xs text-[#8A877D]">{normalizeMetodoPago(tx.metodo_pago, tx.banco)}</TableCell>
      <TableCell>
        <span
          className="text-sm font-semibold tabular-nums"
          style={{ color: isIngreso ? '#1D9E75' : '#D85A30' }}
        >
          {isIngreso ? '+' : '-'}{formatCurrency(tx.monto, tx.moneda)}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onEdit}
            className="text-[#8A877D] hover:text-[#F0EFE8]"
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            className="text-[#8A877D] hover:text-[#D85A30]"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// --- Mobile card ---

function TransactionCard({
  tx,
  onEdit,
  onDelete,
}: {
  tx: Transaccion;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isIngreso = tx.tipo === 'ingreso';
  const emoji = getCategoriaEmoji(tx.categoria);

  return (
    <div
      className="glass-card p-4 border-l-2 transition-colors hover:bg-[rgba(255,255,255,0.02)]"
      style={{ borderLeftColor: isIngreso ? '#1D9E75' : '#D85A30' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-[#8A877D]">{formatFecha(tx.fecha)}</span>
            <Badge
              variant="outline"
              className="border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[#C8C6BC] text-xs"
            >
              {emoji} {tx.categoria}
            </Badge>
          </div>
          <p className="text-sm text-[#F0EFE8] truncate">
            {tx.comercio || tx.descripcion_original || tx.subcategoria}
          </p>
          <div className="flex items-center gap-2 mt-1">
            {tx.subcategoria && (
              <span className="text-xs text-[#8A877D] capitalize">
                {tx.subcategoria.replace(/_/g, ' ')}
              </span>
            )}
            {tx.metodo_pago && (
              <span className="text-xs text-[#8A877D]">&middot; {normalizeMetodoPago(tx.metodo_pago, tx.banco)}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className="text-sm font-semibold tabular-nums"
            style={{ color: isIngreso ? '#1D9E75' : '#D85A30' }}
          >
            {isIngreso ? '+' : '-'}{formatCurrency(tx.monto, tx.moneda)}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onEdit}
              className="text-[#8A877D] hover:text-[#F0EFE8]"
            >
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onDelete}
              className="text-[#8A877D] hover:text-[#D85A30]"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
