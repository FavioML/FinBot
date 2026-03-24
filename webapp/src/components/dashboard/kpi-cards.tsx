'use client';

import { TrendingUp, TrendingDown, Wallet, Activity } from 'lucide-react';
import { NumberTicker } from '@/components/ui/number-ticker';
import { getScoreColor, getScoreLabel } from '@/lib/utils';
import type { KPIData } from '@/lib/types';

interface KPICardsProps {
  data: KPIData;
  onScoreClick?: () => void;
}

export function KPICards({ data, onScoreClick }: KPICardsProps) {
  const ahorroColor = data.ahorro >= 0 ? '#1D9E75' : '#EF9F27';
  const scoreColor = getScoreColor(data.scoreFinanciero);

  const cards = [
    {
      label: 'Total Ingresos',
      value: data.totalIngresos,
      color: '#1D9E75',
      icon: TrendingUp,
      prefix: 'S/ ',
    },
    {
      label: 'Total Gastos',
      value: data.totalGastos,
      color: '#D85A30',
      icon: TrendingDown,
      prefix: 'S/ ',
    },
    {
      label: 'Ahorro',
      value: data.ahorro,
      color: ahorroColor,
      icon: Wallet,
      prefix: 'S/ ',
      badge: data.ahorroPorcentaje !== 0
        ? `${data.ahorroPorcentaje >= 0 ? '+' : ''}${data.ahorroPorcentaje.toFixed(1)}%`
        : undefined,
    },
    {
      label: 'Score Financiero',
      value: data.scoreFinanciero,
      color: scoreColor,
      icon: Activity,
      prefix: '',
      badge: getScoreLabel(data.scoreFinanciero),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        const isScore = card.label === 'Score Financiero';
        return (
          <div
            key={card.label}
            className={`glass-card p-5${isScore && onScoreClick ? ' cursor-pointer hover:border-[#1D9E75]/50 transition-colors' : ''}`}
            onClick={isScore && onScoreClick ? onScoreClick : undefined}
          >
            <div className="flex items-center justify-between mb-3">
              <Icon className="h-5 w-5" style={{ color: '#8A877D' }} />
              {card.badge && (
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: `${card.color}18`,
                    color: card.color,
                  }}
                >
                  {card.badge}
                </span>
              )}
            </div>
            <p className="text-xs font-medium mb-1" style={{ color: '#8A877D' }}>
              {card.label}
            </p>
            <p className="text-2xl font-bold tracking-tight" style={{ color: card.color }}>
              {card.prefix}
              <NumberTicker
                value={card.value}
                decimalPlaces={card.prefix === 'S/ ' ? 2 : 0}
                className="!text-inherit"
              />
            </p>
          </div>
        );
      })}
    </div>
  );
}
