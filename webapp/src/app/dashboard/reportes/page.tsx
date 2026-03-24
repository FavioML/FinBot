'use client';

import { useState, useMemo, useCallback } from 'react';
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
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { formatCurrency, getScoreColor, getScoreLabel } from '@/lib/utils';
import { getCategoriaEmoji, MESES } from '@/lib/constants';
import { capitalizeDisplay } from '@/lib/format';
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

function normalizeMetodoPago(metodo: string | null | undefined): string {
  if (!metodo) return 'Sin especificar';
  let m = metodo.trim();
  m = m.replace(/\bCredito\b/gi, 'Crédito').replace(/\bDebito\b/gi, 'Débito');
  return m;
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
  const { data: transactions = [], isLoading: txLoading } = useTransactions({
    usuarioId: user?.id,
    mes: selectedOption.mes,
    anio: selectedOption.anio,
  });

  const isLoading = userLoading || txLoading;

  // Detail dialogs state
  const [detailCat, setDetailCat] = useState<string | null>(null);
  const [detailMetodo, setDetailMetodo] = useState<string | null>(null);
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
    return transactions.filter((t) => t.tipo === 'gasto' && normalizeMetodoPago(t.metodo_pago) === detailMetodo)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [transactions, detailMetodo]);

  // --- Computed data ---

  const { totalIngresos, totalGastos, ahorro, score } = useMemo(() => {
    const ingresos = transactions.filter((t) => t.tipo === 'ingreso').reduce((s, t) => s + t.monto_pen, 0);
    const gastos = transactions.filter((t) => t.tipo === 'gasto').reduce((s, t) => s + t.monto_pen, 0);
    const ahorro = ingresos - gastos;
    let score = ingresos > 0 ? Math.round(100 - (gastos / ingresos) * 50) : 50;
    score = Math.max(0, Math.min(100, score));
    return { totalIngresos: ingresos, totalGastos: gastos, ahorro, score };
  }, [transactions]);

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
      const method = normalizeMetodoPago(t.metodo_pago);
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
        <Header selected={selected} setSelected={setSelected} monthOptions={monthOptions} />
        <EmptyState
          title="Sin datos para este mes"
          description="Registra tus ingresos y gastos por WhatsApp para generar tu reporte mensual."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Header selected={selected} setSelected={setSelected} monthOptions={monthOptions} />

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
            <span className="text-3xl font-bold" style={{ color: '#F0EFE8' }}>
              <NumberTicker value={score} />
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
              <div key={m.name} className="flex items-center justify-between">
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
            <Bar dataKey="total" fill="#EF9F27" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Category detail dialog */}
      <Dialog open={!!detailCat} onOpenChange={(open) => { if (!open) setDetailCat(null); }}>
        <DialogContent className="glass-card border-[rgba(255,255,255,0.08)] max-w-lg max-h-[80vh] overflow-y-auto">
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
                      <p className="text-sm text-[#F0EFE8] truncate">{tx.comercio || 'Sin comercio'}</p>
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
        <DialogContent className="glass-card border-[rgba(255,255,255,0.08)] max-w-lg max-h-[80vh] overflow-y-auto">
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
                      <p className="text-sm text-[#F0EFE8] truncate">{tx.comercio || 'Sin comercio'}</p>
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
}: {
  selected: string;
  setSelected: (v: string) => void;
  monthOptions: { label: string; value: string }[];
}) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <FileBarChart className="h-6 w-6 text-[#EF9F27]" />
        <h1 className="text-2xl font-bold text-[#F0EFE8]">Reportes</h1>
      </div>
      <div className="flex items-center gap-3">
        <Select value={selected} onValueChange={(v) => v && setSelected(v)}>
          <SelectTrigger className="w-[180px] glass-card border-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {monthOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="border-[rgba(255,255,255,0.08)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.04)]"
          onClick={() => window.print()}
        >
          <Download className="h-4 w-4 mr-2" />
          PDF
        </Button>
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
