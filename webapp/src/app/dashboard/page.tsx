'use client';

import { useMemo, useState, useCallback, lazy, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Receipt, CreditCard, Pencil, ChevronDown } from 'lucide-react';
import { motion } from 'motion/react';
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { KPICards } from '@/components/dashboard/kpi-cards';
import { InsightCard, generateInsight } from '@/components/dashboard/insight-card';
import { CategoryDonut } from '@/components/charts/category-donut';
import { TrendLine } from '@/components/charts/trend-line';
import { ScoreTrend } from '@/components/charts/score-trend';
import { SpendingProjection } from '@/components/dashboard/spending-projection';
import { ExchangeRateWidget } from '@/components/dashboard/exchange-rate-widget';
import { QuickActions } from '@/components/dashboard/quick-actions';
import { TodaySpending } from '@/components/dashboard/today-spending';

// Lazy load below-the-fold heavy components
const FinancialCalendar = lazy(() => import('@/components/charts/financial-calendar').then(m => ({ default: m.FinancialCalendar })));
const CategoryComparison = lazy(() => import('@/components/charts/category-comparison').then(m => ({ default: m.CategoryComparison })));
const TopMerchants = lazy(() => import('@/components/dashboard/top-merchants').then(m => ({ default: m.TopMerchants })));
const PaymentMethodDonut = lazy(() => import('@/components/charts/payment-method-donut').then(m => ({ default: m.PaymentMethodDonut })));
const RecurringPayments = lazy(() => import('@/components/dashboard/recurring-payments').then(m => ({ default: m.RecurringPayments })));
import { TransactionForm } from '@/components/dashboard/transaction-form';
import { GlobalSearch } from '@/components/dashboard/global-search';
import { UserMenu } from '@/components/dashboard/user-menu';
import { WelcomeModal } from '@/components/dashboard/welcome-modal';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { formatCurrency, formatFecha, calcularScoreFinanciero, getScoreColor, getScoreLabel } from '@/lib/utils';
import { getCategoriaEmoji, MESES, SOCIAL_LINKS } from '@/lib/constants';
import { capitalizeDisplay, normalizeMetodoPago, getMetodoIcon } from '@/lib/format';
import { detectSubscriptions, TIPO_LABELS } from '@/lib/subscriptions-catalog';
import type { Transaccion, KPIData, CategoriaGasto, TendenciaMensual } from '@/lib/types';

