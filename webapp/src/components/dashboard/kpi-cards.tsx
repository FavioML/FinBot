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

/* Mobile hero — Ahorro dominates the first viewport.
 * The single most important number in an expense tracker is "what did
 * I keep this month?". On mobile we give it 44px+ and visual isolation.
 */
function MobileAhorroHero({
  value,
  color,
  sparkline,
  scoreValue,
  porcentaje,
}: {
  value: number;
  color: string;
  sparkline?: number[];
  scoreValue?: number | null;
  porcentaje: number;
}) {
  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Wallet className="h-[18px] w-[18px]" style={{ color: '#8A877D' }} />
          <p className="text-xs font-medium uppercase tracking-wider" style={{ color: '#8A877D' }}>
            Ahorro del mes
          </p>
        </div>
        {scoreValue != null && <MiniScoreRing score={scoreValue} />}
      </div>
      <p
        className="text-[40px] font-bold tracking-tight leading-none"
        style={{ color }}
      >
        S/{' '}
        <NumberTicker value={value} decimalPlaces={2} className="!text-inherit" />
      </p>
      <div className="mt-3 flex items-center justify-between gap-3">
        {porcentaje !== 0 && (
          <span
            className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ backgroundColor: `${color}1F`, color }}
          >
            {porcentaje >= 0 ? '+' : ''}
            {porcentaje.toFixed(1)}% vs mes anterior
          </span>
        )}
        {sparkline && sparkline.length >= 2 && (
          <div className="ml-auto">
            <Sparkline data={sparkline} color={color} />
          </div>
        )}
      </div>
    </div>
  );
}

/* Mobile compact KPI — for Ingresos / Gastos below the hero.
 * Half-width on mobile, uses 20px number (readable but subordinate).
 */
function MobileCompactKPI({
  label,
  value,
  color,
  icon: Icon,
  prev,
  invertColor,
}: {
  label: string;
  value: number;
  color: string;
  icon: typeof TrendingUp;
  prev?: number;
  invertColor?: boolean;
}) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-2">
        <Icon className="h-4 w-4" style={{ color: '#8A877D' }} />
        {prev != null && prev > 0 && (
          <ComparisonBadge current={value} previous={prev} invertColor={invertColor} />
        )}
      </div>
      <p className="text-[11px] font-medium mb-1" style={{ color: '#8A877D' }}>
        {label}
      </p>
      <p className="text-xl font-bold tracking-tight leading-none" style={{ color }}>
        S/{' '}
        <NumberTicker value={value} decimalPlaces={2} className="!text-inherit" />
      </p>
    </div>
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
    <>
      {/* Mobile-only hero layout (< sm breakpoint, 640px) */}
      <div className="sm:hidden space-y-3">
        <MobileAhorroHero
          value={data.ahorro}
          color={ahorroColor}
          sparkline={sparklines?.ahorro}
          scoreValue={scoreValue}
          porcentaje={data.ahorroPorcentaje}
        />
        <div className="grid grid-cols-2 gap-3">
          <MobileCompactKPI
            label="Ingresos"
            value={data.totalIngresos}
            color="#1D9E75"
            icon={TrendingUp}
            prev={data.prevIngresos}
          />
          <MobileCompactKPI
            label="Gastos"
            value={data.totalGastos}
            color="#D85A30"
            icon={TrendingDown}
            prev={data.prevGastos}
            invertColor
          />
        </div>
      </div>

      {/* Desktop layout — unchanged 3-col grid */}
      <StaggerContainer className="hidden sm:grid sm:grid-cols-3 sm:gap-4">
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
    </>
  );
}
