'use client';

import { useMemo } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { WhatsAppButton } from '@/components/shared/whatsapp-button';
import { KPICards } from '@/components/dashboard/kpi-cards';
import { RecentTransactions } from '@/components/dashboard/recent-transactions';
import { InsightCard } from '@/components/dashboard/insight-card';
import { CategoryDonut } from '@/components/charts/category-donut';
import { TrendLine } from '@/components/charts/trend-line';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { CATEGORIA_EMOJI, MESES } from '@/lib/constants';
import type { KPIData, CategoriaGasto, TendenciaMensual } from '@/lib/types';

export default function DashboardPage() {
  const { data: user, isLoading: userLoading } = useUser();

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const { data: transactions = [], isLoading: txLoading } = useTransactions({
    usuarioId: user?.id,
    mes: currentMonth,
    anio: currentYear,
  });

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

    // Simple score: base 50, +25 if saving >20%, +15 if saving >0%, -10 if overspending
    let scoreFinanciero = 50;
    if (ahorroPorcentaje >= 20) scoreFinanciero = 90;
    else if (ahorroPorcentaje >= 10) scoreFinanciero = 75;
    else if (ahorroPorcentaje > 0) scoreFinanciero = 65;
    else scoreFinanciero = 40;

    return { totalIngresos, totalGastos, ahorro, ahorroPorcentaje, scoreFinanciero };
  }, [transactions]);

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
        emoji: CATEGORIA_EMOJI[categoria] || '',
        total,
        porcentaje: (total / totalGastos) * 100,
        transacciones: count,
      }))
      .sort((a, b) => b.total - a.total);
  }, [transactions]);

  // Mock trend data (last 4 months) since multi-month query needs backend
  const trendData = useMemo<TendenciaMensual[]>(() => {
    const months: TendenciaMensual[] = [];
    for (let i = 3; i >= 0; i--) {
      const d = new Date(currentYear, currentMonth - 1 - i, 1);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();

      if (i === 0) {
        // Current month uses real data
        months.push({
          mes: MESES[m],
          mesNum: m,
          anio: y,
          ingresos: kpiData.totalIngresos,
          gastos: kpiData.totalGastos,
        });
      } else {
        // Previous months use placeholder zeros (backend needed)
        months.push({
          mes: MESES[m],
          mesNum: m,
          anio: y,
          ingresos: 0,
          gastos: 0,
        });
      }
    }
    return months;
  }, [currentMonth, currentYear, kpiData]);

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
      <div>
        <h1 className="text-2xl font-bold text-[#F0EFE8]">
          Hola{user.email ? `, ${user.email.split('@')[0]}` : ''}
        </h1>
        <p className="text-sm text-[#8A877D] mt-1">
          Tu resumen financiero &mdash; {MESES[currentMonth]} {currentYear}
        </p>
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

          {/* Recent transactions */}
          <RecentTransactions transactions={transactions} />
        </>
      )}

      {/* AI insight */}
      <InsightCard />

      {/* Floating WhatsApp button */}
      <WhatsAppButton />
    </div>
  );
}
