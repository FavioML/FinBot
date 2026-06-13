'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Lock, Lightbulb, PartyPopper, Gauge } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { ScoreGauge } from '@/components/charts/score-gauge';
import { useNetoScoreHistory, type NetoScoreFactors } from '@/lib/hooks/use-neto-score';
import { useUser } from '@/lib/hooks/use-user';
import { canAccess } from '@/lib/plan';
import { ProGate } from '@/components/shared/pro-gate';
import { EmptyState } from '@/components/shared/empty-state';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { ScoreSkeleton } from '@/components/dashboard/skeletons';
import { HeaderActions } from '@/components/dashboard/topbar';

const FACTORS = [
  { key: 'consistency', label: 'Consistencia de registro', description: 'Registras tus gastos con regularidad' },
  { key: 'budget', label: 'Control de presupuesto', description: 'Cumples con tus límites por categoría' },
  { key: 'savings', label: 'Capacidad de ahorro', description: 'Porcentaje de ingresos que ahorras' },
  { key: 'goals', label: 'Progreso en planes', description: 'Avance en tus metas de ahorro' },
  { key: 'debts', label: 'Gestión de deudas', description: 'Estado de tus deudas compartidas' },
  { key: 'visibility', label: 'Visibilidad financiera', description: 'Claridad sobre tu situación financiera' },
] as const;

function FactorBar({ label, description, value }: { label: string; description: string; value: number }) {
  const color = value >= 80 ? '#1D9E75' : value >= 60 ? '#378ADD' : value >= 40 ? '#EF9F27' : '#D85A30';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-[#F0EFE8]">{label}</p>
          <p className="text-xs text-[#8A877D]">{description}</p>
        </div>
        <span className="text-sm font-semibold tabular-nums" style={{ color }}>{value}</span>
      </div>
      <div className="h-2 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${value}%`, background: color, boxShadow: `0 0 8px ${color}66` }}
        />
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card px-3 py-2 text-xs">
      <p className="text-[#8A877D] mb-0.5">{label}</p>
      <p className="text-[#1D9E75] font-semibold">{payload[0].value} pts</p>
    </div>
  );
}

const TIPS_MAP: Record<string, string> = {
  consistency: 'Registra al menos un gasto al día — el hábito es lo que más pesa en tu score',
  budget: 'Revisa las categorías donde excedes el límite y ajusta montos realistas',
  savings: 'Intenta ahorrar al menos el 10% de tus ingresos este mes',
  goals: 'Haz aportes semanales pequeños pero constantes a tus planes de ahorro',
  debts: 'Prioriza las deudas con vencimiento más cercano y registra cada abono',
  visibility: 'Crea presupuestos por categoría y conecta tu Gmail para lectura automática',
};

const FACTOR_LABELS: Record<string, string> = {
  consistency: 'Consistencia de registro',
  budget: 'Control de presupuesto',
  savings: 'Capacidad de ahorro',
  goals: 'Progreso en planes',
  debts: 'Gestión de deudas',
  visibility: 'Visibilidad financiera',
};

