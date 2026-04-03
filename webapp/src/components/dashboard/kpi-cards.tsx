'use client';

import Link from 'next/link';
import { TrendingUp, TrendingDown, Wallet, ArrowUp, ArrowDown } from 'lucide-react';
import { NumberTicker } from '@/components/ui/number-ticker';
import { StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { Sparkline } from '@/components/charts/sparkline';
import type { KPIData } from '@/lib/types';

interface KPICardsProps {
  data: KPIData;
  sparklines?: {
    ingresos: number[];
    gastos: number[];
    ahorro: number[];
    score: number[];
  };
  netoScore?: { score: number | null } | null;
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

function MiniScoreRing({ score }: { score: number }) {
  const r = 18;
  const strokeW = 3;
  const size = (r + strokeW) * 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score));
  const offset = circ * (1 - pct / 100);
  const color = score >= 80 ? '#1D9E75' : score >= 60 ? '#3B9EDB' : score >= 40 ? '#E8A838' : '#E85D3A';

  return (
    <Link href="/dashboard/score" className="relative shrink-0 group" title="Tu Neto Score">
      <svg width={size} height={size} className="block -rotate-90">
        <circle cx={r + strokeW} cy={r + strokeW} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeW} />
        <circle
          cx={r + strokeW} cy={r + strokeW} r={r} fill="none"
          stroke={color} strokeWidth={strokeW}
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center text-[10px] font-bold"
        style={{ color }}
      >
        {score}
      </span>
    </Link>
  );
}

export function KPICards({ data, sparklines, netoScore }: KPICardsProps) {
  const ahorroColor = data.ahorro >= 0 ? '#1D9E75' : '#EF9F27';
  const scoreValue = netoScore?.score;

  const cards = [
    {
      label: 'Total Ingresos',
      value: data.totalIngresos,
      color: '#1D9E75',
      icon: TrendingUp,
      prefix: 'S/ ',
      prev: data.prevIngresos,
      invertColor: false,
      spark: sparklines?.ingresos,
      showScore: false,
    },
    {
      label: 'Total Gastos',
      value: data.totalGastos,
      color: '#D85A30',
      icon: TrendingDown,
      prefix: 'S/ ',
      prev: data.prevGastos,
      invertColor: true,
      spark: sparklines?.gastos,
      showScore: false,
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
      spark: sparklines?.ahorro,
      showScore: true,
    },
  ];

  return (
    <StaggerContainer className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <StaggerItem key={card.label}>
          <div className="glass-card glass-card-glow p-5">
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
            </p>
            <div className="flex items-end justify-between gap-2">
              <p className="text-2xl font-bold tracking-tight" style={{ color: card.color }}>
                {card.prefix}
                <NumberTicker
                  value={card.value}
                  decimalPlaces={card.prefix === 'S/ ' ? 2 : 0}
                  className="!text-inherit"
                />
              </p>
              {card.showScore && scoreValue != null ? (
                <MiniScoreRing score={scoreValue} />
              ) : card.spark && card.spark.length >= 2 ? (
                <Sparkline data={card.spark} color={card.color} />
              ) : null}
            </div>
          </div>
          </StaggerItem>
        );
      })}
    </StaggerContainer>
  );
}
