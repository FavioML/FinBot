'use client';


import { useMemo, useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Receipt, CreditCard, Pencil, ChevronDown, Target, Wallet, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Skeleton } from '@/components/ui/skeleton';
import { OverviewSkeleton } from '@/components/dashboard/skeletons';
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
import { ScoreTrend } from '@/components/charts/score-trend';
import { SpendingProjection } from '@/components/dashboard/spending-projection';
import { ExchangeRateWidget } from '@/components/dashboard/exchange-rate-widget';
import { QuickActions } from '@/components/dashboard/quick-actions';
import { TodaySpending } from '@/components/dashboard/today-spending';
import { NPSCard } from '@/components/dashboard/nps-card';

// Lazy load below-the-fold heavy components
const CategoryDonut = lazy(() => import('@/components/charts/category-donut').then(m => ({ default: m.CategoryDonut })));
const TrendLine = lazy(() => import('@/components/charts/trend-line').then(m => ({ default: m.TrendLine })));
const FinancialCalendar = lazy(() => import('@/components/charts/financial-calendar').then(m => ({ default: m.FinancialCalendar })));
const CategoryComparison = lazy(() => import('@/components/charts/category-comparison').then(m => ({ default: m.CategoryComparison })));
const TopMerchants = lazy(() => import('@/components/dashboard/top-merchants').then(m => ({ default: m.TopMerchants })));
const PaymentMethodDonut = lazy(() => import('@/components/charts/payment-method-donut').then(m => ({ default: m.PaymentMethodDonut })));
const RecurringPayments = lazy(() => import('@/components/dashboard/recurring-payments').then(m => ({ default: m.RecurringPayments })));
import { TransactionForm } from '@/components/dashboard/transaction-form';
import { GlobalSearch } from '@/components/dashboard/global-search';
import { HeaderActions } from '@/components/dashboard/topbar';
import { useUser } from '@/lib/hooks/use-user';
import { canAccess } from '@/lib/plan';
import { ProGate } from '@/components/shared/pro-gate';
import { useNetoScore } from '@/lib/hooks/use-neto-score';
import { useSpendingAlerts } from '@/lib/hooks/use-spending-alerts';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useGoals } from '@/lib/hooks/use-goals';
import { useDebts } from '@/lib/hooks/use-debts';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { formatCurrency, formatFecha } from '@/lib/utils';
import { getCategoriaEmoji, MESES, SOCIAL_LINKS } from '@/lib/constants';
import { capitalizeDisplay, normalizeMetodoPago, getMetodoIcon } from '@/lib/format';
import { detectSubscriptions, TIPO_LABELS } from '@/lib/subscriptions-catalog';
import type { Transaccion, KPIData, CategoriaGasto, TendenciaMensual } from '@/lib/types';

// Separador de intención por tier: pill + pregunta + línea. Solo agrupa
// visualmente las secciones existentes por "¿qué pregunta responde este bloque?".
function TierLabel({ label, question }: { label: string; question: string }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <span className="whitespace-nowrap rounded-full border border-[rgba(29,158,117,0.22)] bg-[rgba(29,158,117,0.10)] px-2.5 py-[5px] text-[10px] font-bold uppercase tracking-[0.14em] text-[#1D9E75]">
        {label}
      </span>
      <span className="text-[12.5px] text-[#8A877D]">{question}</span>
      <span className="h-px flex-1 bg-[rgba(240,239,232,0.08)]" />
    </div>
  );
}