function TipsSection({ factors }: { factors?: NetoScoreFactors }) {
  if (!factors) return <p className="text-[#8A877D] text-sm">Sin datos de factores aún.</p>;

  const weak = (Object.entries(factors) as [string, number][])
    .filter(([, v]) => v < 70)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 3);

  if (weak.length === 0) {
    return (
      <div className="flex items-center gap-3 py-2">
        <PartyPopper className="w-5 h-5 text-[#1D9E75] shrink-0" />
        <p className="text-sm text-[#C8C6BC]">
          Todos tus factores están por encima de 70. ¡Excelente trabajo! Sigue así para mantener tu score alto.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {weak.map(([key, value]) => {
        const color = value >= 60 ? '#378ADD' : value >= 40 ? '#EF9F27' : '#D85A30';
        return (
          <div key={key} className="flex items-start gap-3 p-3 rounded-lg bg-[rgba(255,255,255,0.02)]">
            <Lightbulb className="w-4 h-4 mt-0.5 shrink-0" style={{ color }} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-medium text-[#C8C6BC]">{FACTOR_LABELS[key]}</span>
                <span className="text-xs font-bold tabular-nums" style={{ color }}>{value}</span>
              </div>
              <p className="text-xs text-[#8A877D]">{TIPS_MAP[key]}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ScorePage() {
  const { data: user } = useUser();
  const { data, isLoading } = useNetoScoreHistory(6);

  const canBreakdown = canAccess(user?.plan, 'score_breakdown');
  const canTips = canAccess(user?.plan, 'score_tips');
  const canHistory = canAccess(user?.plan, 'score_history');

  if (isLoading) {
    return (
      <ScoreSkeleton />
    );
  }

  if (!data?.score) {
    return (
      <div className="max-w-3xl mx-auto">
        <EmptyState
          title="Aún no tienes un Neto Score"
          description="Registra tus gastos durante el mes y NETO calculará tu puntuación de salud financiera."
          icon={Gauge}
          showWhatsApp={false}
        />
      </div>
    );
  }

  const chartData = (data.history || []).map((h) => ({
    period: h.period.slice(0, 7), // YYYY-MM
    score: h.score,
  }));

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#F0EFE8]">Neto Score</h1>
            <p className="text-[#8A877D] text-sm mt-1">Tu puntuación de salud financiera este mes</p>
          </div>
          <HeaderActions />
        </div>
      </FadeIn>

      {/* Score gauge grande */}
      <FadeIn delay={0.05}>
        <div className="glass-card p-8 flex flex-col items-center max-w-md mx-auto">
          <ScoreGauge score={data.score} size="lg" />
          <p className="text-xs text-[#8A877D] mt-2">Periodo: {data.period?.slice(0, 7)}</p>
        </div>
      </FadeIn>

      {/* Desglose por factor */}
      <FadeIn delay={0.1}>
        <div className="glass-card p-6">
          <h2 className="text-section font-semibold text-[#F0EFE8] mb-4">Desglose por factor</h2>

          {canBreakdown ? (
            <div className="space-y-4">
              {FACTORS.map((f) => (
                <FactorBar
                  key={f.key}
                  label={f.label}
                  description={f.description}
                  value={data.factors?.[f.key] ?? 0}
                />
              ))}
            </div>
          ) : (
            <div className="relative">
              <div className="blur-sm pointer-events-none select-none space-y-4">
                {FACTORS.map((f) => (
                  <FactorBar key={f.key} label={f.label} description={f.description} value={60 + Math.floor(Math.random() * 30)} />
                ))}
              </div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="glass-card p-5 text-center max-w-xs">
                  <Lock className="w-6 h-6 mx-auto mb-2 text-[#8A877D]" />
                  <p className="text-sm font-medium text-[#F0EFE8] mb-1">Desbloquea con Pro</p>
                  <p className="text-xs text-[#8A877D] mb-3">Ve qué factores mejorar para subir tu score</p>
                  <Link
                    href="/dashboard/configuracion"
                    className="inline-block rounded-lg bg-[#1D9E75] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#1D9E75]/90 transition-colors"
                  >
                    Ver planes →
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </FadeIn>

      {/* Gráfico de evolución */}
      <FadeIn delay={0.15}>
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-section font-semibold text-[#F0EFE8]">Evolución</h2>
            {!canHistory && (
              <span className="flex items-center gap-1 text-xs text-[#8A877D]">
                <Lock className="w-3 h-3" /> Últimos 6 meses con Pro
              </span>
            )}
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={canHistory ? chartData : chartData.slice(-1)}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="period"
                  tick={{ fill: '#8A877D', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: '#8A877D', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={28}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="#1D9E75"
                  strokeWidth={2.5}
                  dot={{ fill: '#1D9E75', r: 4, strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: '#1D9E75' }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-[#8A877D] text-sm text-center py-8">Sin historial aún</p>
          )}
          {!canHistory && chartData.length > 0 && (
            <div className="mt-4">
              <ProGate
                featureName="Historial completo"
                description="Accede a los últimos 6 meses de evolución de tu score financiero"
              />
            </div>
          )}
        </div>
      </FadeIn>

      {/* Tips section */}
      <FadeIn delay={0.2}>
        <div className="glass-card p-6">
          <h2 className="text-section font-semibold text-[#F0EFE8] mb-3">Tips personalizados</h2>
          {canTips ? (
            <TipsSection factors={data.factors} />
          ) : (
            <ProGate
              featureName="Tips personalizados"
              description="Neto analiza tus factores más débiles y te da recomendaciones concretas para subir tu score"
            />
          )}
        </div>
      </FadeIn>
    </div>
  );
}
