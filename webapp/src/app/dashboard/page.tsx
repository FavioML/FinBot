'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Receipt, CreditCard } from 'lucide-react';
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
import { WhatsAppButton } from '@/components/shared/whatsapp-button';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { KPICards } from '@/components/dashboard/kpi-cards';
import { InsightCard, generateInsight } from '@/components/dashboard/insight-card';
import { CategoryDonut } from '@/components/charts/category-donut';
import { TrendLine } from '@/components/charts/trend-line';
import { UserMenu } from '@/components/dashboard/user-menu';
import { WelcomeModal } from '@/components/dashboard/welcome-modal';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { formatCurrency, formatFecha, calcularScoreFinanciero, getScoreColor, getScoreLabel } from '@/lib/utils';
import { getCategoriaEmoji, MESES, SOCIAL_LINKS } from '@/lib/constants';
import { detectSubscriptions, TIPO_LABELS } from '@/lib/subscriptions-catalog';
import type { KPIData, CategoriaGasto, TendenciaMensual } from '@/lib/types';

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

    return { totalIngresos, totalGastos, ahorro, ahorroPorcentaje, scoreFinanciero };
  }, [transactions, budgets]);

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
        <WhatsAppButton />
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
        <UserMenu />
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
          {/* KPI cards */}
          <KPICards data={kpiData} onScoreClick={() => setShowScoreDialog(true)} />

          {/* Charts row */}
          <FadeIn delay={0.2}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TrendLine data={trendData} />
            <CategoryDonut data={categoryData} />
          </div>
          </FadeIn>

          {/* Transacciones Recientes + Suscripciones side by side */}
          <FadeIn delay={0.35}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Transacciones Recientes */}
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

            {/* Suscripciones */}
            <div className="glass-card glass-card-glow p-5">
              <div className="flex items-center justify-between mb-4">
                <Link href="/dashboard/suscripciones" className="text-sm font-medium text-[#C8C6BC] hover:text-[#1D9E75] transition-colors">Suscripciones detectadas</Link>
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

      {/* AI insight */}
      <InsightCard insight={insightText} />

      {/* Floating WhatsApp button */}
      <WhatsAppButton />

      {/* First-time welcome modal */}
      <WelcomeModal />
    </div>
  );
}
