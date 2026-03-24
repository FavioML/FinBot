'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { WhatsAppButton } from '@/components/shared/whatsapp-button';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { KPICards } from '@/components/dashboard/kpi-cards';
import { InsightCard } from '@/components/dashboard/insight-card';
import { CategoryDonut } from '@/components/charts/category-donut';
import { TrendLine } from '@/components/charts/trend-line';
import { UserMenu } from '@/components/dashboard/user-menu';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useBudgets } from '@/lib/hooks/use-budgets';
import { formatCurrency, formatFecha, calcularScoreFinanciero } from '@/lib/utils';
import { getCategoriaEmoji, MESES } from '@/lib/constants';
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

  // Detect recurring subscriptions from ALL transactions
  const subscriptions = useMemo(() => {
    const gastos = allTransactions.filter(t => t.tipo === 'gasto');
    const byComercio = new Map<string, { months: Set<string>; amounts: number[]; categoria: string }>();

    for (const t of gastos) {
      const key = (t.comercio || '').toLowerCase().trim();
      if (!key || key === 'sin comercio') continue;
      if (!byComercio.has(key)) byComercio.set(key, { months: new Set(), amounts: [], categoria: t.categoria });
      const entry = byComercio.get(key)!;
      entry.months.add(t.fecha.substring(0, 7));
      entry.amounts.push(t.monto_pen);
    }

    const subs: { comercio: string; monthlyAvg: number; annualProjection: number; categoria: string; months: number }[] = [];

    for (const [comercio, data] of byComercio) {
      if (data.months.size >= 2) {
        const avg = data.amounts.reduce((s, a) => s + a, 0) / data.months.size;
        subs.push({
          comercio: comercio.charAt(0).toUpperCase() + comercio.slice(1),
          monthlyAvg: avg,
          annualProjection: avg * 12,
          categoria: data.categoria,
          months: data.months.size,
        });
      }
    }

    return subs.sort((a, b) => b.annualProjection - a.annualProjection);
  }, [allTransactions]);

  const isLoading = userLoading || txLoading;

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-[320px] rounded-2xl" />
          <Skeleton className="h-[320px] rounded-2xl" />
        </div>
        <Skeleton className="h-[400px] rounded-2xl" />
      </div>
    );
  }

  // Empty state when no user or no transactions
  if (!user) {
    return (
      <>
        <EmptyState
          title="Inicia sesion para ver tu dashboard"
          description="Conecta tu cuenta para visualizar tus finanzas personales."
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
            Hola{user.nombre ? `, ${user.nombre}` : user.email ? `, ${user.email.split('@')[0]}` : ''}
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
        <EmptyState
          title="Sin transacciones este mes"
          description="Envia tus comprobantes por WhatsApp y NETO los registra automaticamente."
        />
      ) : (
        <>
          {/* KPI cards */}
          <KPICards data={kpiData} />

          {/* Charts row */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TrendLine data={trendData} />
            <CategoryDonut data={categoryData} />
          </div>

          {/* Transacciones Recientes + Suscripciones side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Transacciones Recientes */}
            <div className="glass-card p-5">
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
                        className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-[rgba(255,255,255,0.03)]"
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
                <p className="text-sm text-[#8A877D]">Sin transacciones recientes</p>
              )}
            </div>

            {/* Suscripciones */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-[#C8C6BC]">Suscripciones detectadas</h3>
                <span className="text-xs text-[#8A877D]">Proyeccion anual</span>
              </div>
              {subscriptions.length > 0 ? (
                <div className="space-y-3">
                  {subscriptions.slice(0, 8).map((sub) => (
                    <div key={sub.comercio} className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-[#F0EFE8]">{getCategoriaEmoji(sub.categoria)} {sub.comercio}</p>
                        <p className="text-xs text-[#8A877D]">{sub.months} meses &middot; ~{formatCurrency(sub.monthlyAvg)}/mes</p>
                      </div>
                      <p className="text-sm text-[#D85A30] font-medium">{formatCurrency(sub.annualProjection)}/ano</p>
                    </div>
                  ))}
                  <div className="border-t border-[rgba(255,255,255,0.06)] pt-3 flex justify-between">
                    <p className="text-sm font-medium text-[#C8C6BC]">Total proyectado anual</p>
                    <p className="text-sm font-bold text-[#D85A30]">{formatCurrency(subscriptions.reduce((s, sub) => s + sub.annualProjection, 0))}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-[#8A877D]">No se detectaron suscripciones recurrentes.</p>
              )}
            </div>
          </div>
        </>
      )}

      {/* AI insight */}
      <InsightCard />

      {/* Floating WhatsApp button */}
      <WhatsAppButton />
    </div>
  );
}
