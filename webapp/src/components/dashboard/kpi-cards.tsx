'use client';

import { TrendingUp, TrendingDown, Wallet, Activity, ArrowUp, ArrowDown } from 'lucide-react';
import { NumberTicker } from '@/components/ui/number-ticker';
import { StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { getScoreColor, getScoreLabel } from '@/lib/utils';
import type { KPIData } from '@/lib/types';

interface KPICardsProps {
  data: KPIData;
  onScoreClick?: () => void;
}

function ComparisonBadge({ current, previous, invertColor }: { current: number; previous: number; invertColor?: boolean }) {
  if (previous === 0) return null;
  const pctChange = Math.round(((current - previous) / previous) * 100);
  if (pctChange === 0) return null;

  const isUp = pctChange > 0;
  // For gastos, up is bad (red). For ingresos, up is good (green). invertColor flips this.
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
      prev: data.prevIngresos,
      invertColor: false,
    },
    {
      label: 'Total Gastos',
      value: data.totalGastos,
      color: '#D85A30',
      icon: TrendingDown,
      prefix: 'S/ ',
      prev: data.prevGastos,
      invertColor: true,
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
    <StaggerContainer className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        const isScore = card.label === 'Score Financiero';
        return (
          <StaggerItem key={card.label}>
          <div
            className={`glass-card glass-card-glow p-5${isScore && onScoreClick ? ' cursor-pointer hover:border-[#1D9E75]/50 transition-colors group' : ''}`}
            onClick={isScore && onScoreClick ? onScoreClick : undefined}
            title={isScore && onScoreClick ? 'Click para ver desglose' : undefined}
          >
            <div className="flex items-center justify-between mb-3">
              <Icon className="h-5 w-5" style={{ color: '#8A877D' }} />
              <div className="flex items-center gap-1.5">
                {'prev' in card && card.prev != null && card.prev > 0 && (
                  <ComparisonBadge current={card.value} previous={card.prev} invertColor={card.invertColor} />
                )}
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
            </div>
            <p className="text-xs font-medium mb-1" style={{ color: '#8A877D' }}>
              {card.label}
              {isScore && onScoreClick && (
                <span className="ml-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-[#1D9E75]">
                  ver desglose &rarr;
                </span>
              )}
            </p>
            <p className="text-2xl font-bold tracking-tight" style={{ color: card.color }}>
              {card.prefix}
              <NumberTicker
                value={card.value}
                decimalPlaces={card.prefix === 'S/ ' ? 2 : 0}
                className="!text-inherit"
              />
            </p>
            {isScore && (
              <p className="text-[10px] mt-1.5 text-[#8A877D]">
                {data.scoreFinanciero >= 80
                  ? 'Excelente control de tus finanzas'
                  : data.scoreFinanciero >= 60
                    ? 'Buen manejo, puedes mejorar'
                    : 'Tus gastos superan lo recomendado'}
              </p>
            )}
          </div>
          </StaggerItem>
        );
      })}
    </StaggerContainer>
  );
}
