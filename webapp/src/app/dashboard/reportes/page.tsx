'use client';

import { useState, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
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
import { Button } from '@/components/ui/button';
import { ReportesSkeleton } from '@/components/dashboard/skeletons';
import { EmptyState } from '@/components/shared/empty-state';
import { NumberTicker } from '@/components/ui/number-ticker';
import { TransactionForm } from '@/components/dashboard/transaction-form';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { useUser } from '@/lib/hooks/use-user';
import { canAccess } from '@/lib/plan';
import { ProGate } from '@/components/shared/pro-gate';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { formatCurrency, getScoreColor, getScoreLabel } from '@/lib/utils';
import { useNetoScore } from '@/lib/hooks/use-neto-score';
import { getCategoriaEmoji, MESES, SOCIAL_LINKS } from '@/lib/constants';
import { capitalizeDisplay, normalizeMetodoPago, getMetodoIcon } from '@/lib/format';
import { useSubscriptions } from '@/lib/hooks/use-subscriptions';
import type { Transaccion } from '@/lib/types';
import { HeaderActions } from '@/components/dashboard/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  FileBarChart, Download, TrendingUp, TrendingDown,
  Wallet, Activity, Pencil, ArrowUp, ArrowDown,
} from 'lucide-react';

// recharts is heavy (~317 KB); load the report charts only when this page renders
const CategoryBarChart = lazy(() => import('@/components/charts/reportes-charts').then(m => ({ default: m.CategoryBarChart })));
const PaymentMethodsPieChart = lazy(() => import('@/components/charts/reportes-charts').then(m => ({ default: m.PaymentMethodsPieChart })));
const DailySpendingChart = lazy(() => import('@/components/charts/reportes-charts').then(m => ({ default: m.DailySpendingChart })));
import { motion } from 'motion/react';
import { toast } from 'sonner';

// --- Helpers ---

function buildMonthOptions() {
  const now = new Date();
  const options: { label: string; mes: number; anio: number; value: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mes = d.getMonth() + 1;
    const anio = d.getFullYear();
    options.push({
      label: `${MESES[mes]} ${anio}`,
      mes,
      anio,
      value: `${anio}-${mes}`,
    });
  }
  return options;
}


// --- Component ---

