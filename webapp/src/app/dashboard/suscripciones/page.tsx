'use client';

// User-specific data (Supabase) — must render dynamically, never prerendered.
export const dynamic = 'force-dynamic';

import { useState, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  CreditCard,
  TrendingDown,
  Users,
  Eye,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Info,
  Calendar,
} from 'lucide-react';
import { SuscripcionesSkeleton } from '@/components/dashboard/skeletons';
import { EmptyState } from '@/components/shared/empty-state';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { useUser } from '@/lib/hooks/use-user';
import { useSubscriptions } from '@/lib/hooks/use-subscriptions';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { MESES, SOCIAL_LINKS } from '@/lib/constants';
import {
  TIPO_LABELS,
  formatPrecio,
  formatPrecioConversion,
  TC_APROXIMADO,
} from '@/lib/subscriptions-catalog';
import type { SuscripcionDetectada, TipoSuscripcion } from '@/lib/subscriptions-catalog';
import { HeaderActions } from '@/components/dashboard/topbar';

// ═══════════════════════════════════════════════════════════════
// SUSCRIPCIONES PAGE — Vista de suscripciones detectadas
// ═══════════════════════════════════════════════════════════════

function KPICard({
  icon: Icon,
  label,
  value,
  sub,
  accent = false,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="glass-card glass-card-glow p-4">
      <div className="flex items-center gap-2 text-[#8A877D] text-xs mb-2">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <p className={`text-xl font-semibold ${accent ? 'text-[#1D9E75]' : 'text-[#C8C6BC]'}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-[#8A877D] mt-1">{sub}</p>}
    </div>
  );
}

function SubscriptionCard({
  sub,
  expanded,
  onToggle,
}: {
  sub: SuscripcionDetectada;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tipoInfo = TIPO_LABELS[sub.tipo] || TIPO_LABELS.otro;

  return (
    <div className="glass-card overflow-hidden hover:border-white/[0.1] transition-all duration-200">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 hover:bg-[rgba(255,255,255,0.02)] transition-colors text-left"
      >
        <span className="text-2xl shrink-0">{sub.icono}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[#C8C6BC] font-medium truncate">{sub.nombre}</span>
            {sub.estado === 'posible' && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[rgba(255,193,7,0.15)] text-[#FFC107]">
                Posible
              </span>
            )}
            {(() => {
              const lastPayDate = new Date(sub.ultimo_pago + 'T12:00:00');
              const daysSince = Math.floor((Date.now() - lastPayDate.getTime()) / (1000 * 60 * 60 * 24));
              if (daysSince > 45) {
                return (
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[rgba(239,159,39,0.12)] text-[#EF9F27]">
                    Sin cobro hace {daysSince} dias
                  </span>
                );
              }
              return null;
            })()}
          </div>
          <div className="flex items-center gap-2 text-xs text-[#8A877D] mt-0.5">
            <span>{tipoInfo.emoji} {tipoInfo.label}</span>
            <span>·</span>
            <span>{sub.meses_detectados} mes{sub.meses_detectados !== 1 ? 'es' : ''}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[#C8C6BC] font-medium">
            {formatPrecio(sub.monto_detectado, sub.moneda)}
          </p>
          {sub.moneda === 'USD' && (
            <p className="text-[10px] text-[#8A877D]">
              ≈ S/{sub.monto_pen.toFixed(0)}/mes
            </p>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-[#8A877D] shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[#8A877D] shrink-0" />
        )}
      </button>

      {/* Expanded details */}
      <AnimatePresence>
      {expanded && (
        <motion.div
          className="border-t border-[rgba(255,255,255,0.04)] px-4 py-3 space-y-3"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* Info row */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-[#8A877D]">Último pago</span>
              <p className="text-[#C8C6BC] mt-0.5">{formatDate(sub.ultimo_pago)}</p>
            </div>
            <div>
              <span className="text-[#8A877D]">Categoría NETO</span>
              <p className="text-[#C8C6BC] mt-0.5">{sub.categoria_neto}</p>
            </div>
          </div>

          {/* Plans comparison */}
          {sub.planes_disponibles.length > 0 && (
            <div>
              <p className="text-xs text-[#8A877D] mb-1.5">Planes disponibles</p>
              <div className="space-y-1">
                {sub.planes_disponibles.map((plan) => {
                  const isCurrentPlan =
                    sub.precio_referencia !== null &&
                    Math.abs(plan.precio - sub.monto_detectado) < 1;
                  return (
                    <div
                      key={plan.nombre}
                      className={`flex items-center justify-between text-xs px-2.5 py-1.5 rounded-lg ${
                        isCurrentPlan
                          ? 'bg-[rgba(29,158,117,0.1)] border border-[rgba(29,158,117,0.2)]'
                          : 'bg-[rgba(255,255,255,0.02)]'
                      }`}
                    >
                      <span className={isCurrentPlan ? 'text-[#1D9E75]' : 'text-[#8A877D]'}>
                        {plan.nombre}
                        {isCurrentPlan && ' (actual)'}
                      </span>
                      <span className={isCurrentPlan ? 'text-[#1D9E75]' : 'text-[#C8C6BC]'}>
                        {formatPrecioConversion(plan.precio, sub.moneda)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Family plan tip */}
          {sub.tiene_plan_familiar && sub.precio_familiar && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-[rgba(29,158,117,0.06)] border border-[rgba(29,158,117,0.1)]">
              <Users className="h-3.5 w-3.5 text-[#1D9E75] mt-0.5 shrink-0" />
              <p className="text-xs text-[#1D9E75]">
                Plan familiar: {formatPrecio(sub.precio_familiar, sub.moneda)}/mes.
                Si compartes, cada uno paga ≈ {formatPrecio(sub.precio_familiar / 2, sub.moneda)}
              </p>
            </div>
          )}

          {/* Gasto anual proyectado */}
          <div className="flex items-center justify-between text-xs px-2.5 py-2 rounded-lg bg-[rgba(255,255,255,0.02)]">
            <span className="text-[#8A877D]">Gasto anual proyectado</span>
            <span className="text-[#C8C6BC] font-medium">
              ≈ S/{(sub.monto_pen * 12).toFixed(0)}
            </span>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

function MonthlySubscriptionCard({
  sub,
  pagos,
  monthLabel,
}: {
  sub: SuscripcionDetectada;
  pagos: { monto: number; monto_pen: number; moneda: string; fecha: string }[];
  monthLabel: string;
}) {
  const tipoInfo = TIPO_LABELS[sub.tipo] || TIPO_LABELS.otro;
  const totalPen = pagos.reduce((s, p) => s + p.monto_pen, 0);

  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-3">
        <span className="text-2xl shrink-0">{sub.icono}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[#C8C6BC] font-medium truncate">{sub.nombre}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#8A877D] mt-0.5">
            <span>{tipoInfo.emoji} {tipoInfo.label}</span>
            <span>·</span>
            <span>{pagos.length} pago{pagos.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[#C8C6BC] font-medium">
            S/{totalPen.toFixed(2)}
          </p>
          <p className="text-[10px] text-[#8A877D]">
            Pago en {monthLabel}
          </p>
        </div>
      </div>
      {pagos.length > 1 && (
        <div className="mt-2 pt-2 border-t border-[rgba(255,255,255,0.04)] space-y-1">
          {pagos.map((p, i) => (
            <div key={i} className="flex items-center justify-between text-xs px-2">
              <span className="text-[#8A877D]">{formatDate(p.fecha)}</span>
              <span className="text-[#C8C6BC]">
                {p.moneda === 'USD' ? `$${p.monto.toFixed(2)}` : `S/${p.monto.toFixed(2)}`}
                {p.moneda === 'USD' && (
                  <span className="text-[#8A877D] ml-1">(S/{p.monto_pen.toFixed(2)})</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SuscripcionesPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const { data: subsData, isLoading: subsLoading } = useSubscriptions(user?.id);

  const searchParams = useSearchParams();
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const selected = searchParams.get('mes') || defaultMonth;
  const [year, month] = selected.split('-').map(Number);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const monthLabel = `${MESES[month]} ${year}`;

  const [filterTipo, setFilterTipo] = useState<TipoSuscripcion | 'all'>('all');
  const [viewMode, setViewMode] = useState<'mensual' | 'anual'>('mensual');
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());

  const isLoading = userLoading || subsLoading;

  // Monthly filtered data
  const monthlyData = useMemo(() => {
    if (!subsData) return { subs: [], totalPEN: 0, count: 0 };
    const subs: { sub: SuscripcionDetectada; pagos: { monto: number; monto_pen: number; moneda: string; fecha: string }[] }[] = [];
    let totalPEN = 0;
    for (const sub of subsData.suscripciones) {
      const pagos = sub.pagos_detalle.filter(p => p.fecha.startsWith(monthKey));
      if (pagos.length > 0) {
        subs.push({ sub, pagos });
        totalPEN += pagos.reduce((s, p) => s + p.monto_pen, 0);
      }
    }
    return { subs, totalPEN: Math.round(totalPEN * 100) / 100, count: subs.length };
  }, [subsData, monthKey]);

  // Annual filtered data
  const yearKey = String(selectedYear);
  const annualData = useMemo(() => {
    if (!subsData) return { subs: [] as { sub: SuscripcionDetectada; pagos: { monto: number; monto_pen: number; moneda: string; fecha: string }[] }[], totalPEN: 0, count: 0 };
    const subs: { sub: SuscripcionDetectada; pagos: { monto: number; monto_pen: number; moneda: string; fecha: string }[] }[] = [];
    let totalPEN = 0;
    for (const sub of subsData.suscripciones) {
      const pagos = sub.pagos_detalle.filter(p => p.fecha.startsWith(yearKey));
      if (pagos.length > 0) {
        subs.push({ sub, pagos });
        totalPEN += pagos.reduce((s, p) => s + p.monto_pen, 0);
      }
    }
    return { subs, totalPEN: Math.round(totalPEN * 100) / 100, count: subs.length };
  }, [subsData, yearKey]);

  // Available years from data
  const availableYears = useMemo(() => {
    if (!subsData) return [now.getFullYear()];
    const years = new Set<number>();
    for (const sub of subsData.suscripciones) {
      for (const p of sub.pagos_detalle) {
        years.add(parseInt(p.fecha.substring(0, 4)));
      }
    }
    if (years.size === 0) years.add(now.getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [subsData, now]);

  const filteredAnnualSubs = useMemo(() => {
    if (filterTipo === 'all') return annualData.subs;
    return annualData.subs.filter((s) => s.sub.tipo === filterTipo);
  }, [annualData.subs, filterTipo]);

  const filteredMonthlySubs = useMemo(() => {
    if (filterTipo === 'all') return monthlyData.subs;
    return monthlyData.subs.filter((s) => s.sub.tipo === filterTipo);
  }, [monthlyData.subs, filterTipo]);

  const tiposPresentes = useMemo(() => {
    if (!subsData) return [];
    if (viewMode === 'mensual') {
      const tipos = new Set(monthlyData.subs.map(s => s.sub.tipo));
      return Array.from(tipos) as TipoSuscripcion[];
    }
    const tipos = new Set(annualData.subs.map(s => s.sub.tipo));
    return Array.from(tipos) as TipoSuscripcion[];
  }, [subsData, viewMode, monthlyData.subs, annualData.subs]);

  const currentViewData = viewMode === 'mensual' ? monthlyData : annualData;

  if (isLoading) {
    return (
      <SuscripcionesSkeleton />
    );
  }

  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#F0EFE8]">Suscripciones</h1>
          <p className="text-sm text-[#8A877D] mt-0.5">
            Detectadas automáticamente desde tus transacciones
          </p>
        </div>
        <HeaderActions />
      </div>

      {/* View mode toggle + Month selector */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex rounded-lg border border-[rgba(255,255,255,0.08)] overflow-hidden">
          <button
            onClick={() => setViewMode('mensual')}
            className={`text-xs px-4 py-2 transition-colors ${
              viewMode === 'mensual'
                ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75]'
                : 'bg-[rgba(255,255,255,0.02)] text-[#8A877D] hover:text-[#C8C6BC]'
            }`}
          >
            <Calendar className="h-3.5 w-3.5 inline-block mr-1.5 -mt-0.5" />
            Mensual
          </button>
          <button
            onClick={() => setViewMode('anual')}
            className={`text-xs px-4 py-2 transition-colors ${
              viewMode === 'anual'
                ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75]'
                : 'bg-[rgba(255,255,255,0.02)] text-[#8A877D] hover:text-[#C8C6BC]'
            }`}
          >
            Anual
          </button>
        </div>
        {viewMode === 'mensual' && <MonthSelector />}
        {viewMode === 'anual' && (
          <div className="flex items-center gap-1.5">
            {availableYears.map((y) => (
              <button
                key={y}
                onClick={() => setSelectedYear(y)}
                className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                  selectedYear === y
                    ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75] font-medium'
                    : 'bg-[rgba(255,255,255,0.03)] text-[#8A877D] hover:text-[#C8C6BC]'
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* KPIs */}
      {subsData && currentViewData.count > 0 && (
        <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StaggerItem>
          <KPICard
            icon={CreditCard}
            label="Suscripciones"
            value={String(currentViewData.count)}
            sub={viewMode === 'anual'
              ? `con pagos en ${selectedYear}`
              : `con pagos en ${MESES[month]}`
            }
          />
          </StaggerItem>
          <StaggerItem>
          <KPICard
            icon={TrendingDown}
            label={viewMode === 'anual' ? `Gasto ${selectedYear}` : `Gasto ${MESES[month]}`}
            value={`S/${currentViewData.totalPEN.toFixed(0)}`}
          />
          </StaggerItem>
          <StaggerItem>
          <KPICard
            icon={Eye}
            label={viewMode === 'anual' ? 'Promedio mensual' : 'Gasto anual proyectado'}
            value={viewMode === 'anual'
              ? `S/${annualData.count > 0 ? (annualData.totalPEN / 12).toFixed(0) : '0'}`
              : `S/${(currentViewData.totalPEN * 12).toFixed(0)}`
            }
            sub={viewMode === 'anual' ? `en ${selectedYear}` : 'proyectado'}
          />
          </StaggerItem>
          {viewMode === 'anual' && subsData.ahorroPotencialFamiliar > 0 && (
            <StaggerItem>
            <KPICard
              icon={Users}
              label="Ahorro posible"
              value={`S/${subsData.ahorroPotencialFamiliar.toFixed(0)}/mes`}
              sub="con planes familiares"
              accent
            />
            </StaggerItem>
          )}
        </StaggerContainer>
      )}

      {/* Empty state */}
      {subsData && currentViewData.count === 0 && (
        <EmptyState
          icon={CreditCard}
          title={viewMode === 'anual'
            ? `Sin pagos de suscripciones en ${selectedYear}`
            : `Sin pagos de suscripciones en ${monthLabel}`
          }
          description={viewMode === 'anual'
            ? `No se encontraron pagos de suscripciones en ${selectedYear}. Prueba seleccionando otro año.`
            : 'No se encontraron pagos de suscripciones en este mes. Prueba seleccionando otro mes o cambia a la vista anual.'
          }
          showWhatsApp={false}
        />
      )}

      {/* Filters */}
      {subsData && currentViewData.count > 0 && tiposPresentes.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilterTipo('all')}
            className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
              filterTipo === 'all'
                ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75]'
                : 'bg-[rgba(255,255,255,0.03)] text-[#8A877D] hover:text-[#C8C6BC]'
            }`}
          >
            Todas ({currentViewData.count})
          </button>
          {tiposPresentes.map((tipo) => {
            const info = TIPO_LABELS[tipo] || TIPO_LABELS.otro;
            const count = currentViewData.subs.filter(s => s.sub.tipo === tipo).length;
            return (
              <button
                key={tipo}
                onClick={() => setFilterTipo(tipo)}
                className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                  filterTipo === tipo
                    ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75]'
                    : 'bg-[rgba(255,255,255,0.03)] text-[#8A877D] hover:text-[#C8C6BC]'
                }`}
              >
                {info.emoji} {info.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Subscription cards — Anual mode */}
      {viewMode === 'anual' && filteredAnnualSubs.length > 0 && (
        <div className="space-y-2">
          {filteredAnnualSubs.map(({ sub, pagos }) => (
            <MonthlySubscriptionCard
              key={sub.id}
              sub={sub}
              pagos={pagos}
              monthLabel={String(selectedYear)}
            />
          ))}
        </div>
      )}

      {/* Subscription cards — Mensual mode */}
      {viewMode === 'mensual' && filteredMonthlySubs.length > 0 && (
        <div className="space-y-2">
          {filteredMonthlySubs.map(({ sub, pagos }) => (
            <MonthlySubscriptionCard
              key={sub.id}
              sub={sub}
              pagos={pagos}
              monthLabel={monthLabel}
            />
          ))}
        </div>
      )}

      {/* Summary by type — Anual */}
      {viewMode === 'anual' && annualData.count > 0 && (() => {
        const tipoTotals: Record<string, number> = {};
        for (const { sub, pagos } of annualData.subs) {
          const total = pagos.reduce((s, p) => s + p.monto_pen, 0);
          tipoTotals[sub.tipo] = (tipoTotals[sub.tipo] || 0) + total;
        }
        const entries = Object.entries(tipoTotals).sort(([, a], [, b]) => b - a);
        if (entries.length <= 1) return null;
        return (
          <div className="glass-card p-4">
            <h3 className="text-sm font-medium text-[#C8C6BC] mb-3">Desglose por tipo — {selectedYear}</h3>
            <div className="space-y-2">
              {entries.map(([tipo, total]) => {
                const info = TIPO_LABELS[tipo as TipoSuscripcion] || TIPO_LABELS.otro;
                const pct = annualData.totalPEN > 0 ? (total / annualData.totalPEN) * 100 : 0;
                return (
                  <div key={tipo} className="flex items-center gap-3">
                    <span className="text-sm shrink-0">{info.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-[#C8C6BC]">{info.label}</span>
                        <span className="text-[#8A877D]">
                          S/{total.toFixed(0)} ({pct.toFixed(0)}%)
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                        <motion.div
                          className="h-full rounded-full bg-[#1D9E75]"
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.min(pct, 100)}%` }}
                          transition={{ duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.2 }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Inactive subscriptions alert */}
      {viewMode === 'anual' && subsData && (() => {
        const inactive = subsData.suscripciones.filter((s) => {
          const daysSince = Math.floor((Date.now() - new Date(s.ultimo_pago + 'T12:00:00').getTime()) / (1000 * 60 * 60 * 24));
          return daysSince > 45;
        });
        if (inactive.length === 0) return null;
        const potentialSavings = inactive.reduce((s, sub) => s + sub.monto_pen, 0);
        return (
          <div className="glow-amber flex items-start gap-3 rounded-xl bg-[rgba(239,159,39,0.06)] border border-[rgba(239,159,39,0.15)] p-4">
            <AlertTriangle className="h-5 w-5 text-[#EF9F27] shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-[#F0EFE8]">
                {inactive.length} suscripci{inactive.length === 1 ? 'on' : 'ones'} sin cobro reciente
              </p>
              <p className="text-xs text-[#8A877D] mt-0.5">
                {inactive.map((s) => s.nombre).join(', ')} — si ya no las usas, podrias ahorrar ~S/{Math.round(potentialSavings)}/mes
              </p>
            </div>
          </div>
        );
      })()}

      {/* Optimization CTA */}
      {subsData && subsData.cantidad >= 3 && (
        <div className="glass-card glass-card-glow p-5 text-center">
          <p className="text-sm font-medium text-[#F0EFE8] mb-1">
            Gastas ~S/{(subsData.totalMensualPEN).toFixed(0)}/mes en {subsData.cantidad} suscripciones
          </p>
          <p className="text-xs text-[#8A877D] mb-3">
            Revisa si todas las sigues usando. Cancelar una suscripción de S/30 te ahorra S/360 al año.
          </p>
          <a
            href={SOCIAL_LINKS.whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1D9E75] hover:underline"
          >
            Pregúntale a NETO cuáles puedes optimizar
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {/* Info footer */}
      {subsData && subsData.cantidad > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.04)]">
          <Info className="h-4 w-4 text-[#8A877D] mt-0.5 shrink-0" />
          <p className="text-xs text-[#8A877D]">
            Las suscripciones se detectan automáticamente analizando tus transacciones de los últimos 3 meses.
            Los precios de referencia son aproximados y pueden variar según tu plan actual.
            Tipo de cambio referencial: 1 USD = S/{TC_APROXIMADO.toFixed(2)}
          </p>
        </div>
      )}
    </div>
    </FadeIn>
  );
}