export default function DashboardPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const searchParams = useSearchParams();

  const now = new Date();
  const monthParam = searchParams.get('mes');
  const [currentYear, currentMonth] = monthParam
    ? monthParam.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

  const [viewMode, setViewMode] = useState<string>('mensual');
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [showScoreDialog, setShowScoreDialog] = useState(false);
  const [detailCategoria, setDetailCategoria] = useState<string | null>(null);
  const [detailMetodo, setDetailMetodo] = useState<string | null>(null);
  const [detailComercio, setDetailComercio] = useState<string | null>(null);
  const [editTransaction, setEditTransaction] = useState<Transaccion | null>(null);
  const [showMoreWidgets, setShowMoreWidgets] = useState(false);
  const queryClient = useQueryClient();

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
  }, [queryClient]);

  // Load ALL transactions for the user (enables both monthly and annual views + trend chart)
  const { data: allTransactions = [], isLoading: txLoading } = useTransactions({
    usuarioId: user?.id,
  });

  // Load budgets for score calculation (presupuestos excedidos)
  const { data: budgets = [] } = useBudgets(user?.id);

  // Compute available years from transaction data
  const availableYears = useMemo(() => {
    const yearSet = new Set<number>();
    for (const t of allTransactions) {
      const y = new Date(t.fecha + 'T00:00:00').getFullYear();
      yearSet.add(y);
    }
    yearSet.add(now.getFullYear());
    return Array.from(yearSet).sort((a, b) => b - a);
  }, [allTransactions]);

  // Filter transactions based on viewMode
  const transactions = useMemo(() => {
    return allTransactions.filter((t) => {
      const txDate = new Date(t.fecha + 'T00:00:00');
      if (viewMode === 'anual') {
        return txDate.getFullYear() === selectedYear;
      }
      return txDate.getMonth() + 1 === currentMonth && txDate.getFullYear() === currentYear;
    });
  }, [allTransactions, viewMode, currentMonth, currentYear, selectedYear]);

  // Compute KPI data
  const kpiData = useMemo<KPIData>(() => {
    const totalIngresos = transactions
      .filter((t) => t.tipo === 'ingreso')
      .reduce((sum, t) => sum + t.monto_pen, 0);
    const totalGastos = transactions
      .filter((t) => t.tipo === 'gasto')
      .reduce((sum, t) => sum + t.monto_pen, 0);
    const ahorro = totalIngresos - totalGastos;
    const ahorroPorcentaje = totalIngresos > 0 ? (ahorro / totalIngresos) * 100 : 0;

    // Count exceeded budgets (category-level only, not subcategory)
    const categoryBudgets = budgets.filter(b => !b.subcategoria);
    let presExcedidos = 0;
    for (const b of categoryBudgets) {
      const gastado = transactions
        .filter(t => t.tipo === 'gasto' && t.categoria?.toLowerCase() === b.categoria?.toLowerCase())
        .reduce((s, t) => s + t.monto_pen, 0);
      if (gastado > parseFloat(String(b.monto_limite))) presExcedidos++;
    }

    const scoreFinanciero = calcularScoreFinanciero(totalGastos, totalIngresos, presExcedidos);

    // Previous month data for comparison (only in monthly view)
    let prevGastos: number | undefined;
    let prevIngresos: number | undefined;
    if (viewMode === 'mensual') {
      const prevDate = new Date(currentYear, currentMonth - 2, 1);
      const pm = prevDate.getMonth() + 1;
      const py = prevDate.getFullYear();
      const prevTxs = allTransactions.filter((t) => {
        const d = new Date(t.fecha + 'T00:00:00');
        return d.getMonth() + 1 === pm && d.getFullYear() === py;
      });
      prevGastos = prevTxs.filter(t => t.tipo === 'gasto').reduce((s, t) => s + t.monto_pen, 0);
      prevIngresos = prevTxs.filter(t => t.tipo === 'ingreso').reduce((s, t) => s + t.monto_pen, 0);
    }

    return { totalIngresos, totalGastos, ahorro, ahorroPorcentaje, scoreFinanciero, prevGastos, prevIngresos };
  }, [transactions, budgets, allTransactions, viewMode, currentMonth, currentYear]);

  // Sparkline data: daily totals for last 30 days of current view
  const sparklines = useMemo(() => {
    if (viewMode !== 'mensual') return undefined;
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
    const ingresos: number[] = [];
    const gastos: number[] = [];
    const ahorro: number[] = [];

    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayTxs = transactions.filter(t => t.fecha === key);
      const dayIng = dayTxs.filter(t => t.tipo === 'ingreso').reduce((s, t) => s + t.monto_pen, 0);
      const dayGas = dayTxs.filter(t => t.tipo === 'gasto').reduce((s, t) => s + t.monto_pen, 0);
      ingresos.push(dayIng);
      gastos.push(dayGas);
      ahorro.push(dayIng - dayGas);
    }

    // Cumulative for score approximation (running savings rate)
    let cumIng = 0;
    let cumGas = 0;
    const score = ingresos.map((ing, i) => {
      cumIng += ing;
      cumGas += gastos[i];
      const ratio = cumIng > 0 ? cumGas / cumIng : 1;
      return Math.max(0, Math.min(100, 75 + (ratio <= 0.7 ? 15 : ratio <= 0.9 ? -5 : -15)));
    });

    return { ingresos, gastos, ahorro, score };
  }, [transactions, viewMode, currentMonth, currentYear]);

  // Compute category breakdown (gastos only)
  const categoryData = useMemo<CategoriaGasto[]>(() => {
    const gastos = transactions.filter((t) => t.tipo === 'gasto');
    const totalGastos = gastos.reduce((sum, t) => sum + t.monto_pen, 0);
    if (totalGastos === 0) return [];

    const map = new Map<string, { total: number; count: number }>();
    for (const t of gastos) {
      const prev = map.get(t.categoria) || { total: 0, count: 0 };
      map.set(t.categoria, { total: prev.total + t.monto_pen, count: prev.count + 1 });
    }

    return Array.from(map.entries())
      .map(([categoria, { total, count }]) => ({
        categoria,
        emoji: getCategoriaEmoji(categoria),
        total,
        porcentaje: (total / totalGastos) * 100,
        transacciones: count,
      }))
      .sort((a, b) => b.total - a.total);
  }, [transactions]);

  // Trend data from real transactions (last 4 months)
  const trendData = useMemo<TendenciaMensual[]>(() => {
    const months: TendenciaMensual[] = [];
    for (let i = 3; i >= 0; i--) {
      const d = new Date(currentYear, currentMonth - 1 - i, 1);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();
      const monthTxs = allTransactions.filter((t) => {
        const txDate = new Date(t.fecha + 'T00:00:00');
        return txDate.getMonth() + 1 === m && txDate.getFullYear() === y;
      });
      months.push({
        mes: MESES[m],
        mesNum: m,
        anio: y,
        gastos: monthTxs.filter((t) => t.tipo === 'gasto').reduce((s, t) => s + t.monto_pen, 0),
        ingresos: monthTxs.filter((t) => t.tipo === 'ingreso').reduce((s, t) => s + t.monto_pen, 0),
      });
    }
    return months;
  }, [allTransactions, currentMonth, currentYear]);

  // Detect subscriptions from catalog patterns only
  const subscriptions = useMemo(() => {
    return detectSubscriptions(allTransactions);
  }, [allTransactions]);

  // Generate AI-like insight from transaction data
  const insightText = useMemo(() => {
    if (transactions.length === 0) return undefined;
    const subsTotal = subscriptions.reduce((s, sub) => s + sub.monthlyAmount, 0);
    return generateInsight({
      totalGastos: kpiData.totalGastos,
      totalIngresos: kpiData.totalIngresos,
      categorias: categoryData,
      scoreFinanciero: kpiData.scoreFinanciero,
      transactionCount: transactions.length,
      subscriptionTotal: subsTotal > 0 ? subsTotal : undefined,
    });
  }, [transactions, kpiData, categoryData, subscriptions]);

  // Detail transactions for payment method dialog
  const detailMetodoTransactions = useMemo(() => {
    if (!detailMetodo) return [];
    return transactions.filter((t) => t.tipo === 'gasto' && normalizeMetodoPago(t.metodo_pago, t.banco) === detailMetodo)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [transactions, detailMetodo]);

  // Detail transactions for merchant dialog
  const detailComercioTransactions = useMemo(() => {
    if (!detailComercio) return [];
    return transactions.filter((t) => t.tipo === 'gasto' && (t.comercio || 'Sin comercio') === detailComercio)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [transactions, detailComercio]);

  // User categories for TransactionForm
  const userCategorias = useMemo(() => {
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

  const isLoading = userLoading || txLoading;

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-10 w-10 rounded-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-[320px] rounded-2xl" />
          <Skeleton className="h-[320px] rounded-2xl" />
        </div>
        <Skeleton className="h-[300px] rounded-2xl" />
      </div>
    );
  }

  // Empty state when no user or no transactions
  if (!user) {
    return (
      <>
        <EmptyState
          title="Inicia sesion para ver tu dashboard"
          description="Conecta tu cuenta de Google para visualizar tus finanzas personales."
          showWhatsApp={false}
        />
      </>
    );
  }

  const hasTransactions = transactions.length > 0;

  return (
    <div className="space-y-6">
      {/* Welcome header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#F0EFE8]">
            {(() => {
              const hour = new Date().getHours();
              const greeting = hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches';
              const name = user.nombre || (user.email ? user.email.split('@')[0] : '');
              return name ? `${greeting}, ${name}` : greeting;
            })()}
          </h1>
          <p className="text-sm text-[#8A877D] mt-1">
            Tu resumen financiero &mdash; {viewMode === 'anual' ? `Año ${selectedYear}` : `${MESES[currentMonth]} ${currentYear}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <GlobalSearch />
          <UserMenu />
        </div>
      </div>

      {/* View mode toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as string)}>
          <TabsList className="glass-card border-0">
            <TabsTrigger value="mensual">Mensual</TabsTrigger>
            <TabsTrigger value="anual">Total anual</TabsTrigger>
          </TabsList>
        </Tabs>

        {viewMode === 'anual' && (
          <Select value={String(selectedYear)} onValueChange={(val) => setSelectedYear(Number(val))}>
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

        {viewMode === 'mensual' && (
          <div className="sm:ml-auto">
            <MonthSelector />
          </div>
        )}
      </div>

      {!hasTransactions ? (
        allTransactions.length === 0 ? (
          /* First-time user onboarding checklist */
          <FadeIn>
          <div className="glass-card glass-card-glow p-6 max-w-lg mx-auto">
            <h3 className="text-lg font-semibold text-[#F0EFE8] mb-1">Bienvenido a NETO</h3>
            <p className="text-sm text-[#8A877D] mb-5">Completa estos pasos para empezar a ver tus finanzas:</p>
            <div className="space-y-3">
              {[
                { done: true, label: 'Crear tu cuenta', sub: 'Listo — ya estás aquí' },
                { done: !!user?.email, label: 'Conectar tu Gmail', sub: 'NETO lee tus correos bancarios automáticamente', href: '/dashboard/configuracion' },
                { done: false, label: 'Registrar tu primer gasto', sub: 'Envía un comprobante por WhatsApp o agrega uno manual', href: SOCIAL_LINKS.whatsapp, external: true },
              ].map((step, i) => (
                <a
                  key={i}
                  href={step.href}
                  target={step.external ? '_blank' : undefined}
                  rel={step.external ? 'noopener noreferrer' : undefined}
                  className={`flex items-start gap-3 rounded-xl p-3 transition-all ${step.done ? 'opacity-60' : 'hover:bg-[rgba(255,255,255,0.03)] cursor-pointer'}`}
                >
                  <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${step.done ? 'bg-[#1D9E75] text-white' : 'border border-[#8A877D] text-[#8A877D]'}`}>
                    {step.done ? '✓' : i + 1}
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${step.done ? 'text-[#8A877D] line-through' : 'text-[#F0EFE8]'}`}>{step.label}</p>
                    <p className="text-xs text-[#8A877D]">{step.sub}</p>
                  </div>
                </a>
              ))}
            </div>
          </div>
          </FadeIn>
        ) : (
          <EmptyState
            title="Sin transacciones este mes"
            description="Envia tus comprobantes por WhatsApp y NETO los registra automaticamente. Tambien puedes agregar gastos manualmente."
            showWhatsApp={false}
            actions={[
              { label: 'Registra por WhatsApp', href: SOCIAL_LINKS.whatsapp, external: true },
              { label: 'Ver transacciones', href: '/dashboard/transacciones', variant: 'secondary' as const },
            ]}
          />
        )
      ) : (
        <>
          {/* Quick actions */}
          <QuickActions />

          {/* KPI cards */}
          <KPICards data={kpiData} sparklines={sparklines} onScoreClick={() => setShowScoreDialog(true)} />

          {/* Projection + Today spending + Exchange rate row */}
          {viewMode === 'mensual' && (
            <FadeIn delay={0.12}>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-4">
              <SpendingProjection
                transactions={transactions}
                allTransactions={allTransactions}
                currentMonth={currentMonth}
                currentYear={currentYear}
              />
              <TodaySpending
                transactions={allTransactions}
                currentMonth={currentMonth}
                currentYear={currentYear}
              />
              <ExchangeRateWidget />
            </div>
            </FadeIn>
          )}

          {/* Charts row */}
          <FadeIn delay={0.2}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TrendLine data={trendData} />
            <CategoryDonut data={categoryData} onCategoryClick={setDetailCategoria} />
          </div>
          </FadeIn>

          {/* Score trend + AI insight */}
          {viewMode === 'mensual' && (
            <FadeIn delay={0.22}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <ScoreTrend
                allTransactions={allTransactions}
                budgets={budgets}
                currentMonth={currentMonth}
                currentYear={currentYear}
              />
              <InsightCard
                insight={insightText}
                aiContext={{
                  totalGastos: kpiData.totalGastos,
                  totalIngresos: kpiData.totalIngresos,
                  topCategorias: categoryData.slice(0, 3).map(c => `${c.categoria} (${Math.round(c.porcentaje)}%)`).join(', '),
                  scoreFinanciero: kpiData.scoreFinanciero,
                  subscriptionTotal: subscriptions.reduce((s, sub) => s + sub.monthlyAmount, 0) || undefined,
                }}
              />
            </div>
            </FadeIn>
          )}

          {/* Collapsible detailed widgets — expanded on desktop, toggle on mobile */}
          {viewMode === 'mensual' && (
            <>
              {/* Mobile toggle button */}
              <button
                onClick={() => setShowMoreWidgets(!showMoreWidgets)}
                className="flex md:hidden items-center justify-center gap-2 w-full rounded-xl border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] py-2.5 text-xs font-medium text-[#C8C6BC] transition-colors hover:bg-[rgba(255,255,255,0.04)]"
              >
                {showMoreWidgets ? 'Ocultar detalles' : 'Ver mas detalles'}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showMoreWidgets ? 'rotate-180' : ''}`} />
              </button>

              <div className={`space-y-6 ${showMoreWidgets ? '' : 'hidden md:block'}`}>
                {/* Top merchants + Payment methods */}
                <Suspense fallback={<Skeleton className="h-[300px] rounded-2xl" />}>
                <FadeIn delay={0.25}>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <TopMerchants transactions={transactions} onMerchantClick={setDetailComercio} />
                  <PaymentMethodDonut transactions={transactions} onMethodClick={setDetailMetodo} />
                </div>
                </FadeIn>
                </Suspense>

                {/* Financial calendar + Category comparison */}
                <Suspense fallback={<Skeleton className="h-[300px] rounded-2xl" />}>
                <FadeIn delay={0.3}>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <FinancialCalendar
                    transactions={allTransactions}
                    currentMonth={currentMonth}
                    currentYear={currentYear}
                  />
                  <CategoryComparison
                    allTransactions={allTransactions}
                    currentMonth={currentMonth}
                    currentYear={currentYear}
                    onCategoryClick={setDetailCategoria}
                  />
                </div>
                </FadeIn>
                </Suspense>

              </div>
            </>
          )}

          {/* Transacciones Recientes */}
          <FadeIn delay={0.35}>
            <div className="glass-card glass-card-glow p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-[#C8C6BC]">Transacciones Recientes</h3>
                <Link href="/dashboard/transacciones" className="text-xs text-[#1D9E75] hover:underline">Ver todas &rarr;</Link>
              </div>
              {transactions.length > 0 ? (
                <div className="space-y-1">
                  {transactions.slice(0, 8).map((tx) => {
                    const emoji = getCategoriaEmoji(tx.categoria);
                    const isIngreso = tx.tipo === 'ingreso';
                    return (
                      <div
                        key={tx.id}
                        className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all hover:bg-[rgba(255,255,255,0.03)] hover:translate-x-1"
                      >
                        <span className="text-xs text-[#8A877D] w-[72px] shrink-0">{formatFecha(tx.fecha)}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(255,255,255,0.05)] px-2 py-0.5 text-xs text-[#C8C6BC] shrink-0">
                          {emoji} {tx.categoria}
                        </span>
                        <span className="truncate text-sm text-[#F0EFE8] flex-1 min-w-0">
                          {tx.comercio || tx.descripcion_original || tx.subcategoria}
                        </span>
                        <span
                          className="text-sm font-semibold tabular-nums shrink-0"
                          style={{ color: isIngreso ? '#1D9E75' : '#D85A30' }}
                        >
                          {isIngreso ? '+' : '-'}{formatCurrency(tx.monto_pen)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <Receipt className="h-6 w-6 text-[#8A877D]/50 mb-2" />
                  <p className="text-sm text-[#8A877D]">Sin transacciones recientes</p>
                  <a href={SOCIAL_LINKS.whatsapp} target="_blank" rel="noopener noreferrer" className="text-xs text-[#1D9E75] hover:underline mt-1">Registra tu primer gasto</a>
                </div>
              )}
            </div>
          </FadeIn>

          {/* Pagos Recurrentes + Suscripciones side by side */}
          <FadeIn delay={0.4}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Pagos Recurrentes */}
            <Suspense fallback={<Skeleton className="h-[200px] rounded-2xl" />}>
              <RecurringPayments transactions={allTransactions} />
            </Suspense>

            {/* Suscripciones */}
            <div className="glass-card glass-card-glow p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-[#C8C6BC]">Suscripciones detectadas</span>
                <Link href="/dashboard/suscripciones" className="text-xs text-[#1D9E75] hover:underline">Ver todas &rarr;</Link>
              </div>
              {subscriptions.length > 0 ? (
                <div className="space-y-3">
                  {subscriptions.slice(0, 8).map((sub) => (
                    <div key={sub.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 -mx-2 transition-all hover:bg-[rgba(255,255,255,0.03)]">
                      <div>
                        <p className="text-sm text-[#F0EFE8]">{sub.icono} {sub.nombre}</p>
                        <p className="text-xs text-[#8A877D]">{sub.monthsDetected} meses &middot; ~{formatCurrency(sub.monthlyAmount)}/mes</p>
                      </div>
                      <p className="text-sm text-[#D85A30] font-medium tabular-nums">{formatCurrency(sub.annualProjection)}/año</p>
                    </div>
                  ))}
                  <div className="border-t border-[rgba(255,255,255,0.06)] pt-3 flex justify-between">
                    <p className="text-sm font-medium text-[#C8C6BC]">Total proyectado anual</p>
                    <p className="text-sm font-bold text-[#D85A30]">{formatCurrency(subscriptions.reduce((s, sub) => s + sub.annualProjection, 0))}</p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <CreditCard className="h-6 w-6 text-[#8A877D]/50 mb-2" />
                  <p className="text-sm text-[#8A877D]">No se detectaron suscripciones</p>
                  <p className="text-xs text-[#8A877D]/70 mt-1">NETO las detecta automaticamente de tus transacciones</p>
                </div>
              )}
            </div>
          </div>
          </FadeIn>
        </>
      )}

      {/* Category detail dialog */}
      <Dialog open={!!detailCategoria} onOpenChange={(open) => { if (!open) setDetailCategoria(null); }}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detailCategoria && `${getCategoriaEmoji(detailCategoria)} ${detailCategoria}`}
            </DialogTitle>
          </DialogHeader>
          {detailCategoria && (() => {
            const catTxs = transactions
              .filter((t) => t.tipo === 'gasto' && t.categoria === detailCategoria)
              .sort((a, b) => b.fecha.localeCompare(a.fecha));
            const catTotal = catTxs.reduce((s, t) => s + t.monto_pen, 0);
            return (
              <div className="space-y-3">
                <p className="text-sm text-[#8A877D]">
                  Total: <span className="text-[#D85A30] font-medium">{formatCurrency(catTotal)}</span>
                  {' '}&mdash; {catTxs.length} transacci{catTxs.length === 1 ? 'on' : 'ones'}
                </p>
                {catTxs.length > 0 ? (
                  <div className="space-y-1">
                    {catTxs.slice(0, 15).map((tx) => (
                      <div key={tx.id} className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.04)] last:border-0">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-[#F0EFE8] truncate">{tx.comercio || tx.subcategoria || 'Sin comercio'}</p>
                          <p className="text-xs text-[#8A877D]">{formatFecha(tx.fecha)}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-3">
                          <span className="text-sm font-medium text-[#D85A30]">
                            -{formatCurrency(tx.monto_pen)}
                          </span>
                          <button
                            onClick={() => setEditTransaction(tx)}
                            className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                    {catTxs.length > 15 && (
                      <p className="text-xs text-[#8A877D] text-center pt-2">
                        y {catTxs.length - 15} transacciones mas...
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-[#8A877D] text-center py-4">Sin gastos en esta categoria</p>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Score Financiero dialog */}
      <Dialog open={showScoreDialog} onOpenChange={setShowScoreDialog}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
          <DialogHeader>
            <DialogTitle>Score Financiero</DialogTitle>
          </DialogHeader>

          {/* Score circle - large animated */}
          <div className="flex justify-center py-4">
            <div className="relative w-32 h-32">
              <svg viewBox="0 0 36 36" className="w-full h-full">
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke="#2A2A28" strokeWidth="3" />
                <motion.path
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke={getScoreColor(kpiData.scoreFinanciero)}
                  strokeWidth="3"
                  strokeLinecap="round"
                  initial={{ strokeDasharray: '0, 100' }}
                  animate={{ strokeDasharray: `${kpiData.scoreFinanciero}, 100` }}
                  transition={{ duration: 1.2, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.2 }}
                />
              </svg>
              <motion.div
                className="absolute inset-0 flex flex-col items-center justify-center"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 0.4 }}
              >
                <span className="text-3xl font-bold" style={{ color: getScoreColor(kpiData.scoreFinanciero) }}>{kpiData.scoreFinanciero}</span>
                <span className="text-xs text-[#8A877D]">de 100</span>
              </motion.div>
            </div>
          </div>

          {/* Status */}
          <div className="text-center mb-4">
            <span className="text-lg font-semibold" style={{ color: getScoreColor(kpiData.scoreFinanciero) }}>
              {getScoreLabel(kpiData.scoreFinanciero)}
            </span>
          </div>

          {/* Breakdown */}
          <div className="space-y-2 text-sm">
            <h4 className="font-medium text-[#C8C6BC]">Desglose</h4>
            <div className="flex justify-between"><span className="text-[#8A877D]">Base</span><span>75 pts</span></div>
            {kpiData.totalGastos > 0 && kpiData.totalIngresos > 0 && (
              <div className="flex justify-between">
                <span className="text-[#8A877D]">Ratio gastos/ingresos ({Math.round(kpiData.totalGastos / kpiData.totalIngresos * 100)}%)</span>
                <span className={kpiData.totalGastos / kpiData.totalIngresos <= 0.7 ? 'text-[#1D9E75]' : 'text-[#D85A30]'}>
                  {kpiData.totalGastos / kpiData.totalIngresos <= 0.7 ? '+15' : kpiData.totalGastos / kpiData.totalIngresos <= 0.9 ? '-5' : '-15'} pts
                </span>
              </div>
            )}
          </div>

          {/* Tips */}
          <div className="space-y-2 text-sm mt-4">
            <h4 className="font-medium text-[#C8C6BC]">Como mejorar</h4>
            <ul className="space-y-1 text-[#8A877D]">
              {kpiData.totalIngresos > 0 && kpiData.totalGastos / kpiData.totalIngresos > 0.7 && (
                <li>&bull; Reduce gastos un {Math.round((kpiData.totalGastos / kpiData.totalIngresos - 0.7) * 100)}% para ganar hasta +15 puntos</li>
              )}
              {kpiData.scoreFinanciero < 70 && (
                <li>&bull; Establece presupuestos por categoria para proteger tu score</li>
              )}
              <li>&bull; Tu score potencial: {Math.min(100, kpiData.scoreFinanciero + 20)} ({Math.min(100, kpiData.scoreFinanciero + 20) >= 80 ? 'Excelente' : 'Bueno'})</li>
            </ul>
          </div>
        </DialogContent>
      </Dialog>

      {/* AI insight (only in annual view, monthly goes in grid above) */}
      {viewMode === 'anual' && (
        <InsightCard
          insight={insightText}
          aiContext={{
            totalGastos: kpiData.totalGastos,
            totalIngresos: kpiData.totalIngresos,
            topCategorias: categoryData.slice(0, 3).map(c => `${c.categoria} (${Math.round(c.porcentaje)}%)`).join(', '),
            scoreFinanciero: kpiData.scoreFinanciero,
            subscriptionTotal: subscriptions.reduce((s, sub) => s + sub.monthlyAmount, 0) || undefined,
          }}
        />
      )}

      {/* Payment method detail dialog */}
      <Dialog open={!!detailMetodo} onOpenChange={(open) => { if (!open) setDetailMetodo(null); }}>
        <DialogContent className="bg-[#1C1C1A] border-[#2A2A28] max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-lg">
              {detailMetodo && `${getMetodoIcon(detailMetodo)} ${capitalizeDisplay(detailMetodo)}`}
            </DialogTitle>
          </DialogHeader>
          {detailMetodo && (
            <div className="space-y-3">
              <p className="text-sm text-[#8A877D]">
                Total: <span className="text-[#D85A30] font-medium">{formatCurrency(detailMetodoTransactions.reduce((s, t) => s + t.monto_pen, 0))}</span>
                {' '}&mdash; {detailMetodoTransactions.length} {detailMetodoTransactions.length === 1 ? 'transaccion' : 'transacciones'}
              </p>
              <div className="space-y-2">
                {detailMetodoTransactions.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.06)] last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#F0EFE8] whitespace-normal break-words">{tx.comercio || 'Sin comercio'}</p>
                      <p className="text-xs text-[#8A877D]">
                        {tx.fecha} &middot; {getCategoriaEmoji(tx.categoria)} {capitalizeDisplay(tx.categoria)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <span className="text-sm font-medium text-[#D85A30]">{formatCurrency(tx.monto_pen)}</span>
                      <button
                        onClick={() => setEditTransaction(tx)}
                        className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Merchant detail dialog */}
      <Dialog open={!!detailComercio} onOpenChange={(open) => { if (!open) setDetailComercio(null); }}>
        <DialogContent className="bg-[#1C1C1A] border-[#2A2A28] max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-lg">
              {detailComercio}
            </DialogTitle>
          </DialogHeader>
          {detailComercio && (
            <div className="space-y-3">
              <p className="text-sm text-[#8A877D]">
                Total: <span className="text-[#D85A30] font-medium">{formatCurrency(detailComercioTransactions.reduce((s, t) => s + t.monto_pen, 0))}</span>
                {' '}&mdash; {detailComercioTransactions.length} {detailComercioTransactions.length === 1 ? 'transaccion' : 'transacciones'}
              </p>
              <div className="space-y-2">
                {detailComercioTransactions.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.06)] last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#F0EFE8]">
                        {getCategoriaEmoji(tx.categoria)} {capitalizeDisplay(tx.categoria)}
                      </p>
                      <p className="text-xs text-[#8A877D]">
                        {tx.fecha}
                        {tx.subcategoria && tx.subcategoria !== 'sin_categoria' ? ` · ${capitalizeDisplay(tx.subcategoria)}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <span className="text-sm font-medium text-[#D85A30]">{formatCurrency(tx.monto_pen)}</span>
                      <button
                        onClick={() => setEditTransaction(tx)}
                        className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit transaction dialog */}
      <TransactionForm
        open={!!editTransaction}
        onOpenChange={(open) => { if (!open) setEditTransaction(null); }}
        tipo={editTransaction?.tipo === 'ingreso' ? 'ingreso' : 'gasto'}
        transaction={editTransaction}
        onSuccess={refreshAll}
        userCategorias={userCategorias}
      />

      {/* First-time welcome modal */}
      <WelcomeModal />
    </div>
  );
}
