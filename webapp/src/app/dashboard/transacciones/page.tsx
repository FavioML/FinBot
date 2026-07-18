'use client';


import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
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
  Search,
  FileText,
  Download,
  Upload,
  Crown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Settings2,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { canAccess } from '@/lib/plan';
import { TransaccionesSkeleton } from '@/components/dashboard/skeletons';
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
import { ImportDialog } from '@/components/dashboard/import-dialog';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useUserCategorias } from '@/lib/hooks/use-user-categorias';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { toast } from 'sonner';
import { formatCurrency, formatFecha } from '@/lib/utils';
import { getCategoriaEmoji, MESES, SOCIAL_LINKS, CATEGORIA_POR_REVISAR, needsReview } from '@/lib/constants';
import { normalizeMetodoPago, getMetodoIcon, formatLast4 } from '@/lib/format';
import type { Transaccion } from '@/lib/types';
import { HeaderActions } from '@/components/dashboard/topbar';

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
  const [annualYear, setAnnualYear] = useState(paramYear);
  // In monthly mode, always follow URL params; in annual mode, use local state
  const selectedMonth = paramMonth;
  const selectedYear = viewMode === 'mensual' ? paramYear : annualYear;

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

  // Catálogo all-time de categorías/subcategorías (query liviana, independiente del
  // periodo y de la lista pesada). Alimenta el selector del formulario de editar para
  // que las subcategorías de cualquier mes estén siempre disponibles.
  const { data: catPairs = [] } = useUserCategorias(user?.id);

  // Compute user categories from all-time catalog + budgets
  const userCategorias = useMemo(() => {
    const catMap = new Map<string, Set<string>>();
    for (const t of catPairs) {
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
  }, [catPairs, budgets]);

  // Filters
  const [search, setSearch] = useState('');
  const [tipoFilter, setTipoFilter] = useState('todos');
  const [categoriaFilter, setCategoriaFilter] = useState('all');
  // Alcance del filtro "Por revisar": 'periodo' (solo el mes/año visible, respeta el
  // selector) o 'global' (backlog de todos los meses, escape hatch).
  const [porRevisarScope, setPorRevisarScope] = useState<'periodo' | 'global'>('periodo');
  const [subcategoriaFilter, setSubcategoriaFilter] = useState('all');
  const [metodoPagoFilter, setMetodoPagoFilter] = useState('all');

  // Sort
  const [sortField, setSortField] = useState<SortField>('fecha');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Pagination
  const [page, setPage] = useState(1);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditFields, setBulkEditFields] = useState({
    metodo_pago: '',
    banco: '',
    categoria: '',
    subcategoria: '',
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === paginated.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginated.map((t) => t.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0 || bulkDeleting) return;
    setBulkDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.all(
        ids.map((id) => fetch(`/api/transactions?id=${id}`, { method: 'DELETE' }))
      );
      const deleted = results.filter((r) => r.ok).length;
      if (deleted > 0) {
        toast.success(`${deleted} transacci${deleted === 1 ? 'ón eliminada' : 'ones eliminadas'}`);
        refreshTransactions();
      }
      setSelectedIds(new Set());
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleBulkEdit = async () => {
    if (selectedIds.size === 0 || bulkEditing) return;
    // Build updates object — only include fields the user actually set
    const updates: Record<string, string> = {};
    if (bulkEditFields.metodo_pago) updates.metodo_pago = bulkEditFields.metodo_pago;
    if (bulkEditFields.banco) updates.banco = bulkEditFields.banco;
    if (bulkEditFields.categoria) updates.categoria = bulkEditFields.categoria;
    if (bulkEditFields.subcategoria) updates.subcategoria = bulkEditFields.subcategoria;

    if (Object.keys(updates).length === 0) {
      toast.error('Selecciona al menos un campo para editar');
      return;
    }

    setBulkEditing(true);
    try {
      const res = await fetch('/api/transactions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds), updates }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`${data.updated || selectedIds.size} transacciones actualizadas`);
        refreshTransactions();
        setSelectedIds(new Set());
        setBulkEditOpen(false);
        setBulkEditFields({ metodo_pago: '', banco: '', categoria: '', subcategoria: '' });
      } else {
        toast.error('Error al actualizar');
      }
    } catch {
      toast.error('Error de conexion');
    }
    setBulkEditing(false);
  };

  // Available subcategories for selected bulk edit category
  const bulkEditSubs = useMemo(() => {
    if (!bulkEditFields.categoria) return [];
    const cat = userCategorias.find((c) => c.nombre === bulkEditFields.categoria);
    return cat?.subs || [];
  }, [bulkEditFields.categoria, userCategorias]);

  // Dialogs
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createTipo, setCreateTipo] = useState<'gasto' | 'ingreso'>('gasto');
  const [importOpen, setImportOpen] = useState(false);
  const [editTransaction, setEditTransaction] = useState<Transaccion | null>(null);
  const [deleteTransaction, setDeleteTransaction] = useState<Transaccion | null>(null);

  // Filtered + sorted transactions
  const filtered = useMemo(() => {
    // "Por revisar" en alcance 'global' barre todos los meses (el backlog completo);
    // en 'periodo' respeta el mes/año visible como cualquier otro filtro. El resto de
    // filtros siempre respetan el periodo.
    const porRevisarGlobal = categoriaFilter === CATEGORIA_POR_REVISAR && porRevisarScope === 'global';
    let result = [...(porRevisarGlobal ? allTransactions : transactions)];

    // Type filter
    if (tipoFilter !== 'todos') {
      result = result.filter((t) => t.tipo === tipoFilter);
    }

    // Category filter — el centinela "Por revisar" no es una categoria: cruza
    // categoria y subcategoria (ver needsReview).
    if (categoriaFilter === CATEGORIA_POR_REVISAR) {
      result = result.filter(needsReview);
    } else if (categoriaFilter !== 'all') {
      result = result.filter((t) => t.categoria === categoriaFilter);
    }

    // Subcategory filter — case-insensitive to handle mixed casing from NLP vs hardcoded lists
    if (subcategoriaFilter !== 'all') {
      const filterLower = subcategoriaFilter.toLowerCase();
      result = result.filter((t) => t.subcategoria?.toLowerCase() === filterLower);
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
  }, [transactions, allTransactions, tipoFilter, categoriaFilter, porRevisarScope, subcategoriaFilter, metodoPagoFilter, search, sortField, sortDir]);

  // Whether any filter narrows the period's transactions
  const hasActiveFilters =
    tipoFilter !== 'todos' ||
    categoriaFilter !== 'all' ||
    subcategoriaFilter !== 'all' ||
    metodoPagoFilter !== 'all' ||
    search.trim() !== '';

  // Summary — reflects the active filters so the consolidated totals match
  // exactly what's shown in the table below.
  const summary = useMemo(() => {
    const gastos = filtered.filter((t) => t.tipo === 'gasto');
    const ingresos = filtered.filter((t) => t.tipo === 'ingreso');
    return {
      totalGastos: gastos.reduce((sum, t) => sum + t.monto_pen, 0),
      totalIngresos: ingresos.reduce((sum, t) => sum + t.monto_pen, 0),
      count: filtered.length,
    };
  }, [filtered]);

  // "Por revisar" — dos contadores: el del periodo visible (lo que el banner muestra
  // como principal, para que matchee el contexto) y el global (todos los meses, para
  // el escape hatch). El bot ya no pide categorizar por WhatsApp, asi que este sigue
  // siendo el unico lugar donde el usuario ve el backlog completo.
  const porRevisarPeriodCount = useMemo(
    () => transactions.filter(needsReview).length,
    [transactions]
  );
  const porRevisarGlobalCount = useMemo(
    () => allTransactions.filter(needsReview).length,
    [allTransactions]
  );
  const porRevisarOtherCount = Math.max(0, porRevisarGlobalCount - porRevisarPeriodCount);
  const porRevisarActive = categoriaFilter === CATEGORIA_POR_REVISAR;
  const periodBloqueado = porRevisarActive && porRevisarScope === 'global';

  const activarPorRevisar = (scope: 'periodo' | 'global') => {
    setCategoriaFilter(CATEGORIA_POR_REVISAR);
    setPorRevisarScope(scope);
    setSubcategoriaFilter('all');
    setPage(1);
  };

  const desactivarPorRevisar = () => {
    setCategoriaFilter('all');
    setPorRevisarScope('periodo');
    setSubcategoriaFilter('all');
    setPage(1);
  };

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

  const exportCSV = () => {
    if (filtered.length === 0) return;
    const headers = ['Fecha', 'Tipo', 'Comercio', 'Categoria', 'Subcategoria', 'Metodo', 'Monto (PEN)', 'Moneda', 'Monto Original'];
    const rows = filtered.map((t) => [
      t.fecha,
      t.tipo,
      `"${(t.comercio || '').replace(/"/g, '""')}"`,
      t.categoria,
      t.subcategoria || '',
      normalizeMetodoPago(t.metodo_pago, t.banco),
      t.monto_pen.toFixed(2),
      t.moneda,
      t.monto.toFixed(2),
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const periodo = viewMode === 'anual' ? `${selectedYear}` : `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    a.download = `Neto-Transacciones-${periodo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
      <TransaccionesSkeleton />
    );
  }

  // --- No user ---
  if (!user) {
    return (
      <EmptyState
        title="Inicia sesion para ver tus transacciones"
        description="Conecta tu cuenta para visualizar y gestionar tus movimientos."
        icon={FileText}
      />
    );
  }

  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#F0EFE8]">Transacciones</h1>
        <HeaderActions />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {filtered.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="border-[rgba(255,255,255,0.06)] text-[#8A877D] hover:text-[#C8C6BC]"
            onClick={() => {
              // Export CSV es Pro: para Free redirige al upsell en vez de exportar.
              if (!canAccess(user.plan, 'export')) { window.location.href = '/dashboard/pro'; return; }
              exportCSV();
            }}
            title={canAccess(user.plan, 'export') ? 'Exportar a CSV' : 'Exportar CSV es Pro'}
          >
            <Download className="h-4 w-4 mr-1.5" />
            CSV
            {!canAccess(user.plan, 'export') && (
              <Crown className="h-3 w-3 ml-1.5" style={{ color: '#68dbae' }} />
            )}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="border-[rgba(255,255,255,0.06)] text-[#8A877D] hover:text-[#C8C6BC]"
          onClick={() => {
            // Carga masiva Excel/CSV es Pro: Free redirige al upsell.
            if (!canAccess(user.plan, 'excel_upload')) { window.location.href = '/dashboard/pro'; return; }
            setImportOpen(true);
          }}
          title={canAccess(user.plan, 'excel_upload') ? 'Importar Excel/CSV' : 'Carga masiva es Pro'}
        >
          <Upload className="h-4 w-4 mr-1.5" />
          Importar
          {!canAccess(user.plan, 'excel_upload') && (
            <Crown className="h-3 w-3 ml-1.5" style={{ color: '#68dbae' }} />
          )}
        </Button>
        <Button
          variant="outline"
          className="border-[rgba(255,255,255,0.06)] text-[#C8C6BC]"
          onClick={() => openCreate('ingreso')}
        >
          <Plus className="h-4 w-4" data-icon="inline-start" />
          Nuevo ingreso
        </Button>
        <Button
          className="bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white"
          onClick={() => openCreate('gasto')}
        >
          <Plus className="h-4 w-4" data-icon="inline-start" />
          Nuevo gasto
        </Button>
      </div>

      {/* View mode tabs + period selector — same row on all breakpoints.
          Solo se desactiva con "Por revisar" en alcance global (ahi el filtro barre
          todos los meses y el selector no aplica). En alcance por periodo el selector
          sigue vivo para poder revisar mes por mes. */}
      <div
        className={`flex flex-row items-center justify-between gap-3 ${
          periodBloqueado ? 'pointer-events-none opacity-40' : ''
        }`}
        aria-hidden={periodBloqueado}
      >
        <Tabs value={viewMode} onValueChange={(val) => { setViewMode(val as 'mensual' | 'anual'); setPage(1); }}>
          <TabsList>
            <TabsTrigger value="mensual">Mensual</TabsTrigger>
            <TabsTrigger value="anual">Anual</TabsTrigger>
          </TabsList>
        </Tabs>

        {viewMode === 'mensual' && <MonthSelector />}

        {viewMode === 'anual' && (
          <Select value={String(annualYear)} onValueChange={(val) => { setAnnualYear(Number(val)); setPage(1); }}>
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
          <div className="flex items-center gap-2 mb-1.5">
            <TrendingDown className="h-4 w-4 text-[#D85A30]" />
            <span className="text-label text-[#8A877D]">
              {hasActiveFilters ? 'Gastos (filtrado)' : viewMode === 'anual' ? 'Gastos del año' : 'Gastos del mes'}
            </span>
          </div>
          <CurrencyDisplay amount={summary.totalGastos} className="text-[#D85A30]" size="md" />
        </div>
        </StaggerItem>
        <StaggerItem>
        <div className="glass-card glass-card-glow p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <TrendingUp className="h-4 w-4 text-[#1D9E75]" />
            <span className="text-label text-[#8A877D]">
              {hasActiveFilters ? 'Ingresos (filtrado)' : viewMode === 'anual' ? 'Ingresos del año' : 'Ingresos del mes'}
            </span>
          </div>
          <CurrencyDisplay amount={summary.totalIngresos} className="text-[#1D9E75]" size="md" />
        </div>
        </StaggerItem>
        <StaggerItem>
        <div className="glass-card glass-card-glow p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <Receipt className="h-4 w-4 text-[#378ADD]" />
            <span className="text-label text-[#8A877D]">Transacciones</span>
          </div>
          <span className="text-xl font-semibold text-[#F0EFE8]">{summary.count}</span>
        </div>
        </StaggerItem>
      </StaggerContainer>

      {/* Insight banner */}
      {transactions.length >= 5 && summary.totalGastos > 0 && (() => {
        const catMap: Record<string, number> = {};
        for (const t of transactions) {
          if (t.tipo === 'gasto') catMap[t.categoria] = (catMap[t.categoria] || 0) + t.monto_pen;
        }
        const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
        if (!topCat) return null;
        const pct = Math.round((topCat[1] / summary.totalGastos) * 100);
        return (
          <div className="flex items-center gap-2 rounded-xl bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.04)] px-4 py-2.5">
            <span className="text-sm">{getCategoriaEmoji(topCat[0])}</span>
            <p className="text-xs text-[#8A877D]">
              <span className="text-[#C8C6BC] font-medium">{topCat[0]}</span> representa el {pct}% de tus gastos este {viewMode === 'anual' ? 'año' : 'mes'} ({formatCurrency(topCat[1])})
            </p>
          </div>
        );
      })()}

      {/* Por revisar — el banner se acota al periodo visible (matchea el contexto) y
          ofrece un escape hatch al backlog global de otros meses. */}
      {(() => {
        if (porRevisarGlobalCount === 0) return null;
        const periodLabel = viewMode === 'anual' ? String(selectedYear) : MESES[selectedMonth];
        const plural = (n: number) => (n === 1 ? 'transaccion' : 'transacciones');
        const scopeGlobal = porRevisarActive && porRevisarScope === 'global';

        // Nada en el periodo y filtro inactivo → solo un aviso discreto (no el amber
        // alarmante) que mantiene el acceso al backlog sin ensuciar el mes limpio.
        if (!porRevisarActive && porRevisarPeriodCount === 0) {
          return (
            <button
              onClick={() => activarPorRevisar('global')}
              className="flex w-full items-center gap-2 rounded-xl border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.02)] px-4 py-2.5 text-left transition-colors hover:bg-[rgba(255,255,255,0.04)]"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-[#8A877D]" />
              <p className="min-w-0 flex-1 text-xs text-[#8A877D]">
                {porRevisarGlobalCount} {plural(porRevisarGlobalCount)} por revisar en otros meses
              </p>
              <span className="shrink-0 text-xs font-medium text-[#EF9F27]">Ver todas</span>
            </button>
          );
        }

        const mainCount = scopeGlobal ? porRevisarGlobalCount : porRevisarPeriodCount;
        return (
          <div
            className={`rounded-xl border px-4 py-3 transition-colors ${
              porRevisarActive
                ? 'border-[rgba(239,159,39,0.45)] bg-[rgba(239,159,39,0.12)]'
                : 'border-[rgba(239,159,39,0.2)] bg-[rgba(239,159,39,0.06)]'
            }`}
          >
            <button
              onClick={() => (porRevisarActive ? desactivarPorRevisar() : activarPorRevisar('periodo'))}
              aria-pressed={porRevisarActive}
              className="flex w-full items-center gap-3 text-left"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-[#EF9F27]" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[#F0EFE8]">
                  {mainCount} {plural(mainCount)} por revisar{!scopeGlobal && ` en ${periodLabel}`}
                </p>
                <p className="text-xs text-[#8A877D]">
                  {porRevisarActive
                    ? scopeGlobal
                      ? 'Mostrando las de todos los meses. Toca para volver.'
                      : `Mostrando las de ${periodLabel}. Toca para volver.`
                    : 'Neto no supo en que categoria ponerlas. Toca para verlas y ajustarlas.'}
                </p>
              </div>
              <Badge
                variant="outline"
                className="shrink-0 border-[rgba(239,159,39,0.35)] bg-[rgba(239,159,39,0.1)] text-xs text-[#EF9F27]"
              >
                {porRevisarActive ? 'Filtrando' : 'Revisar'}
              </Badge>
            </button>
            {porRevisarOtherCount > 0 && !scopeGlobal && (
              <button
                onClick={() => activarPorRevisar('global')}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[#8A877D] transition-colors hover:text-[#EF9F27]"
              >
                +{porRevisarOtherCount} en otros meses · ver todas
              </button>
            )}
          </div>
        );
      })()}

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
        userCategorias={userCategorias}
      />

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between rounded-xl bg-[rgba(29,158,117,0.08)] border border-[rgba(29,158,117,0.2)] px-4 py-2.5">
            <span className="text-sm text-[#1D9E75] font-medium">
              {selectedIds.size} seleccionada{selectedIds.size !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-[#8A877D] hover:text-[#C8C6BC]"
                onClick={() => { setSelectedIds(new Set()); setBulkEditOpen(false); }}
              >
                Cancelar
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-[rgba(29,158,117,0.3)] text-[#1D9E75] hover:bg-[rgba(29,158,117,0.1)]"
                onClick={() => setBulkEditOpen(!bulkEditOpen)}
              >
                <Settings2 className="h-3.5 w-3.5 mr-1.5" />
                Editar
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                {bulkDeleting ? 'Eliminando...' : 'Eliminar'}
              </Button>
            </div>
          </div>

          {/* Bulk edit panel */}
          {bulkEditOpen && (
            <div className="glass-card p-4 space-y-3 border-[rgba(29,158,117,0.2)]">
              <p className="text-xs text-[#8A877D]">
                Solo se actualizan los campos que selecciones. Los demas quedan igual.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {/* Método de pago */}
                <div className="space-y-1">
                  <label className="text-xs text-[#8A877D]">Metodo de pago</label>
                  <Select value={bulkEditFields.metodo_pago} onValueChange={(v) => setBulkEditFields(prev => ({ ...prev, metodo_pago: v ?? '' }))}>
                    <SelectTrigger className="h-9 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)] text-[#C8C6BC] text-sm">
                      <SelectValue placeholder="Sin cambiar" />
                    </SelectTrigger>
                    <SelectContent>
                      {['Debito', 'Credito', 'Yape', 'Plin', 'Transferencia', 'Efectivo'].map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Banco */}
                <div className="space-y-1">
                  <label className="text-xs text-[#8A877D]">Banco</label>
                  <Select value={bulkEditFields.banco} onValueChange={(v) => setBulkEditFields(prev => ({ ...prev, banco: v ?? '' }))}>
                    <SelectTrigger className="h-9 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)] text-[#C8C6BC] text-sm">
                      <SelectValue placeholder="Sin cambiar" />
                    </SelectTrigger>
                    <SelectContent>
                      {['BCP', 'BBVA', 'Interbank', 'Scotiabank', 'Falabella', 'Ripley', 'BanBif', 'Mibanco'].map((b) => (
                        <SelectItem key={b} value={b}>{b}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Categoría */}
                <div className="space-y-1">
                  <label className="text-xs text-[#8A877D]">Categoria</label>
                  <Select value={bulkEditFields.categoria} onValueChange={(v) => setBulkEditFields(prev => ({ ...prev, categoria: v ?? '', subcategoria: '' }))}>
                    <SelectTrigger className="h-9 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)] text-[#C8C6BC] text-sm">
                      <SelectValue placeholder="Sin cambiar" />
                    </SelectTrigger>
                    <SelectContent>
                      {userCategorias.map((c) => (
                        <SelectItem key={c.nombre} value={c.nombre}>{c.emoji} {c.nombre}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Subcategoría */}
                <div className="space-y-1">
                  <label className="text-xs text-[#8A877D]">Subcategoria</label>
                  <Select
                    value={bulkEditFields.subcategoria}
                    onValueChange={(v) => setBulkEditFields(prev => ({ ...prev, subcategoria: v ?? '' }))}
                    disabled={!bulkEditFields.categoria || bulkEditSubs.length === 0}
                  >
                    <SelectTrigger className="h-9 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)] text-[#C8C6BC] text-sm">
                      <SelectValue placeholder={!bulkEditFields.categoria ? 'Elige categoria primero' : 'Sin cambiar'} />
                    </SelectTrigger>
                    <SelectContent>
                      {bulkEditSubs.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  className="bg-[#1D9E75] text-white hover:bg-[#178a64]"
                  onClick={handleBulkEdit}
                  disabled={bulkEditing}
                >
                  {bulkEditing ? 'Actualizando...' : `Aplicar a ${selectedIds.size} transacciones`}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[#8A877D]"
                  onClick={() => {
                    setBulkEditFields({ metodo_pago: '', banco: '', categoria: '', subcategoria: '' });
                  }}
                >
                  Limpiar
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Transaction list */}
      {filtered.length === 0 ? (
        <EmptyState
          title={transactions.length === 0 ? 'Sin transacciones' : 'Sin resultados'}
          description={
            transactions.length === 0
              ? 'Envia tus comprobantes por WhatsApp y NETO los registra automaticamente.'
              : 'No se encontraron transacciones con los filtros seleccionados. Prueba ajustando los filtros.'
          }
          icon={transactions.length === 0 ? Receipt : Search}
          showWhatsApp={false}
          actions={transactions.length === 0 ? [
            { label: 'Registra por WhatsApp', href: SOCIAL_LINKS.whatsapp, external: true },
            { label: 'Agregar manual', href: '#', variant: 'secondary' as const },
          ] : undefined}
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block glass-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-[rgba(255,255,255,0.06)] hover:bg-transparent">
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={paginated.length > 0 && selectedIds.size === paginated.length}
                      onChange={toggleSelectAll}
                      className="h-3.5 w-3.5 rounded border-[#8A877D] accent-[#1D9E75] cursor-pointer"
                    />
                  </TableHead>
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
                    selected={selectedIds.has(tx.id)}
                    onToggleSelect={() => toggleSelect(tx.id)}
                    onEdit={() => setEditTransaction(tx)}
                    onDelete={() => setDeleteTransaction(tx)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-2">
            {paginated.map((tx, index) => (
              <motion.div
                key={tx.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1], delay: Math.min(index, 9) * 0.04 }}
              >
                <TransactionCard
                  tx={tx}
                  selected={selectedIds.has(tx.id)}
                  onToggleSelect={() => toggleSelect(tx.id)}
                  onEdit={() => setEditTransaction(tx)}
                  onDelete={() => setDeleteTransaction(tx)}
                />
              </motion.div>
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
                  className="border-[rgba(255,255,255,0.06)] text-[#C8C6BC] transition-all duration-150"
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
                        ? 'bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white border-[#1D9E75] transition-all duration-150'
                        : 'border-[rgba(255,255,255,0.06)] text-[#C8C6BC] transition-all duration-150'
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
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={refreshTransactions}
      />

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
  selected,
  onToggleSelect,
  onEdit,
  onDelete,
}: {
  tx: Transaccion;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isIngreso = tx.tipo === 'ingreso';
  const emoji = getCategoriaEmoji(tx.categoria);

  return (
    <TableRow className={`border-[rgba(255,255,255,0.06)] hover:bg-white/[0.03] transition-colors duration-150 ${selected ? 'bg-[rgba(29,158,117,0.06)]' : ''}`}>
      <TableCell>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="h-3.5 w-3.5 rounded border-[#8A877D] accent-[#1D9E75] cursor-pointer"
        />
      </TableCell>
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
      <TableCell className="text-xs text-[#8A877D]">{getMetodoIcon(normalizeMetodoPago(tx.metodo_pago, tx.banco))} {normalizeMetodoPago(tx.metodo_pago, tx.banco)}{formatLast4(tx.tarjeta_last4)}</TableCell>
      <TableCell>
        <span
          className={`text-sm font-semibold tabular-nums ${isIngreso ? 'shadow-[0_0_8px_rgba(29,158,117,0.2)]' : 'shadow-[0_0_8px_rgba(239,159,39,0.15)]'}`}
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
  selected,
  onToggleSelect,
  onEdit,
  onDelete,
}: {
  tx: Transaccion;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isIngreso = tx.tipo === 'ingreso';
  const emoji = getCategoriaEmoji(tx.categoria);

  return (
    <div
      className={`glass-card p-4 border-l-2 transition-colors hover:bg-[rgba(255,255,255,0.02)] ${selected ? 'bg-[rgba(29,158,117,0.06)]' : ''}`}
      style={{ borderLeftColor: isIngreso ? '#1D9E75' : '#D85A30' }}
    >
      <div className="flex items-start justify-between gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="h-3.5 w-3.5 mt-1 rounded border-[#8A877D] accent-[#1D9E75] cursor-pointer shrink-0"
        />
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
              <span className="text-xs text-[#8A877D]">&middot; {getMetodoIcon(normalizeMetodoPago(tx.metodo_pago, tx.banco))} {normalizeMetodoPago(tx.metodo_pago, tx.banco)}{formatLast4(tx.tarjeta_last4)}</span>
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
