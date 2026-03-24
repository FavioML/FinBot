'use client';

import { useState, useMemo, useCallback, useRef } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
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
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { NumberTicker } from '@/components/ui/number-ticker';
import { TransactionForm } from '@/components/dashboard/transaction-form';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { UserMenu } from '@/components/dashboard/user-menu';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { formatCurrency, getScoreColor, getScoreLabel, calcularScoreFinanciero } from '@/lib/utils';
import { getCategoriaEmoji, MESES } from '@/lib/constants';
import { capitalizeDisplay, normalizeMetodoPago } from '@/lib/format';
import type { Transaccion } from '@/lib/types';
import {
  PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  FileBarChart, Download, TrendingUp, TrendingDown,
  Wallet, Activity, Pencil,
} from 'lucide-react';

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

const PIE_COLORS = ['#1D9E75', '#EF9F27', '#D85A30', '#3B82F6', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

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
  const { data: transactions = [], isLoading: txLoading } = useTransactions({
    usuarioId: user?.id,
    mes: selectedOption.mes,
    anio: selectedOption.anio,
  });

  const { data: budgets = [] } = useBudgets(user?.id);

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
    } catch (err) {
      console.error('[PDF] Error generating:', err);
    } finally {
      setGeneratingPdf(false);
    }
  }, [generatingPdf, selectedOption]);

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

  const { totalIngresos, totalGastos, ahorro, score } = useMemo(() => {
    const ingresos = transactions.filter((t) => t.tipo === 'ingreso').reduce((s, t) => s + t.monto_pen, 0);
    const gastos = transactions.filter((t) => t.tipo === 'gasto').reduce((s, t) => s + t.monto_pen, 0);
    const ahorro = ingresos - gastos;

    // Count exceeded budgets
    const categoryBudgets = budgets.filter(b => !b.subcategoria);
    let presExcedidos = 0;
    for (const b of categoryBudgets) {
      const gastado = transactions
        .filter(t => t.tipo === 'gasto' && t.categoria?.toLowerCase() === b.categoria?.toLowerCase())
        .reduce((s, t) => s + t.monto_pen, 0);
      if (gastado > parseFloat(String(b.monto_limite))) presExcedidos++;
    }

    const score = calcularScoreFinanciero(gastos, ingresos, presExcedidos);
    return { totalIngresos: ingresos, totalGastos: gastos, ahorro, score };
  }, [transactions, budgets]);

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

  const txCount = transactions.length;

  // --- Score SVG ---
  const scoreColor = getScoreColor(score);
  const scoreLabel = getScoreLabel(score);
  const circumference = 2 * Math.PI * 54;
  const strokeDash = (score / 100) * circumference;

  // --- Render ---

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-10 w-48" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <Skeleton className="h-64 rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!isLoading && transactions.length === 0) {
    return (
      <div className="space-y-6">
        <Header selected={selected} setSelected={setSelected} monthOptions={monthOptions} onDownloadPDF={handleDownloadPDF} generatingPdf={generatingPdf} />
        <EmptyState
          title="Sin datos para este mes"
          description="Registra tus ingresos y gastos por WhatsApp para generar tu reporte mensual."
        />
      </div>
    );
  }

  return (
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
      <div className="glass-card p-6 flex flex-col sm:flex-row items-center gap-6">
        <div className="relative flex-shrink-0">
          <svg width="128" height="128" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="54" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
            <circle
              cx="60" cy="60" r="54" fill="none"
              stroke={scoreColor} strokeWidth="8" strokeLinecap="round"
              strokeDasharray={`${strokeDash} ${circumference}`}
              transform="rotate(-90 60 60)"
              className="transition-all duration-700"
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard
          label="Ingresos"
          value={totalIngresos}
          icon={<TrendingUp className="h-4 w-4" />}
          color="#1D9E75"
        />
        <KPICard
          label="Gastos"
          value={totalGastos}
          icon={<TrendingDown className="h-4 w-4" />}
          color="#D85A30"
        />
        <KPICard
          label="Ahorro neto"
          value={ahorro}
          icon={<Wallet className="h-4 w-4" />}
          color={ahorro >= 0 ? '#1D9E75' : '#D85A30'}
        />
        <KPICard
          label="Transacciones"
          value={txCount}
          icon={<Activity className="h-4 w-4" />}
          color="#EF9F27"
          isCurrency={false}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Category BarChart */}
        <div className="glass-card p-5">
          <h4 className="text-sm font-medium text-[#C8C6BC] mb-4">Gastos por categoria</h4>
          {categoryBreakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(200, categoryBreakdown.length * 40)}>
              <BarChart data={categoryBreakdown} layout="vertical" margin={{ left: 10, right: 20 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category" dataKey="label" width={140}
                  tick={{ fill: '#C8C6BC', fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1C1C1A', border: '1px solid #2A2A28', borderRadius: 8 }}
                  labelStyle={{ color: '#F0EFE8' }}
                  itemStyle={{ color: '#F0EFE8' }}
                  formatter={(v) => formatCurrency(Number(v))}
                />
                <Bar
                  dataKey="total"
                  radius={[0, 6, 6, 0]}
                  onClick={(data: any) => {
                    if (data && data.categoria) setDetailCat(data.categoria);
                  }}
                  cursor="pointer"
                >
                  {categoryBreakdown.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-[#8A877D] text-center py-8">Sin gastos registrados</p>
          )}
        </div>

        {/* Payment methods PieChart */}
        <div className="glass-card p-5">
          <h4 className="text-sm font-medium text-[#C8C6BC] mb-4">Metodos de pago</h4>
          {paymentMethods.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={paymentMethods} dataKey="value" nameKey="name"
                  cx="50%" cy="50%" innerRadius={55} outerRadius={90}
                  paddingAngle={3} strokeWidth={0}
                  onClick={(data: any) => {
                    if (data && data.name) setDetailMetodo(data.name);
                  }}
                  cursor="pointer"
                >
                  {paymentMethods.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#1A1A18', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#F0EFE8' }}
                  formatter={(v) => formatCurrency(Number(v))}
                />
                <Legend
                  formatter={(value: string) => <span className="text-xs text-[#C8C6BC]">{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-[#8A877D] text-center py-8">Sin datos</p>
          )}
        </div>
      </div>

      {/* Top merchants */}
      {topMerchants.length > 0 && (
        <div className="glass-card p-5">
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
      <div className="glass-card p-5">
        <h4 className="text-sm font-medium text-[#C8C6BC] mb-4">Gasto diario</h4>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={dailySpending} margin={{ left: 0, right: 0 }}>
            <XAxis
              dataKey="day" tick={{ fill: '#8A877D', fontSize: 11 }}
              axisLine={false} tickLine={false}
            />
            <YAxis hide />
            <Tooltip
              contentStyle={{ background: '#1A1A18', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#F0EFE8' }}
              formatter={(v) => formatCurrency(Number(v))}
              labelFormatter={(l) => `Dia ${l}`}
            />
            <Bar dataKey="total" fill="#EF9F27" radius={[4, 4, 0, 0]} cursor="pointer"
              onClick={(data: any) => { if (data && data.day && data.total > 0) setDetailDay(data.day); }}
            />
          </BarChart>
        </ResponsiveContainer>
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
          {detailMetodo && (
            <div className="space-y-3">
              <p className="text-sm text-[#8A877D]">
                Total: <span className="text-[#D85A30] font-medium">{formatCurrency(detailMetodoTransactions.reduce((s, t) => s + t.monto_pen, 0))}</span>
                {' '}— {detailMetodoTransactions.length} {detailMetodoTransactions.length === 1 ? 'transaccion' : 'transacciones'}
              </p>
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
          )}
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
    </div>
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
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <FileBarChart className="h-6 w-6 text-[#EF9F27]" />
        <h1 className="text-2xl font-bold text-[#F0EFE8]">Reportes</h1>
      </div>
      <div className="flex items-center gap-3">
        <MonthSelector />
        <Button
          variant="outline"
          size="sm"
          className="border-[rgba(255,255,255,0.08)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.04)]"
          onClick={onDownloadPDF}
          disabled={generatingPdf}
        >
          <Download className="h-4 w-4 mr-2" />
          {generatingPdf ? 'Generando...' : 'PDF'}
        </Button>
        <UserMenu />
      </div>
    </div>
  );
}

function KPICard({
  label,
  value,
  icon,
  color,
  isCurrency = true,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  isCurrency?: boolean;
}) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color }}>{icon}</span>
        <span className="text-xs text-[#8A877D]">{label}</span>
      </div>
      <p className="text-xl font-bold" style={{ color }}>
        {isCurrency ? formatCurrency(value) : <NumberTicker value={value} className="!text-inherit" />}
      </p>
    </div>
  );
}