export default function DashboardPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const canCalendar = canAccess(user?.plan, 'calendar'); // Calendario financiero es Pro
  const searchParams = useSearchParams();

  const now = new Date();
  const monthParam = searchParams.get('mes');
  const [currentYear, currentMonth] = monthParam
    ? monthParam.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

  const [viewMode, setViewMode] = useState<string>('mensual');
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [detailCategoria, setDetailCategoria] = useState<string | null>(null);
  const [detailSubcategoria, setDetailSubcategoria] = useState<string | null>(null);
  const [detailMetodo, setDetailMetodo] = useState<string | null>(null);
  const [detailComercio, setDetailComercio] = useState<string | null>(null);
  const [editTransaction, setEditTransaction] = useState<Transaccion | null>(null);
  const [showMoreWidgets, setShowMoreWidgets] = useState(false);
  const queryClient = useQueryClient();

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
  }, [queryClient]);

  // Reset subcategory drill-in whenever the category changes
  useEffect(() => {
    setDetailSubcategoria(null);
  }, [detailCategoria]);

  // Load ALL transactions for the user (enables both monthly and annual views + trend chart)
  const { data: allTransactions = [], isLoading: txLoading, isError: txError, refetch: refetchTx } = useTransactions({
    usuarioId: user?.id,
  });

  // Load goals and debts for overview widgets
  const { data: goals = [] } = useGoals(user?.id);
  const { data: allDebts = [] } = useDebts(user?.id);
  const { data: netoScore } = useNetoScore();
  const { data: alertsData } = useSpendingAlerts(10);

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

    return { totalIngresos, totalGastos, ahorro, ahorroPorcentaje, scoreFinanciero: (netoScore?.score ?? 0), prevGastos, prevIngresos };
  }, [transactions, allTransactions, viewMode, currentMonth, currentYear, netoScore]);

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

    // Agrupa case-insensitive: "Transporte" y "transporte" son la misma categoria
    // y no deben partirse en dos slices. La etiqueta es la primera variante vista
    // (para data ya canonica no cambia nada; solo colapsa duplicados por casing).
    const map = new Map<string, { categoria: string; total: number; count: number }>();
    for (const t of gastos) {
      const key = (t.categoria || '').trim().toLowerCase();
      const prev = map.get(key);
      if (prev) {
        prev.total += t.monto_pen;
        prev.count += 1;
      } else {
        map.set(key, { categoria: t.categoria, total: t.monto_pen, count: 1 });
      }
    }

    return Array.from(map.values())
      .map(({ categoria, total, count }) => ({
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
      scoreFinanciero: (netoScore?.score ?? 0),
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
      <OverviewSkeleton />
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

  // Error de carga (fetch de transacciones falló y no hay cache): error explícito en vez de un
  // dashboard vacío que parezca "perdiste tu data". Si hay cache, renderizamos normal.
  if (txError && allTransactions.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="glass-card w-full max-w-md space-y-4 p-8 text-center">
          <h2 className="text-xl font-bold text-[#F0EFE8]">No pudimos cargar tu dashboard</h2>
          <p className="text-sm text-[#8A877D]">Revisa tu conexión e inténtalo de nuevo. Tu información está a salvo.</p>
          <button
            onClick={() => refetchTx()}
            className="inline-flex items-center gap-2 rounded-lg bg-[#1D9E75] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1D9E75]/90"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const hasTransactions = transactions.length > 0;

  return (
    <div className="space-y-6">
      {/* Welcome header — muted on mobile so the hero balance dominates */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-[#8A877D] sm:text-lg sm:font-medium sm:text-[#C8C6BC]">
            {(() => {
              const hour = new Date().getHours();
              const greeting = hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches';
              const name = user.nombre || (user.email ? user.email.split('@')[0] : '');
              return name ? `${greeting}, ${name}` : greeting;
            })()}
          </p>
          <p className="hidden sm:block text-sm font-medium text-[#F0EFE8] mt-0.5">
            {viewMode === 'anual' ? `Resumen anual ${selectedYear}` : `${MESES[currentMonth]} ${currentYear}`}
          </p>
        </div>
        <HeaderActions>
          <GlobalSearch />
        </HeaderActions>
      </div>

      {/* View mode toggle — tabs + period selector share one row on all sizes */}
      <div className="flex flex-row items-center justify-between gap-3">
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

        {viewMode === 'mensual' && <MonthSelector />}
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
          {/* Quick actions — desktop only. On mobile, the primary action
              (+ gasto) lives in the FAB and the rest are in the bottom-nav,
              so this bar would be redundant clutter in the first viewport. */}
          <div className="hidden sm:block">
            <FadeIn delay={0.04}>
              <QuickActions />
            </FadeIn>
          </div>

          {/* ══════════ TIER 1 · Pulso — ¿cómo voy este mes? ══════════
              KPIs + proyección/hoy/FX + banner de fugas: la foto rápida del mes. */}
          {viewMode === 'mensual' && (
            <TierLabel label="Pulso" question="¿cómo voy este mes?" />
          )}

          {/* KPI cards */}
          <FadeIn delay={0.08}>
            <KPICards data={kpiData} sparklines={sparklines} netoScore={netoScore} />
          </FadeIn>

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

          {/* Fugas alert banner — subtle, only when there are recent alerts */}
          {(() => {
            const twoWeeksAgo = new Date();
            twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
            const recentAlerts = (alertsData?.alerts ?? []).filter(
              (a) => new Date(a.created_at) >= twoWeeksAgo
            );
            if (recentAlerts.length === 0) return null;
            return (
              <FadeIn delay={0.14}>
                <Link
                  href="/dashboard/alertas"
                  className="flex items-center gap-3 rounded-xl px-4 py-3 transition-colors hover:bg-white/[0.04]"
                  style={{ backgroundColor: 'rgba(232, 168, 56, 0.06)', border: '1px solid rgba(232, 168, 56, 0.12)' }}
                >
                  <AlertTriangle className="h-4 w-4 shrink-0 text-[#E8A838]" />
                  <span className="text-sm text-[#E8A838]/90">
                    {recentAlerts.length} fuga{recentAlerts.length > 1 ? 's' : ''} detectada{recentAlerts.length > 1 ? 's' : ''} recientemente
                  </span>
                  <span className="ml-auto text-xs text-[#8A877D]">Ver →</span>
                </Link>
              </FadeIn>
            );
          })()}

          {/* ══════════ TIER 2 · Entender — ¿en qué y cómo gasto? ══════════
              Trend + Donut abren (lectura macro más rápida); calendario, score,
              insight y merchants quedan detrás como lentes de mayor detalle. */}
          {viewMode === 'mensual' && (
            <TierLabel label="Entender" question="¿en qué y cómo gasto?" />
          )}

          {/* Trend + category donut — the fastest read of the month */}
          <FadeIn delay={0.2}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Suspense fallback={<Skeleton className="h-[320px] rounded-2xl" />}>
              <TrendLine data={trendData} />
            </Suspense>
            <Suspense fallback={<Skeleton className="h-[320px] rounded-2xl" />}>
              <CategoryDonut data={categoryData} onCategoryClick={setDetailCategoria} />
            </Suspense>
          </div>
          </FadeIn>

          {/* Collapsible detailed widgets — expanded on desktop, toggle on mobile.
              Order: Calendario+Comparación → Score+Insight → Merchants+Método. */}
          {viewMode === 'mensual' && (
            <>
              {/* Mobile toggle button */}
              <button
                onClick={() => setShowMoreWidgets(!showMoreWidgets)}
                className="flex md:hidden items-center justify-center gap-2 w-full rounded-xl border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] py-2.5 text-xs font-medium text-[#C8C6BC] transition-colors hover:bg-[rgba(255,255,255,0.04)]"
              >
                {showMoreWidgets ? 'Ocultar detalles' : 'Ver mas detalles'}
                <motion.span
                  animate={{ rotate: showMoreWidgets ? 180 : 0 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  className="inline-flex"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </motion.span>
              </button>

              {/* Desktop: always visible */}
              <div className="hidden md:block space-y-6">
                {/* Financial calendar + Category comparison */}
                <Suspense fallback={<Skeleton className="h-[300px] rounded-2xl" />}>
                <FadeIn delay={0.25}>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {canCalendar ? (
                    <FinancialCalendar
                      transactions={allTransactions}
                      currentMonth={currentMonth}
                      currentYear={currentYear}
                      debts={allDebts}
                      goals={goals}
                    />
                  ) : (
                    <ProGate featureName="Calendario financiero" description="Visualiza tus gastos, deudas y metas en un calendario mensual." />
                  )}
                  <CategoryComparison
                    allTransactions={allTransactions}
                    currentMonth={currentMonth}
                    currentYear={currentYear}
                    onCategoryClick={setDetailCategoria}
                  />
                </div>
                </FadeIn>
                </Suspense>

                {/* Score trend + AI insight */}
                <FadeIn delay={0.28}>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <ScoreTrend />
                  <InsightCard
                    enableAI={canAccess(user?.plan, 'advice_daily')}
                    insight={insightText}
                    aiContext={{
                      totalGastos: kpiData.totalGastos,
                      totalIngresos: kpiData.totalIngresos,
                      topCategorias: categoryData.slice(0, 3).map(c => `${c.categoria} (${Math.round(c.porcentaje)}%)`).join(', '),
                      scoreFinanciero: (netoScore?.score ?? 0),
                      subscriptionTotal: subscriptions.reduce((s, sub) => s + sub.monthlyAmount, 0) || undefined,
                    }}
                  />
                </div>
                </FadeIn>

                {/* Top merchants + Payment methods */}
                <Suspense fallback={<Skeleton className="h-[300px] rounded-2xl" />}>
                <FadeIn delay={0.3}>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <TopMerchants transactions={transactions} onMerchantClick={setDetailComercio} />
                  <PaymentMethodDonut transactions={transactions} onMethodClick={setDetailMetodo} />
                </div>
                </FadeIn>
                </Suspense>
              </div>

              {/* Mobile: animated collapse */}
              <AnimatePresence initial={false}>
                {showMoreWidgets && (
                  <motion.div
                    key="more-widgets-mobile"
                    className="md:hidden overflow-hidden space-y-6"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {/* Financial calendar + Category comparison */}
                    <Suspense fallback={<Skeleton className="h-[300px] rounded-2xl" />}>
                    <FadeIn delay={0.05}>
                    <div className="grid grid-cols-1 gap-4">
                      {canCalendar ? (
                        <FinancialCalendar
                          transactions={allTransactions}
                          currentMonth={currentMonth}
                          currentYear={currentYear}
                          debts={allDebts}
                          goals={goals}
                        />
                      ) : (
                        <ProGate featureName="Calendario financiero" description="Visualiza tus gastos, deudas y metas en un calendario mensual." />
                      )}
                      <CategoryComparison
                        allTransactions={allTransactions}
                        currentMonth={currentMonth}
                        currentYear={currentYear}
                        onCategoryClick={setDetailCategoria}
                      />
                    </div>
                    </FadeIn>
                    </Suspense>

                    {/* Score trend + AI insight */}
                    <FadeIn delay={0.1}>
                    <div className="grid grid-cols-1 gap-4">
                      <ScoreTrend />
                      <InsightCard
                        enableAI={canAccess(user?.plan, 'advice_daily')}
                        insight={insightText}
                        aiContext={{
                          totalGastos: kpiData.totalGastos,
                          totalIngresos: kpiData.totalIngresos,
                          topCategorias: categoryData.slice(0, 3).map(c => `${c.categoria} (${Math.round(c.porcentaje)}%)`).join(', '),
                          scoreFinanciero: (netoScore?.score ?? 0),
                          subscriptionTotal: subscriptions.reduce((s, sub) => s + sub.monthlyAmount, 0) || undefined,
                        }}
                      />
                    </div>
                    </FadeIn>

                    {/* Top merchants + Payment methods */}
                    <Suspense fallback={<Skeleton className="h-[300px] rounded-2xl" />}>
                    <FadeIn delay={0.15}>
                    <div className="grid grid-cols-1 gap-4">
                      <TopMerchants transactions={transactions} onMerchantClick={setDetailComercio} />
                      <PaymentMethodDonut transactions={transactions} onMethodClick={setDetailMetodo} />
                    </div>
                    </FadeIn>
                    </Suspense>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}

          {/* ══════════ TIER 3 · Seguimiento — ¿qué debo atender? ══════════
              Transacciones, recurrentes, metas y deudas: lo accionable. */}
          {viewMode === 'mensual' && (
            <TierLabel label="Seguimiento" question="¿qué debo atender?" />
          )}

          {/* Transacciones Recientes + Pagos Recurrentes — 2-col on desktop */}
          <FadeIn delay={0.35}>
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
            {/* Transacciones Recientes */}
            <div className="glass-card glass-card-glow p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium md:text-base md:font-semibold text-[#C8C6BC]">Transacciones Recientes</h3>
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
                        <span className="hidden lg:inline-block text-xs text-[#8A877D] w-[100px] shrink-0 truncate">
                          {tx.metodo_pago ? capitalizeDisplay(normalizeMetodoPago(tx.metodo_pago, tx.banco)) : ''}
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

            {/* Pagos Recurrentes */}
            <Suspense fallback={<Skeleton className="h-[200px] rounded-2xl" />}>
              <RecurringPayments transactions={allTransactions} />
            </Suspense>
          </div>
          </FadeIn>

          {/* Metas + Deudas + Logros widgets */}
          <FadeIn delay={0.5}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Metas de ahorro */}
            <div className="glass-card glass-card-glow p-4 lg:p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Target className="h-4 w-4 text-[#1D9E75]" />
                  <span className="text-sm font-medium text-[#C8C6BC]">Planes de ahorro</span>
                </div>
                <Link href="/dashboard/planes" className="text-xs text-[#1D9E75] hover:underline">Ver todas &rarr;</Link>
              </div>
              {(() => {
                const activeGoals = goals.filter((g) => g.status === 'active' || (!g.status && !g.completada));
                if (activeGoals.length === 0) return (
                  <div className="flex flex-col items-center justify-center py-6 text-center">
                    <Target className="h-6 w-6 text-[#8A877D]/50 mb-2" />
                    <p className="text-sm text-[#8A877D]">Sin planes activos</p>
                    <Link href="/dashboard/planes" className="text-xs text-[#1D9E75] mt-1 hover:underline">Crear un plan</Link>
                  </div>
                );
                return (
                  <div className="space-y-3">
                    {activeGoals.slice(0, 4).map((g) => {
                      const pct = Number(g.monto_objetivo) > 0
                        ? Math.min(100, (Number(g.monto_actual) / Number(g.monto_objetivo)) * 100)
                        : 0;
                      return (
                        <div key={g.id}>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-[#F0EFE8]">{g.icono} {g.nombre}</span>
                            <div className="flex items-center gap-2">
                              {g.monthly_quota && g.status === 'active' && (
                                <span className="text-[#8A877D]">S/{Number(g.monthly_quota).toFixed(0)}/mes</span>
                              )}
                              <span className="text-[#8A877D] tabular-nums">{pct.toFixed(0)}%</span>
                            </div>
                          </div>
                          <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                            <div className="h-full rounded-full bg-[#1D9E75] transition-all" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Deudas resumen */}
            <div className="glass-card glass-card-glow p-4 lg:p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-[#EF9F27]" />
                  <span className="text-sm font-medium text-[#C8C6BC]">Deudas</span>
                </div>
                <Link href="/dashboard/deudas" className="text-xs text-[#1D9E75] hover:underline">Ver todas &rarr;</Link>
              </div>
              {(() => {
                const activas = allDebts.filter((d) => d.estado === 'activa');
                const deboTotal = activas.filter((d) => d.tipo === 'debo').reduce((s, d) => s + Number(d.monto_pendiente), 0);
                const meDebenTotal = activas.filter((d) => d.tipo === 'me_deben').reduce((s, d) => s + Number(d.monto_pendiente), 0);
                if (activas.length === 0) return (
                  <div className="flex flex-col items-center justify-center py-6 text-center">
                    <Wallet className="h-6 w-6 text-[#8A877D]/50 mb-2" />
                    <p className="text-sm text-[#8A877D]">Sin deudas activas</p>
                  </div>
                );
                return (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[#8A877D]">Yo debo</span>
                      <span className="text-sm font-bold text-[#D85A30] tabular-nums">{formatCurrency(deboTotal)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[#8A877D]">Me deben</span>
                      <span className="text-sm font-bold text-[#1D9E75] tabular-nums">{formatCurrency(meDebenTotal)}</span>
                    </div>
                    <div className="border-t border-[rgba(255,255,255,0.06)] pt-3 flex justify-between">
                      <span className="text-xs text-[#8A877D]">Balance neto</span>
                      <span className={`text-sm font-bold tabular-nums ${meDebenTotal - deboTotal >= 0 ? 'text-[#1D9E75]' : 'text-[#D85A30]'}`}>
                        {meDebenTotal - deboTotal >= 0 ? '+' : ''}{formatCurrency(meDebenTotal - deboTotal)}
                      </span>
                    </div>
                    <p className="text-[10px] text-[#8A877D]">{activas.length} deuda{activas.length !== 1 ? 's' : ''} activa{activas.length !== 1 ? 's' : ''}</p>
                  </div>
                );
              })()}
            </div>
          </div>
          </FadeIn>

          {/* NPS in-app card — encuesta de baja prioridad, bajada al pie del
              overview para no competir con el pulso financiero. Auto-aparece
              para usuarios elegibles (>=7d, nunca respondieron). */}
          <NPSCard />
        </>
      )}

      {/* Category detail dialog */}
      <Dialog open={!!detailCategoria} onOpenChange={(open) => { if (!open) { setDetailCategoria(null); setDetailSubcategoria(null); } }}>
        <DialogContent className="glass-card-elevated text-[#F0EFE8] max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detailCategoria && (
                <span className="flex items-center gap-2 flex-wrap">
                  {detailSubcategoria && (
                    <button
                      onClick={() => setDetailSubcategoria(null)}
                      className="text-xs text-[#1D9E75] hover:underline"
                    >
                      &larr; {getCategoriaEmoji(detailCategoria)} {capitalizeDisplay(detailCategoria)}
                    </button>
                  )}
                  {!detailSubcategoria && (
                    <span>{getCategoriaEmoji(detailCategoria)} {capitalizeDisplay(detailCategoria)}</span>
                  )}
                  {detailSubcategoria && (
                    <span className="text-[#F0EFE8]">/ {capitalizeDisplay(detailSubcategoria)}</span>
                  )}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {detailCategoria && (() => {
            const detailKey = detailCategoria.trim().toLowerCase();
            const catTxs = transactions
              .filter((t) => t.tipo === 'gasto' && (t.categoria || '').trim().toLowerCase() === detailKey)
              .sort((a, b) => b.fecha.localeCompare(a.fecha));
            const catTotal = catTxs.reduce((s, t) => s + t.monto_pen, 0);

            // Group by subcategory
            const subMap = new Map<string, Transaccion[]>();
            for (const tx of catTxs) {
              const sub = (tx.subcategoria && tx.subcategoria !== 'sin_categoria' && tx.subcategoria !== 'null')
                ? tx.subcategoria
                : '(General)';
              if (!subMap.has(sub)) subMap.set(sub, []);
              subMap.get(sub)!.push(tx);
            }
            const subEntries = Array.from(subMap.entries())
              .map(([name, txs]) => ({
                name,
                txs,
                total: txs.reduce((s, t) => s + t.monto_pen, 0),
              }))
              .sort((a, b) => b.total - a.total);

            // If a subcategory is selected, only show its txs
            const visibleTxs = detailSubcategoria
              ? (subMap.get(detailSubcategoria) || [])
              : catTxs;

            return (
              <div className="glass-card-depth space-y-3">
                <p className="text-sm text-[#8A877D]">
                  Total{detailSubcategoria ? ' subcategoría' : ''}:{' '}
                  <span className="text-[#D85A30] font-medium">
                    {formatCurrency(detailSubcategoria
                      ? (subMap.get(detailSubcategoria)?.reduce((s, t) => s + t.monto_pen, 0) || 0)
                      : catTotal)}
                  </span>
                  {' '}&mdash; {visibleTxs.length} transacci{visibleTxs.length === 1 ? 'on' : 'ones'}
                </p>

                {/* Subcategory breakdown — consolidated total per subcategory.
                    Only when not drilled into one and there's more than one. */}
                {!detailSubcategoria && subEntries.length > 1 && (
                  <div className="space-y-1 pb-1">
                    {subEntries.map(({ name, total, txs }) => (
                      <button
                        key={name}
                        onClick={() => name !== '(General)' && setDetailSubcategoria(name)}
                        disabled={name === '(General)'}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                          name === '(General)'
                            ? 'cursor-default bg-[rgba(255,255,255,0.03)]'
                            : 'bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(29,158,117,0.1)]'
                        }`}
                      >
                        <span className={name === '(General)' ? 'text-[#8A877D]' : 'text-[#1D9E75]'}>
                          {capitalizeDisplay(name)}
                        </span>
                        <span className="text-[#8A877D]">· {txs.length}</span>
                        <span className="ml-auto font-medium tabular-nums text-[#F0EFE8]">
                          {formatCurrency(total)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {visibleTxs.length > 0 ? (
                  <div className="space-y-1">
                    {visibleTxs.map((tx) => (
                      <div key={tx.id} className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.04)] last:border-0">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-[#F0EFE8] truncate">{tx.comercio || tx.subcategoria || 'Sin comercio'}</p>
                          <p className="text-xs text-[#8A877D]">
                            {formatFecha(tx.fecha)}
                            {!detailSubcategoria && tx.subcategoria && tx.subcategoria !== 'sin_categoria' && (
                              <span> · {capitalizeDisplay(tx.subcategoria)}</span>
                            )}
                          </p>
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
                  </div>
                ) : (
                  <p className="text-sm text-[#8A877D] text-center py-4">Sin gastos en esta categoria</p>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* AI insight (only in annual view, monthly goes in grid above) */}
      {viewMode === 'anual' && (
        <InsightCard
          enableAI={canAccess(user?.plan, 'advice_daily')}
          insight={insightText}
          aiContext={{
            totalGastos: kpiData.totalGastos,
            totalIngresos: kpiData.totalIngresos,
            topCategorias: categoryData.slice(0, 3).map(c => `${c.categoria} (${Math.round(c.porcentaje)}%)`).join(', '),
            scoreFinanciero: (netoScore?.score ?? 0),
            subscriptionTotal: subscriptions.reduce((s, sub) => s + sub.monthlyAmount, 0) || undefined,
          }}
        />
      )}

      {/* Payment method detail dialog */}
      <Dialog open={!!detailMetodo} onOpenChange={(open) => { if (!open) setDetailMetodo(null); }}>
        <DialogContent className="glass-card-elevated max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-lg">
              {detailMetodo && `${getMetodoIcon(detailMetodo)} ${capitalizeDisplay(detailMetodo)}`}
            </DialogTitle>
          </DialogHeader>
          {detailMetodo && (() => {
            // Consolidate this payment method's spending by category → subcategory
            const metodoTotal = detailMetodoTransactions.reduce((s, t) => s + t.monto_pen, 0);
            // Case-insensitive para no partir la misma categoria por casing.
            const catMap = new Map<string, { label: string; total: number; count: number; subs: Map<string, number> }>();
            for (const tx of detailMetodoTransactions) {
              const key = (tx.categoria || '').trim().toLowerCase();
              let entry = catMap.get(key);
              if (!entry) { entry = { label: tx.categoria, total: 0, count: 0, subs: new Map() }; catMap.set(key, entry); }
              entry.total += tx.monto_pen;
              entry.count += 1;
              const sub = (tx.subcategoria && tx.subcategoria !== 'sin_categoria' && tx.subcategoria !== 'null')
                ? tx.subcategoria
                : '(General)';
              entry.subs.set(sub, (entry.subs.get(sub) || 0) + tx.monto_pen);
            }
            const catBreakdown = Array.from(catMap.values())
              .map(({ label: categoria, total, count, subs }) => ({
                categoria,
                total,
                count,
                subs: Array.from(subs.entries())
                  .map(([name, monto]) => ({ name, monto }))
                  .sort((a, b) => b.monto - a.monto),
              }))
              .sort((a, b) => b.total - a.total);

            return (
            <div className="glass-card-depth space-y-3">
              <p className="text-sm text-[#8A877D]">
                Total: <span className="text-[#D85A30] font-medium">{formatCurrency(metodoTotal)}</span>
                {' '}&mdash; {detailMetodoTransactions.length} {detailMetodoTransactions.length === 1 ? 'transaccion' : 'transacciones'}
              </p>

              {/* Consolidated breakdown by category + subcategory */}
              <div className="space-y-2 rounded-xl bg-[rgba(255,255,255,0.02)] p-3">
                <h4 className="text-xs font-medium text-[#C8C6BC]">Por categoría</h4>
                {catBreakdown.map((cat) => (
                  <div key={cat.categoria} className="space-y-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-[#F0EFE8]">
                        {getCategoriaEmoji(cat.categoria)} {capitalizeDisplay(cat.categoria)}
                      </span>
                      <span className="text-xs text-[#8A877D]">· {cat.count}</span>
                      <span className="ml-auto font-medium tabular-nums text-[#F0EFE8]">{formatCurrency(cat.total)}</span>
                    </div>
                    {cat.subs.length > 0 && !(cat.subs.length === 1 && cat.subs[0].name === '(General)') && (
                      <div className="space-y-0.5 pl-5">
                        {cat.subs.map((sub) => (
                          <div key={sub.name} className="flex items-center gap-2 text-xs text-[#8A877D]">
                            <span>{sub.name === '(General)' ? 'Sin subcategoría' : capitalizeDisplay(sub.name)}</span>
                            <span className="ml-auto tabular-nums">{formatCurrency(sub.monto)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

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
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Merchant detail dialog */}
      <Dialog open={!!detailComercio} onOpenChange={(open) => { if (!open) setDetailComercio(null); }}>
        <DialogContent className="glass-card-elevated max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-lg">
              {detailComercio}
            </DialogTitle>
          </DialogHeader>
          {detailComercio && (
            <div className="glass-card-depth space-y-3">
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

    </div>
  );
}
