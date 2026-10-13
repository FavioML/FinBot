'use client';


import { useState, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import {
  CreditCard,
  TrendingDown,
  Users,
  Eye,
  AlertTriangle,
  ExternalLink,
  Info,
  Calendar,
  Pencil,
  Check,
  EyeOff,
  RotateCcw,
  Split,
} from 'lucide-react';
import { SuscripcionesSkeleton } from '@/components/dashboard/skeletons';
import { EmptyState } from '@/components/shared/empty-state';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { ErrorState } from '@/components/shared/error-state';
import { useUser } from '@/lib/hooks/use-user';
import { useSubscriptions } from '@/lib/hooks/use-subscriptions';
import { useRecurringOverrides } from '@/lib/hooks/use-recurring-overrides';
import {
  applySubscriptionOverrides,
  splitKey,
  splittableClusters,
} from '@/lib/subscription-overrides';
import { MonthSelector } from '@/components/dashboard/month-selector';
import { MESES, SOCIAL_LINKS } from '@/lib/constants';
import {
  TIPO_LABELS,
  formatPrecio,
  formatPrecioConversion,
  TC_APROXIMADO,
  CATALOGO_SUSCRIPCIONES,
} from '@/lib/subscriptions-catalog';
import type { SuscripcionDetectada, TipoSuscripcion } from '@/lib/subscriptions-catalog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
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
      <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <p className={`text-xl font-semibold ${accent ? 'text-primary' : 'text-foreground-soft'}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

type PagoDetalle = { monto: number; monto_pen: number; moneda: string; fecha: string; recurrente: boolean };

function MonthlySubscriptionCard({
  sub,
  pagos,
  monthLabel,
  onEdit,
}: {
  sub: SuscripcionDetectada;
  pagos: PagoDetalle[];
  monthLabel: string;
  onEdit: (sub: SuscripcionDetectada) => void;
}) {
  const tipoInfo = TIPO_LABELS[sub.tipo] || TIPO_LABELS.otro;
  const totalPen = pagos.reduce((s, p) => s + p.monto_pen, 0);
  const extrasPen = pagos.filter((p) => !p.recurrente).reduce((s, p) => s + p.monto_pen, 0);
  const hasExtras = extrasPen > 0;
  const detalle = hasExtras
    ? `cuota S/${(totalPen - extrasPen).toFixed(2)} + S/${extrasPen.toFixed(2)} extra`
    : `Pago en ${monthLabel}`;

  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-3">
        <span className="text-2xl shrink-0">{sub.icono}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-foreground-soft font-medium truncate">{sub.nombre}</span>
            {sub.plan_actual && (
              <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-xs text-primary-ink">
                {sub.plan_actual}
              </span>
            )}
            {sub.split_parent_id && (
              <span className="shrink-0 rounded-full bg-foreground/6 px-1.5 py-0.5 text-xs text-muted-foreground">
                dividido
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground mt-0.5">
            <span className="whitespace-nowrap">{tipoInfo.emoji} {tipoInfo.label}</span>
            <span className="whitespace-nowrap"><span className="mr-2">·</span>{pagos.length} pago{pagos.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="whitespace-nowrap text-foreground-soft font-medium">
            S/{totalPen.toFixed(2)}
          </p>
          <p className="hidden text-xs text-muted-foreground md:block">{detalle}</p>
        </div>
        <button
          onClick={() => onEdit(sub)}
          aria-label={`Editar ${sub.nombre}`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/15 hover:text-primary transition-colors"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* En celular el detalle va debajo, a todo el ancho: al lado del monto dejaba el nombre en
          dos letras y la fila de tipo montada sobre el monto. La copia invisible del ícono lo
          alinea con el nombre (un emoji no mide lo mismo en todos los sistemas). */}
      <div className="mt-1 flex gap-3 md:hidden">
        <span aria-hidden className="invisible block h-0 shrink-0 text-2xl">{sub.icono}</span>
        <p className="min-w-0 text-xs text-muted-foreground">{detalle}</p>
      </div>
      {pagos.length > 1 && (
        <div className="mt-2 pt-2 border-t border-border space-y-1">
          {pagos.map((p, i) => (
            <div key={i} className="flex items-center justify-between text-xs px-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                {formatDate(p.fecha)}
                {!p.recurrente && (
                  <span className="rounded bg-warning/12 px-1.5 py-0.5 text-xs text-warning-ink">
                    cargo adicional
                  </span>
                )}
              </span>
              <span className="text-foreground-soft">
                {p.moneda === 'USD' ? `$${p.monto.toFixed(2)}` : `S/${p.monto.toFixed(2)}`}
                {p.moneda === 'USD' && (
                  <span className="text-muted-foreground ml-1">(S/{p.monto_pen.toFixed(2)})</span>
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
  const { data: rawData, isLoading: subsLoading, isError: subsError, refetch: refetchSubs } = useSubscriptions(user?.id);
  const { overrides, isLoading: overridesLoading, upsert, remove } =
    useRecurringOverrides('suscripcion');

  // Detección raw (cacheada) + overrides del usuario aplicados reactivamente (sin
  // refetch de transacciones). Los agregados se recalculan dentro de applySubscriptionOverrides.
  const subsData = useMemo(
    () => applySubscriptionOverrides(rawData, overrides),
    [rawData, overrides]
  );

  // Estado del Sheet de edición (snapshot de la sub; las mutaciones re-derivan la lista)
  const [editSub, setEditSub] = useState<SuscripcionDetectada | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const openEdit = (sub: SuscripcionDetectada) => {
    setRenameValue(sub.nombre);
    setEditSub(sub);
  };

  const searchParams = useSearchParams();
  // Estable en el tiempo (una sola vez): evita llamada impura en render y el
  // consecuente mismatch de hidratación.
  const now = useMemo(() => new Date(), []);
  const defaultMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const selected = searchParams.get('mes') || defaultMonth;
  const [year, month] = selected.split('-').map(Number);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const monthLabel = `${MESES[month]} ${year}`;

  const [filterTipo, setFilterTipo] = useState<TipoSuscripcion | 'all'>('all');
  const [viewMode, setViewMode] = useState<'mensual' | 'anual'>('mensual');
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());

  const isLoading = userLoading || subsLoading || overridesLoading;

  // Monthly filtered data
  const monthlyData = useMemo(() => {
    if (!subsData) return { subs: [] as { sub: SuscripcionDetectada; pagos: PagoDetalle[] }[], totalPEN: 0, recurringPEN: 0, count: 0 };
    const subs: { sub: SuscripcionDetectada; pagos: PagoDetalle[] }[] = [];
    let totalPEN = 0;
    let recurringPEN = 0; // solo cuotas recurrentes (excluye cargos puntuales) — base de la proyección
    for (const sub of subsData.suscripciones) {
      const pagos = sub.pagos_detalle.filter(p => p.fecha.startsWith(monthKey));
      if (pagos.length > 0) {
        subs.push({ sub, pagos });
        totalPEN += pagos.reduce((s, p) => s + p.monto_pen, 0);
        recurringPEN += pagos.filter(p => p.recurrente).reduce((s, p) => s + p.monto_pen, 0);
      }
    }
    return {
      subs,
      totalPEN: Math.round(totalPEN * 100) / 100,
      recurringPEN: Math.round(recurringPEN * 100) / 100,
      count: subs.length,
    };
  }, [subsData, monthKey]);

  // Annual filtered data
  const yearKey = String(selectedYear);
  const annualData = useMemo(() => {
    if (!subsData) return { subs: [] as { sub: SuscripcionDetectada; pagos: PagoDetalle[] }[], totalPEN: 0, count: 0 };
    const subs: { sub: SuscripcionDetectada; pagos: PagoDetalle[] }[] = [];
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

  // ── Acciones del Sheet de edición ──
  const runToast = (p: Promise<unknown>, msg: string) =>
    p.then(() => toast.success(msg)).catch(() => toast.error('No se pudo guardar'));

  const editHasOverride = !!editSub && overrides.some(
    (o) => o.clave_variante === editSub.id || o.clave_variante.startsWith(`${editSub.id}::amt`)
  );
  // clusters divisibles del snapshot (≥2 cuotas recurrentes concurrentes bajo un nombre)
  const editClusters = editSub ? splittableClusters(editSub.pagos_detalle) : [];
  // id de la sub base para deshacer una división (hijo → su parent; base/residual → sí misma)
  const undoParentId =
    editSub?.split_parent_id ??
    (editSub && overrides.some((o) => o.clave_variante.startsWith(`${editSub.id}::amt`))
      ? editSub.id
      : null);

  const doRename = () => {
    if (!editSub) return;
    const label = renameValue.trim();
    if (!label || label === editSub.nombre) return;
    runToast(upsert.mutateAsync({ clave_variante: editSub.id, label_canonico: label }), 'Renombrado');
    setEditSub(null);
  };
  const doMarkPlan = (planNombre: string) => {
    if (!editSub) return;
    runToast(upsert.mutateAsync({ clave_variante: editSub.id, plan_nombre: planNombre }), `Plan: ${planNombre}`);
    setEditSub(null);
  };
  const doHide = () => {
    if (!editSub) return;
    runToast(upsert.mutateAsync({ clave_variante: editSub.id, oculto: true }), 'Suscripción oculta');
    setEditSub(null);
  };
  const doAssignSplit = (centroidPen: number, catalogId: string) => {
    if (!editSub) return;
    runToast(
      upsert.mutateAsync({
        clave_variante: splitKey(editSub.id, centroidPen),
        catalog_id: catalogId,
        id_canonico: editSub.id,
      }),
      'Servicio asignado'
    );
  };
  const doUndoSplit = () => {
    if (!undoParentId) return;
    const keys = overrides
      .filter((o) => o.clave_variante.startsWith(`${undoParentId}::amt`))
      .map((o) => o.clave_variante);
    runToast(Promise.all(keys.map((k) => remove.mutateAsync(k))), 'División deshecha');
    setEditSub(null);
  };
  const doReset = () => {
    if (!editSub) return;
    runToast(remove.mutateAsync(editSub.id), 'Restablecido');
    setEditSub(null);
  };

  if (isLoading) {
    return (
      <SuscripcionesSkeleton />
    );
  }

  // Error de carga distinto de "sin suscripciones": no mostrar el empty (parecería que
  // perdió su data). El `&& !rawData` es F15: sin él, un REFETCH fallido tapaba la lista
  // que el usuario estaba mirando y que react-query todavía tiene en cache — o sea que un
  // parpadeo de red borraba de pantalla datos válidos.
  if (subsError && !rawData) {
    return <ErrorState titulo="No pudimos cargar tus suscripciones" onReintentar={() => refetchSubs()} />;
  }

  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Suscripciones</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Detectadas automáticamente desde tus transacciones
          </p>
        </div>
        <HeaderActions />
      </div>

      {/* View mode toggle + Month selector */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setViewMode('mensual')}
            className={`text-xs px-4 py-2 transition-colors ${
              viewMode === 'mensual'
                ? 'bg-primary/12 text-primary-ink'
                : 'bg-foreground/2 text-muted-foreground hover:text-foreground-soft'
            }`}
          >
            <Calendar className="h-3.5 w-3.5 inline-block mr-1.5 -mt-0.5" />
            Mensual
          </button>
          <button
            onClick={() => setViewMode('anual')}
            className={`text-xs px-4 py-2 transition-colors ${
              viewMode === 'anual'
                ? 'bg-primary/12 text-primary-ink'
                : 'bg-foreground/2 text-muted-foreground hover:text-foreground-soft'
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
                    ? 'bg-primary/12 text-primary-ink font-medium'
                    : 'bg-foreground/3 text-muted-foreground hover:text-foreground-soft'
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
              : `S/${(monthlyData.recurringPEN * 12).toFixed(0)}`
            }
            sub={viewMode === 'anual' ? `en ${selectedYear}` : 'solo cuotas recurrentes'}
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
                ? 'bg-primary/12 text-primary-ink'
                : 'bg-foreground/3 text-muted-foreground hover:text-foreground-soft'
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
                    ? 'bg-primary/12 text-primary-ink'
                    : 'bg-foreground/3 text-muted-foreground hover:text-foreground-soft'
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
              onEdit={openEdit}
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
              onEdit={openEdit}
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
            <h3 className="text-sm font-medium text-foreground-soft mb-3">Desglose por tipo — {selectedYear}</h3>
            <div className="space-y-2">
              {entries.map(([tipo, total]) => {
                const info = TIPO_LABELS[tipo as TipoSuscripcion] || TIPO_LABELS.otro;
                const pct = annualData.totalPEN > 0 ? (total / annualData.totalPEN) * 100 : 0;
                return (
                  <div key={tipo} className="flex items-center gap-3">
                    <span className="text-sm shrink-0">{info.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-foreground-soft">{info.label}</span>
                        <span className="text-muted-foreground">
                          S/{total.toFixed(0)} ({pct.toFixed(0)}%)
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-foreground/6 overflow-hidden">
                        <motion.div
                          className="h-full rounded-full bg-primary"
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
          const daysSince = Math.floor((now.getTime() - new Date(s.ultimo_pago + 'T12:00:00').getTime()) / (1000 * 60 * 60 * 24));
          return daysSince > 45;
        });
        if (inactive.length === 0) return null;
        const potentialSavings = inactive.reduce((s, sub) => s + sub.monto_pen, 0);
        return (
          <div className="glow-amber flex items-start gap-3 rounded-xl bg-warning/6 border border-warning/15 p-4">
            <AlertTriangle className="h-5 w-5 text-warning-ink shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {inactive.length} suscripci{inactive.length === 1 ? 'on' : 'ones'} sin cobro reciente
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {inactive.map((s) => s.nombre).join(', ')} — si ya no las usas, podrias ahorrar ~S/{Math.round(potentialSavings)}/mes
              </p>
            </div>
          </div>
        );
      })()}

      {/* Optimization CTA */}
      {subsData && subsData.cantidad >= 3 && (
        <div className="glass-card glass-card-glow p-5 text-center">
          <p className="text-sm font-medium text-foreground mb-1">
            Gastas ~S/{(subsData.totalMensualPEN).toFixed(0)}/mes en {subsData.cantidad} suscripciones
          </p>
          <p className="text-xs text-muted-foreground mb-3">
            Revisa si todas las sigues usando. Cancelar una suscripción de S/30 te ahorra S/360 al año.
          </p>
          <a
            href={SOCIAL_LINKS.whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            Pregúntale a NETO cuáles puedes optimizar
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {/* Info footer */}
      {subsData && subsData.cantidad > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-foreground/2 border border-border">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Las suscripciones se detectan automáticamente analizando tus transacciones de los últimos 3 meses.
            Los precios de referencia son aproximados y pueden variar según tu plan actual.
            Tipo de cambio referencial: 1 USD = S/{TC_APROXIMADO.toFixed(2)}
          </p>
        </div>
      )}

      {/* Sheet de edición de suscripción */}
      <Sheet open={!!editSub} onOpenChange={(o) => !o && setEditSub(null)}>
        <SheetContent side="bottom" className="glass-card-elevated max-h-[85vh] overflow-y-auto">
          {editSub && (
            <>
              <SheetHeader>
                <SheetTitle>
                  <span className="mr-1.5">{editSub.icono}</span>
                  {editSub.nombre}
                </SheetTitle>
                <SheetDescription>
                  {formatPrecio(editSub.monto_detectado, editSub.moneda)}/mes · {editSub.meses_detectados}{' '}
                  mes{editSub.meses_detectados !== 1 ? 'es' : ''}
                  {editSub.split_parent_id ? ' · división manual' : ''}
                </SheetDescription>
              </SheetHeader>

              <div className="px-4 pb-4 space-y-4">
                {editSub.split_parent_id ? (
                  // ── Sub que salió de una división: solo deshacer ──
                  <p className="text-xs text-muted-foreground">
                    Este servicio salió de dividir un cargo agrupado. Puedes deshacer la división
                    para volver a verlo como un solo cargo.
                  </p>
                ) : (
                  <>
                    {/* Marcar plan */}
                    {editSub.planes_disponibles.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1.5">Tu plan</p>
                        <div className="space-y-1">
                          {editSub.planes_disponibles.map((plan) => {
                            const isCurrent = editSub.plan_actual
                              ? plan.nombre === editSub.plan_actual
                              : Math.abs(plan.precio - editSub.monto_detectado) < 1;
                            return (
                              <button
                                key={plan.nombre}
                                onClick={() => doMarkPlan(plan.nombre)}
                                className={`w-full flex items-center justify-between text-xs px-2.5 py-2 rounded-lg transition-colors ${
                                  isCurrent
                                    ? 'bg-primary/12 border border-primary/25'
                                    : 'bg-foreground/2 hover:bg-foreground/5'
                                }`}
                              >
                                <span className={`flex items-center gap-1.5 ${isCurrent ? 'text-primary-ink' : 'text-foreground-soft'}`}>
                                  {isCurrent && <Check className="h-3 w-3" />}
                                  {plan.nombre}
                                  {isCurrent && ' (actual)'}
                                </span>
                                <span className={isCurrent ? 'text-primary-ink' : 'text-muted-foreground'}>
                                  {formatPrecioConversion(plan.precio, editSub.moneda)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Renombrar */}
                    <div>
                      <label className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1.5">
                        <Pencil className="h-3 w-3" /> Nombre
                      </label>
                      <div className="flex gap-2">
                        <input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="form-input flex-1 text-sm"
                          placeholder="Nombre de la suscripción"
                        />
                        <button
                          onClick={doRename}
                          disabled={!renameValue.trim() || renameValue.trim() === editSub.nombre}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary/15 px-3 text-sm font-medium text-primary-ink disabled:opacity-40 hover:bg-primary/25 transition-colors"
                        >
                          <Check className="h-3.5 w-3.5" /> Guardar
                        </button>
                      </div>
                    </div>

                    {/* Dividir en varios servicios */}
                    {editClusters.length >= 2 && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1.5">
                          <Split className="h-3 w-3" /> Dividir en varios servicios
                        </p>
                        <p className="text-xs text-muted-foreground mb-2">
                          Este cargo agrupa montos distintos. Asigna cada uno a su servicio real.
                        </p>
                        <div className="space-y-2">
                          {editClusters.map((cl) => {
                            const current = overrides.find(
                              (o) => o.clave_variante === splitKey(editSub.id, cl.centroidPen)
                            )?.catalog_id;
                            return (
                              <div
                                key={cl.centroidPen}
                                className="flex items-center gap-2 rounded-lg bg-foreground/2 px-2.5 py-2"
                              >
                                <span className="text-xs text-foreground-soft shrink-0 tabular-nums w-24">
                                  ≈ S/{cl.centroidPen.toFixed(2)}
                                  <span className="text-xs text-muted-foreground ml-1">/mes</span>
                                </span>
                                <select
                                  value={current ?? ''}
                                  onChange={(e) => e.target.value && doAssignSplit(cl.centroidPen, e.target.value)}
                                  className="form-input flex-1 text-xs py-1.5"
                                >
                                  <option value="">Asignar a…</option>
                                  {CATALOGO_SUSCRIPCIONES.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.icono} {c.nombre}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Acciones */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {!editSub.split_parent_id && (
                    <button
                      onClick={doHide}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/4 px-3 py-2 text-xs text-foreground-soft hover:bg-foreground/7 transition-colors"
                    >
                      <EyeOff className="h-3.5 w-3.5" /> No es suscripción
                    </button>
                  )}
                  {undoParentId && (
                    <button
                      onClick={doUndoSplit}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/4 px-3 py-2 text-xs text-foreground-soft hover:bg-foreground/7 transition-colors"
                    >
                      <Split className="h-3.5 w-3.5" /> Deshacer división
                    </button>
                  )}
                  {editHasOverride && !editSub.split_parent_id && (
                    <button
                      onClick={doReset}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/4 px-3 py-2 text-xs text-muted-foreground hover:text-foreground-soft transition-colors"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Restablecer
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
    </FadeIn>
  );
}