export default function ReportesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const monthOptions = useMemo(() => buildMonthOptions(), []);

  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const selected = searchParams.get('mes') || defaultMonth;

  const setSelected = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('mes', value);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  const selectedOption = monthOptions.find((o) => o.value === selected) || monthOptions[0];

  const { data: user, isLoading: userLoading } = useUser();
  const { data: netoScoreData } = useNetoScore();
  const { data: transactions = [], isLoading: txLoading } = useTransactions({
    usuarioId: user?.id,
    mes: selectedOption.mes,
    anio: selectedOption.anio,
  });

  // Previous month transactions for comparison
  const prevDate = new Date(selectedOption.anio, selectedOption.mes - 2, 1);
  const prevMes = prevDate.getMonth() + 1;
  const prevAnio = prevDate.getFullYear();
  const { data: prevTransactions = [] } = useTransactions({
    usuarioId: user?.id,
    mes: prevMes,
    anio: prevAnio,
  });

  const { data: budgets = [] } = useBudgets(user?.id);
  const { data: subsData } = useSubscriptions(user?.id);

  const isLoading = userLoading || txLoading;

  const reportRef = useRef<HTMLDivElement>(null);
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const handleDownloadPDF = useCallback(async () => {
    if (!reportRef.current || generatingPdf) return;
    setGeneratingPdf(true);
    try {
      const html2canvas = (await import('html2canvas-pro')).default;
      const { jsPDF } = await import('jspdf');
      const canvas = await html2canvas(reportRef.current, {
        backgroundColor: '#0E0E0C',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      const imgData = canvas.toDataURL('image/png');
      const imgW = canvas.width;
      const imgH = canvas.height;
      // A4 in mm
      const pdfW = 210;
      const pdfH = (imgH * pdfW) / imgW;
      const pdf = new jsPDF('p', 'mm', [pdfW, Math.max(pdfH, 297)]);
      pdf.addImage(imgData, 'PNG', 0, 0, pdfW, pdfH);
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      pdf.save(`Neto - Reporte - ${dd}-${mm}-${yyyy}.pdf`);
      toast.success('Reporte PDF descargado');
    } catch (err) {
      console.error('[PDF] Error generating:', err);
      toast.error('Error al generar el PDF');
    } finally {
      setGeneratingPdf(false);
    }
  }, [generatingPdf, selectedOption]);

  // Score dialog state
  const [showScoreDialog, setShowScoreDialog] = useState(false);

  // Detail dialogs state
  const [detailCat, setDetailCat] = useState<string | null>(null);
  const [detailMetodo, setDetailMetodo] = useState<string | null>(null);
  const [detailComercio, setDetailComercio] = useState<string | null>(null);
  const [detailDay, setDetailDay] = useState<number | null>(null);
  const [editTransaction, setEditTransaction] = useState<Transaccion | null>(null);

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
  }, [queryClient]);

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

  // Filtered transactions for detail dialogs
  const detailCatTransactions = useMemo(() => {
    if (!detailCat) return [];
    return transactions.filter((t) => t.tipo === 'gasto' && t.categoria === detailCat)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [transactions, detailCat]);

  const detailMetodoTransactions = useMemo(() => {
    if (!detailMetodo) return [];
    return transactions.filter((t) => t.tipo === 'gasto' && normalizeMetodoPago(t.metodo_pago, t.banco) === detailMetodo)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [transactions, detailMetodo]);

  const detailComercioTransactions = useMemo(() => {
    if (!detailComercio) return [];
    return transactions.filter((t) => t.tipo === 'gasto' && (t.comercio || 'Sin comercio') === detailComercio)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [transactions, detailComercio]);

  const detailDayTransactions = useMemo(() => {
    if (detailDay === null) return [];
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${selectedOption.anio}-${pad(selectedOption.mes)}-${pad(detailDay)}`;
    return transactions.filter((t) => t.tipo === 'gasto' && t.fecha === dateStr)
      .sort((a, b) => b.monto_pen - a.monto_pen);
  }, [transactions, detailDay, selectedOption]);

  // --- Computed data ---

  // Previous month totals for comparison
  const prevTotals = useMemo(() => {
    const ingresos = prevTransactions.filter((t) => t.tipo === 'ingreso').reduce((s, t) => s + t.monto_pen, 0);
    const gastos = prevTransactions.filter((t) => t.tipo === 'gasto').reduce((s, t) => s + t.monto_pen, 0);
    return { ingresos, gastos, ahorro: ingresos - gastos, count: prevTransactions.length };
  }, [prevTransactions]);

  const { totalIngresos, totalGastos, ahorro, score } = useMemo(() => {
    const ingresos = transactions.filter((t) => t.tipo === 'ingreso').reduce((s, t) => s + t.monto_pen, 0);
    const gastos = transactions.filter((t) => t.tipo === 'gasto').reduce((s, t) => s + t.monto_pen, 0);
    const ahorro = ingresos - gastos;

    const score = netoScoreData?.score ?? 0;
    return { totalIngresos: ingresos, totalGastos: gastos, ahorro, score };
  }, [transactions, budgets, netoScoreData]);

  const categoryBreakdown = useMemo(() => {
    const gastos = transactions.filter((t) => t.tipo === 'gasto');
    const map = new Map<string, number>();
    for (const t of gastos) map.set(t.categoria, (map.get(t.categoria) || 0) + t.monto_pen);
    return Array.from(map.entries())
      .map(([cat, total]) => ({
        categoria: cat,
        emoji: getCategoriaEmoji(cat),
        total,
        label: `${getCategoriaEmoji(cat)} ${cat}`,
      }))
      .sort((a, b) => b.total - a.total);
  }, [transactions]);

  const paymentMethods = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of transactions.filter((t) => t.tipo === 'gasto')) {
      const method = normalizeMetodoPago(t.metodo_pago, t.banco);
      map.set(method, (map.get(method) || 0) + t.monto_pen);
    }
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [transactions]);

  const topMerchants = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const t of transactions.filter((t) => t.tipo === 'gasto')) {
      const name = t.comercio || 'Sin comercio';
      const prev = map.get(name) || { total: 0, count: 0 };
      map.set(name, { total: prev.total + t.monto_pen, count: prev.count + 1 });
    }
    return Array.from(map.entries())
      .map(([name, d]) => ({ name, ...d }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  }, [transactions]);

  const dailySpending = useMemo(() => {
    const daysInMonth = new Date(selectedOption.anio, selectedOption.mes, 0).getDate();
    const dayMap = new Map<number, number>();
    for (let d = 1; d <= daysInMonth; d++) dayMap.set(d, 0);
    for (const t of transactions.filter((t) => t.tipo === 'gasto')) {
      const day = new Date(t.fecha + 'T00:00:00').getDate();
      dayMap.set(day, (dayMap.get(day) || 0) + t.monto_pen);
    }
    return Array.from(dayMap.entries()).map(([day, total]) => ({ day, total: Math.round(total * 100) / 100 }));
  }, [transactions, selectedOption]);

  const dailyAverage = useMemo(() => {
    const daysWithSpending = dailySpending.filter((d) => d.total > 0);
    if (daysWithSpending.length === 0) return 0;
    return Math.round(daysWithSpending.reduce((s, d) => s + d.total, 0) / daysWithSpending.length);
  }, [dailySpending]);

  const txCount = transactions.length;

  // --- Score SVG ---
  const scoreColor = getScoreColor(score);
  const scoreLabel = getScoreLabel(score);
  const circumference = 2 * Math.PI * 54;
  const strokeDash = (score / 100) * circumference;

  // --- Render ---

  if (isLoading) {
    return (
      <ReportesSkeleton />
    );
  }

  if (user && !canAccess(user.plan, 'reports_pdf')) {
    return (
      <ProGate
        featureName="Reportes PDF"
        description="Descarga reportes detallados con gráficos, score financiero y análisis de tus finanzas."
      />
    );
  }

if (!isLoading && transactions.length === 0) {
    return (
      <div className="space-y-6">
        <Header selected={selected} setSelected={setSelected} monthOptions={monthOptions} onDownloadPDF={handleDownloadPDF} generatingPdf={generatingPdf} />
        <EmptyState
          title="Sin datos para este mes"
          description="Registra tus ingresos y gastos por WhatsApp para generar tu reporte mensual con graficos y score financiero."
          icon={FileBarChart}
          showWhatsApp={false}
          actions={[
            { label: 'Registra por WhatsApp', href: SOCIAL_LINKS.whatsapp, external: true },
            { label: 'Ver transacciones', href: '/dashboard/transacciones', variant: 'secondary' as const },
          ]}
        />
      </div>
    );
  }

  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Print styles */}
      <style jsx global>{`
        @media print {
          body, html { background: white !important; }
          nav, aside, .sidebar, button, [data-slot="dialog"], header { display: none !important; }
          main, [class*="ml-"] { margin-left: 0 !important; padding: 16px !important; }
          .glass-card {
            background: white !important;
            border: 1px solid #ccc !important;
            break-inside: avoid;
            margin-bottom: 12px !important;
          }
          h1, h2, h3, h4, p, span, td, th, li { color: #111 !important; }
          .text-\\[\\#D85A30\\], .text-red-500 { color: #c0392b !important; }
          .text-\\[\\#1D9E75\\], .text-green-500 { color: #27ae60 !important; }
          .text-\\[\\#EF9F27\\] { color: #e67e22 !important; }
          svg { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .recharts-text { fill: #333 !important; }
          .recharts-legend-item-text { color: #333 !important; }
        }
      `}</style>

      {/* Header */}
      <Header selected={selected} setSelected={setSelected} monthOptions={monthOptions} onDownloadPDF={handleDownloadPDF} generatingPdf={generatingPdf} />

      {/* Report content for PDF capture */}
      <div ref={reportRef} className="space-y-6">

      {/* Score financiero */}
      <div
        className="glass-card glass-card-glow p-6 flex flex-col sm:flex-row items-center gap-6 cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors"
        onClick={() => setShowScoreDialog(true)}
      >
        <div className="relative flex-shrink-0">
          <svg width="128" height="128" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="54" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
            <circle
              cx="60" cy="60" r="54" fill="none"
              stroke={scoreColor} strokeWidth="8" strokeLinecap="round"
              strokeDasharray={`${strokeDash} ${circumference}`}
              transform="rotate(-90 60 60)"
              style={{ transition: 'stroke-dashoffset 1.5s cubic-bezier(0.16, 1, 0.3, 1)' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-bold text-[#F0EFE8]">
              <NumberTicker value={score} className="!text-[#F0EFE8]" />
            </span>
            <span className="text-xs text-[#F0EFE8]">de 100</span>
          </div>
        </div>
        <div>
          <h3 className="text-lg font-semibold text-[#F0EFE8]">
            Score Financiero: <span style={{ color: scoreColor }}>{scoreLabel}</span>
          </h3>
          <p className="text-sm text-[#8A877D] mt-1 max-w-md">
            {score >= 80
              ? 'Tus finanzas van muy bien. Mantienes un excelente balance entre ingresos y gastos.'
              : score >= 60
                ? 'Vas por buen camino, pero hay espacio para mejorar tu ahorro mensual.'
                : 'Tus gastos son altos en relacion a tus ingresos. Revisa tus categorias principales.'}
          </p>
        </div>
      </div>

      {/* KPI row */}
      <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StaggerItem>
        <KPICard
          label="Ingresos"
          value={totalIngresos}
          icon={<TrendingUp className="h-4 w-4" />}
          color="#1D9E75"
          prevValue={prevTotals.ingresos}
        />
        </StaggerItem>
        <StaggerItem>
        <KPICard
          label="Gastos"
          value={totalGastos}
          icon={<TrendingDown className="h-4 w-4" />}
          color="#D85A30"
          prevValue={prevTotals.gastos}
          invertColor
        />
        </StaggerItem>
        <StaggerItem>
        <KPICard
          label="Ahorro neto"
          value={ahorro}
          icon={<Wallet className="h-4 w-4" />}
          color={ahorro >= 0 ? '#1D9E75' : '#D85A30'}
          prevValue={prevTotals.ahorro > 0 ? prevTotals.ahorro : undefined}
        />
        </StaggerItem>
        <StaggerItem>
        <KPICard
          label="Transacciones"
          value={txCount}
          icon={<Activity className="h-4 w-4" />}
          color="#EF9F27"
          isCurrency={false}
          prevValue={prevTotals.count}
        />
        </StaggerItem>
      </StaggerContainer>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Category BarChart */}
        <div className="glass-card glass-card-glow p-5">
          <h4 className="text-sm font-medium text-[#C8C6BC] mb-4">Gastos por categoria</h4>
          {categoryBreakdown.length > 0 ? (
            <Suspense fallback={<Skeleton className="h-[200px] rounded-lg" />}>
              <CategoryBarChart data={categoryBreakdown} onSelect={setDetailCat} />
            </Suspense>
          ) : (
            <p className="text-sm text-[#8A877D] text-center py-8">Sin gastos registrados</p>
          )}
        </div>

        {/* Payment methods PieChart */}
        <div className="glass-card glass-card-glow p-5">
          <h4 className="text-sm font-medium text-[#C8C6BC] mb-4">Metodos de pago</h4>
          {paymentMethods.length > 0 ? (
            <Suspense fallback={<Skeleton className="h-[280px] rounded-lg" />}>
              <PaymentMethodsPieChart data={paymentMethods} onSelect={setDetailMetodo} />
            </Suspense>
          ) : (
            <p className="text-sm text-[#8A877D] text-center py-8">Sin datos</p>
          )}
        </div>
      </div>

      {/* Top merchants */}
      {topMerchants.length > 0 && (
        <div className="glass-card glass-card-glow p-5">
          <h4 className="text-sm font-medium text-[#C8C6BC] mb-4">Top comercios</h4>
          <div className="space-y-3">
            {topMerchants.map((m, i) => (
              <div
                key={m.name}
                className="flex items-center justify-between cursor-pointer rounded-lg px-2 py-1 -mx-2 hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                onClick={() => setDetailComercio(m.name)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-[#8A877D] w-5 text-right">{i + 1}.</span>
                  <span className="text-sm text-[#F0EFE8]">{m.name}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-[#8A877D]">{m.count} {m.count === 1 ? 'transacción' : 'transacciones'}</span>
                  <span className="text-sm font-medium text-[#D85A30]">{formatCurrency(m.total)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily spending */}
      <div className="glass-card glass-card-glow p-5">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-sm font-medium text-[#C8C6BC]">Gasto diario</h4>
          {dailyAverage > 0 && (
            <span className="text-xs text-[#8A877D]">
              Promedio: <span className="text-[#EF9F27] font-medium">{formatCurrency(dailyAverage)}/dia</span>
            </span>
          )}
        </div>
        <Suspense fallback={<Skeleton className="h-[220px] rounded-lg" />}>
          <DailySpendingChart data={dailySpending} dailyAverage={dailyAverage} onSelect={setDetailDay} />
        </Suspense>
      </div>

      {/* Suscripciones summary */}
      {subsData && subsData.cantidad > 0 && (
        <div className="glass-card glass-card-glow p-5">
          <h4 className="text-sm font-medium text-[#C8C6BC] mb-4">Suscripciones activas</h4>
          <div className="space-y-2">
            {subsData.suscripciones.slice(0, 8).map((sub) => (
              <div key={sub.id} className="flex items-center justify-between text-sm">
                <span className="text-[#F0EFE8]">{sub.icono} {sub.nombre}</span>
                <div className="text-right">
                  <span className="text-[#C8C6BC] font-medium">S/{sub.monto_pen.toFixed(0)}/mes</span>
                  <span className="text-xs text-[#8A877D] ml-2">S/{(sub.monto_pen * 12).toFixed(0)}/año</span>
                </div>
              </div>
            ))}
            <div className="border-t border-[rgba(255,255,255,0.06)] pt-2 mt-2 flex justify-between">
              <span className="text-sm text-[#C8C6BC]">Total mensual</span>
              <span className="text-sm font-bold text-[#D85A30]">S/{subsData.totalMensualPEN.toFixed(0)}/mes</span>
            </div>
          </div>
        </div>
      )}

      {/* Financial health summary */}
      <div className="glass-card glass-card-glow p-5">
        <h4 className="text-sm font-medium text-[#C8C6BC] mb-3">Resumen de salud financiera</h4>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg bg-[rgba(255,255,255,0.03)] p-3">
            <span className="text-[#8A877D]">Tasa de ahorro</span>
            <p className={`text-lg font-bold mt-1 ${ahorro >= 0 ? 'text-[#1D9E75]' : 'text-[#D85A30]'}`}>
              {totalIngresos > 0 ? `${((ahorro / totalIngresos) * 100).toFixed(0)}%` : '—'}
            </p>
          </div>
          <div className="rounded-lg bg-[rgba(255,255,255,0.03)] p-3">
            <span className="text-[#8A877D]">Gasto promedio diario</span>
            <p className="text-lg font-bold text-[#EF9F27] mt-1">
              {dailyAverage > 0 ? `S/${dailyAverage}` : '—'}
            </p>
          </div>
          <div className="rounded-lg bg-[rgba(255,255,255,0.03)] p-3">
            <span className="text-[#8A877D]">Categoria principal</span>
            <p className="text-lg font-bold text-[#F0EFE8] mt-1">
              {categoryBreakdown.length > 0 ? `${categoryBreakdown[0].emoji} ${categoryBreakdown[0].categoria}` : '—'}
            </p>
          </div>
          <div className="rounded-lg bg-[rgba(255,255,255,0.03)] p-3">
            <span className="text-[#8A877D]">Comercio frecuente</span>
            <p className="text-lg font-bold text-[#F0EFE8] mt-1 truncate">
              {topMerchants.length > 0 ? topMerchants[0].name : '—'}
            </p>
          </div>
        </div>
      </div>

      </div>{/* end reportRef */}

      {/* Category detail dialog */}
      <Dialog open={!!detailCat} onOpenChange={(open) => { if (!open) setDetailCat(null); }}>
        <DialogContent className="bg-[#1C1C1A] border-[#2A2A28] max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-lg">
              {detailCat && `${getCategoriaEmoji(detailCat)} ${capitalizeDisplay(detailCat)}`}
            </DialogTitle>
          </DialogHeader>
          {detailCat && (
            <div className="space-y-3">
              <p className="text-sm text-[#8A877D]">
                Total: <span className="text-[#D85A30] font-medium">{formatCurrency(detailCatTransactions.reduce((s, t) => s + t.monto_pen, 0))}</span>
                {' '}— {detailCatTransactions.length} {detailCatTransactions.length === 1 ? 'transaccion' : 'transacciones'}
              </p>

              {/* Consolidated breakdown by subcategory */}
              {(() => {
                const subMap = new Map<string, { total: number; count: number }>();
                for (const tx of detailCatTransactions) {
                  const sub = (tx.subcategoria && tx.subcategoria !== 'sin_categoria' && tx.subcategoria !== 'null')
                    ? tx.subcategoria
                    : '(General)';
                  const prev = subMap.get(sub) || { total: 0, count: 0 };
                  prev.total += tx.monto_pen;
                  prev.count += 1;
                  subMap.set(sub, prev);
                }
                const subs = Array.from(subMap.entries())
                  .map(([name, d]) => ({ name, ...d }))
                  .sort((a, b) => b.total - a.total);
                if (subs.length <= 1) return null;
                return (
                  <div className="space-y-1 rounded-xl bg-[rgba(255,255,255,0.02)] p-3">
                    <h4 className="text-xs font-medium text-[#C8C6BC]">Por subcategoría</h4>
                    {subs.map((s) => (
                      <div key={s.name} className="flex items-center gap-2 text-xs">
                        <span className="text-[#C8C6BC]">{s.name === '(General)' ? 'Sin subcategoría' : capitalizeDisplay(s.name)}</span>
                        <span className="text-[#8A877D]">· {s.count}</span>
                        <span className="ml-auto font-medium tabular-nums text-[#F0EFE8]">{formatCurrency(s.total)}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              <div className="space-y-2">
                {detailCatTransactions.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.06)] last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#F0EFE8] whitespace-normal break-words">{tx.comercio || 'Sin comercio'}</p>
                      <p className="text-xs text-[#8A877D]">
                        {tx.fecha} {tx.subcategoria && tx.subcategoria !== 'sin_categoria' ? `· ${capitalizeDisplay(tx.subcategoria)}` : ''}
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

      {/* Payment method detail dialog */}
      <Dialog open={!!detailMetodo} onOpenChange={(open) => { if (!open) setDetailMetodo(null); }}>
        <DialogContent className="bg-[#1C1C1A] border-[#2A2A28] max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-lg">
              {detailMetodo && capitalizeDisplay(detailMetodo)}
            </DialogTitle>
          </DialogHeader>
          {detailMetodo && (() => {
            // Consolidate this payment method's spending by category → subcategory
            const catMap = new Map<string, { total: number; count: number; subs: Map<string, number> }>();
            for (const tx of detailMetodoTransactions) {
              const cat = tx.categoria;
              if (!catMap.has(cat)) catMap.set(cat, { total: 0, count: 0, subs: new Map() });
              const entry = catMap.get(cat)!;
              entry.total += tx.monto_pen;
              entry.count += 1;
              const sub = (tx.subcategoria && tx.subcategoria !== 'sin_categoria' && tx.subcategoria !== 'null')
                ? tx.subcategoria
                : '(General)';
              entry.subs.set(sub, (entry.subs.get(sub) || 0) + tx.monto_pen);
            }
            const catBreakdown = Array.from(catMap.entries())
              .map(([categoria, { total, count, subs }]) => ({
                categoria,
                total,
                count,
                subs: Array.from(subs.entries())
                  .map(([name, monto]) => ({ name, monto }))
                  .sort((a, b) => b.monto - a.monto),
              }))
              .sort((a, b) => b.total - a.total);

            return (
            <div className="space-y-3">
              <p className="text-sm text-[#8A877D]">
                Total: <span className="text-[#D85A30] font-medium">{formatCurrency(detailMetodoTransactions.reduce((s, t) => s + t.monto_pen, 0))}</span>
                {' '}— {detailMetodoTransactions.length} {detailMetodoTransactions.length === 1 ? 'transaccion' : 'transacciones'}
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
                        {tx.fecha} · {getCategoriaEmoji(tx.categoria)} {capitalizeDisplay(tx.categoria)}
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
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Comercio detail dialog */}
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
                {' '}— {detailComercioTransactions.length} {detailComercioTransactions.length === 1 ? 'transaccion' : 'transacciones'}
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

      {/* Daily detail dialog */}
      <Dialog open={detailDay !== null} onOpenChange={(open) => { if (!open) setDetailDay(null); }}>
        <DialogContent className="bg-[#1C1C1A] border-[#2A2A28] max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8]">
              Día {detailDay} — {selectedOption.label}
            </DialogTitle>
          </DialogHeader>
          {detailDayTransactions.length > 0 ? (
            <div>
              <p className="text-sm text-[#8A877D] mb-3">
                <span className="text-[#D85A30] font-semibold">{formatCurrency(detailDayTransactions.reduce((s, t) => s + t.monto_pen, 0))}</span>
                {' '}— {detailDayTransactions.length} {detailDayTransactions.length === 1 ? 'transacción' : 'transacciones'}
              </p>
              <div className="space-y-2">
                {detailDayTransactions.map((t) => (
                  <div key={t.id} className="flex items-start justify-between gap-2 py-2 border-b border-[#2A2A28]">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[#F0EFE8] whitespace-normal break-words">{t.comercio || 'Sin comercio'}</p>
                      <p className="text-xs text-[#8A877D]">
                        {getCategoriaEmoji(t.categoria)} {capitalizeDisplay(t.categoria)}
                        {t.subcategoria ? ` · ${capitalizeDisplay(t.subcategoria)}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-sm text-[#D85A30] font-medium">{formatCurrency(t.monto_pen)}</span>
                      <button onClick={() => setEditTransaction(t)} className="text-[#8A877D] hover:text-[#1D9E75]">
                        <Pencil size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[#8A877D]">No hay gastos este día.</p>
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


      {/* Score Financiero dialog */}
      <Dialog open={showScoreDialog} onOpenChange={setShowScoreDialog}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
          <DialogHeader>
            <DialogTitle>Neto Score</DialogTitle>
          </DialogHeader>

          {/* Score circle - large */}
          <div className="flex justify-center py-4">
            <div className="relative w-32 h-32">
              <svg viewBox="0 0 36 36" className="w-full h-full">
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke="#2A2A28" strokeWidth="3" />
                <motion.path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke={scoreColor}
                  strokeWidth="3" strokeLinecap="round"
                  initial={{ strokeDasharray: '0, 100' }}
                  animate={{ strokeDasharray: `${score}, 100` }}
                  transition={{ duration: 1.2, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.2 }}
                />
              </svg>
              <motion.div
                className="absolute inset-0 flex flex-col items-center justify-center"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 0.4 }}
              >
                <span className="text-3xl font-bold" style={{ color: scoreColor }}>{score}</span>
                <span className="text-xs text-[#8A877D]">de 100</span>
              </motion.div>
            </div>
          </div>

          {/* Status */}
          <div className="text-center mb-4">
            <span className="text-lg font-semibold" style={{ color: scoreColor }}>
              {scoreLabel}
            </span>
          </div>

          {/* Breakdown — 6 factores reales */}
          {netoScoreData?.factors ? (
            <div className="space-y-2 text-sm">
              <h4 className="font-medium text-[#C8C6BC]">Desglose por factor</h4>
              {([ ['Consistencia', netoScoreData.factors.consistency, 20], ['Presupuesto', netoScoreData.factors.budget, 25], ['Ahorro', netoScoreData.factors.savings, 20], ['Planes', netoScoreData.factors.goals, 15], ['Deudas', netoScoreData.factors.debts, 10], ['Visibilidad', netoScoreData.factors.visibility, 10] ] as [string, number, number][]).map(([label, value, weight]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="text-[#8A877D] w-24 shrink-0">{label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-[#2A2A28]">
                    <div className="h-full rounded-full" style={{ width: `${value}%`, backgroundColor: value >= 70 ? '#1D9E75' : value >= 50 ? '#EF9F27' : '#D85A30' }} />
                  </div>
                  <span className="text-xs tabular-nums w-8 text-right" style={{ color: value >= 70 ? '#1D9E75' : value >= 50 ? '#EF9F27' : '#D85A30' }}>{value}</span>
                  <span className="text-xs text-[#8A877D] w-12 text-right">{weight}% peso</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[#8A877D]">Sin datos de factores aún.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </FadeIn>
  );
}

// --- Sub-components ---

function Header({
  selected,
  setSelected,
  monthOptions,
  onDownloadPDF,
  generatingPdf,
}: {
  selected: string;
  setSelected: (v: string) => void;
  monthOptions: { label: string; value: string }[];
  onDownloadPDF: () => void;
  generatingPdf: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileBarChart className="h-6 w-6 text-[#EF9F27]" />
          <h1 className="text-2xl font-bold text-[#F0EFE8]">Reportes</h1>
        </div>
        <HeaderActions />
      </div>
      <div className="flex items-center gap-3">
        <MonthSelector />
        <Button
          variant="outline"
          size="sm"
          className="border-[rgba(255,255,255,0.08)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.04)] active:scale-[0.98] transition-transform"
          onClick={onDownloadPDF}
          disabled={generatingPdf}
        >
          <Download className="h-4 w-4 mr-2" />
          {generatingPdf ? 'Generando...' : 'PDF'}
        </Button>
      </div>
    </div>
  );
}

function ComparisonBadge({ current, previous, invertColor }: { current: number; previous: number; invertColor?: boolean }) {
  if (previous === 0) return null;
  const pctChange = Math.round(((current - previous) / previous) * 100);
  if (pctChange === 0) return null;
  const isUp = pctChange > 0;
  const isPositive = invertColor ? !isUp : isUp;
  const color = isPositive ? '#1D9E75' : '#D85A30';
  const Icon = isUp ? ArrowUp : ArrowDown;
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{ backgroundColor: `${color}18`, color }}
    >
      <Icon className="h-2.5 w-2.5" />
      {Math.abs(pctChange)}%
    </span>
  );
}

function KPICard({
  label,
  value,
  icon,
  color,
  isCurrency = true,
  prevValue,
  invertColor,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  isCurrency?: boolean;
  prevValue?: number;
  invertColor?: boolean;
}) {
  return (
    <div className="glass-card glass-card-glow p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span style={{ color }}>{icon}</span>
          <span className="text-xs text-[#8A877D]">{label}</span>
        </div>
        {prevValue != null && prevValue > 0 && (
          <ComparisonBadge current={value} previous={prevValue} invertColor={invertColor} />
        )}
      </div>
      <p className="text-xl font-bold" style={{ color }}>
        {isCurrency ? formatCurrency(value) : <NumberTicker value={value} className="!text-inherit" />}
      </p>
    </div>
  );
}
