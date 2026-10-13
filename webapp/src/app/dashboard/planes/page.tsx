'use client';

import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Plus, Flag, Trash2, Edit2, Check, X, Trophy, TrendingUp, Flame, Award, ArrowDown, Users, Link2, Copy, UserX, ChevronDown, ChevronUp, Phone, Calendar, XCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { PlanesSkeleton } from '@/components/dashboard/skeletons';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { ProBadge } from '@/components/shared/upgrade-prompt';
import { ProGate } from '@/components/shared/pro-gate';
import { hasReachedLimit, canAccess } from '@/lib/plan';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useGoals, useGoalMutations, useGoalContributions, useGoalParticipants, useAchievements, useAbandonPlan, type MetaAhorro, type MetaAporte, type MetaParticipante } from '@/lib/hooks/use-goals';
import { formatCurrency } from '@/lib/utils';
import { montoPen } from '@/lib/tx-monto';
import { HeaderActions } from '@/components/dashboard/topbar';
import { ResumenMovil } from '@/components/dashboard/resumen-movil';


const ICONOS = ['🎯', '✈️', '🏠', '🚗', '💻', '📱', '🎓', '💍', '🏖️', '💰', '🛡️', '🎮'];

// Los tipos que existen son los que graba el backend (`registrarLogro`): milestone_25/50/75,
// meta_cumplida y racha_N, con N múltiplo de 3 (handlers/intents/metas.js). La racha se arma
// con su número en vez de listarse, y un tipo que no se conozca nunca muestra el id crudo.
const LOGRO_LABELS: Record<string, { emoji: string; label: string }> = {
  milestone_25: { emoji: '🥉', label: '25% alcanzado' },
  milestone_50: { emoji: '🥈', label: '50% alcanzado' },
  milestone_75: { emoji: '🥇', label: '75% alcanzado' },
  meta_cumplida: { emoji: '🏆', label: 'Meta cumplida' },
};

function logroInfo(tipo: string): { emoji: string; label: string } {
  if (LOGRO_LABELS[tipo]) return LOGRO_LABELS[tipo];
  const racha = /^racha_(\d+)$/.exec(tipo);
  if (racha) {
    const semanas = Number(racha[1]);
    return { emoji: semanas >= 12 ? '💎' : '🔥', label: `${semanas} semanas seguidas` };
  }
  return { emoji: '⭐', label: 'Logro' };
}

const QUICK_AMOUNTS = [50, 100, 200, 500];

function ParticipantsList({ metaId, isOwner, onDisable }: { metaId: string; isOwner: boolean; onDisable: () => void }) {
  const { data: participants = [], isLoading } = useGoalParticipants(metaId);
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return <div className="text-xs text-muted-foreground animate-pulse py-1">Cargando participantes...</div>;
  }

  if (participants.length === 0) {
    return <p className="text-xs text-muted-foreground">Aun no hay participantes</p>;
  }

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-warning hover:text-warning/80 transition-colors w-full"
      >
        <Users className="h-3 w-3" />
        <span>{participants.length} participante{participants.length > 1 ? 's' : ''}</span>
        {expanded ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pt-1 border-t border-border">
              {participants.map((p: MetaParticipante) => (
                <div key={p.id} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center text-xs text-primary-ink font-bold">
                      {p.nombre.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-foreground-soft font-medium">{p.nombre}</p>
                      {p.whatsapp && (
                        <p className="text-muted-foreground flex items-center gap-1">
                          <Phone className="h-2.5 w-2.5" />
                          {p.whatsapp}
                        </p>
                      )}
                    </div>
                  </div>
                  <span className="text-positive font-medium tabular-nums">
                    {formatCurrency(p.total_aportado)}
                  </span>
                </div>
              ))}
              {isOwner && (
                <button
                  onClick={onDisable}
                  className="flex items-center gap-1.5 text-xs text-negative hover:text-negative/80 transition-colors mt-2 pt-2 border-t border-border w-full"
                >
                  <UserX className="h-3 w-3" />
                  Desactivar modo colaborativo
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function calcularRitmo(goal: MetaAhorro) {
  const objetivo = Number(goal.monto_objetivo);
  const actual = Number(goal.monto_actual || 0);
  const faltante = Math.max(0, objetivo - actual);
  if (!goal.fecha_limite || faltante === 0) return null;

  const hoy = new Date();
  const limite = new Date(goal.fecha_limite + 'T23:59:59');
  const diasRestantes = Math.max(1, Math.ceil((limite.getTime() - hoy.getTime()) / 86400000));
  const mesesRestantes = Math.max(0.1, diasRestantes / 30);
  const montoMensual = Math.ceil(faltante / mesesRestantes);

  // Check if on track
  const created = goal.created_at ? new Date(goal.created_at) : hoy;
  const diasTotales = Math.max(1, Math.ceil((limite.getTime() - created.getTime()) / 86400000));
  const diasTranscurridos = Math.max(1, Math.ceil((hoy.getTime() - created.getTime()) / 86400000));
  const progresoEsperado = (diasTranscurridos / diasTotales) * objetivo;
  const enRitmo = actual >= progresoEsperado * 0.85;

  return { faltante, diasRestantes, montoMensual, enRitmo };
}

export default function MetasPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const { data: goals = [], isLoading: goalsLoading, isError: goalsError, refetch: refetchGoals } = useGoals(user?.id);
  const { data: allTransactions = [] } = useTransactions({ usuarioId: user?.id });
  const { data: achievements = [] } = useAchievements(user?.id);
  const { create, update, remove, contribute, generateInvite, disableCollab } = useGoalMutations();
  const abandonPlan = useAbandonPlan();

  const [showForm, setShowForm] = useState(false);
  const [showPlanProGate, setShowPlanProGate] = useState(false);
  const [editGoal, setEditGoal] = useState<MetaAhorro | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [contributeGoal, setContributeGoal] = useState<MetaAhorro | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);

  // Form state
  const [nombre, setNombre] = useState('');
  const [montoObjetivo, setMontoObjetivo] = useState('');
  const [montoActual, setMontoActual] = useState('');
  const [icono, setIcono] = useState('🎯');
  const [fechaLimite, setFechaLimite] = useState('');

  // Contribute form state
  const [contribMonto, setContribMonto] = useState('');
  const [contribTipo, setContribTipo] = useState<'aporte' | 'retiro'>('aporte');
  const [contribNota, setContribNota] = useState('');

  // Compute total savings from transactions
  const totalAhorro = useMemo(() => {
    const ingresos = allTransactions
      .filter((t) => t.tipo === 'ingreso')
      .reduce((s, t) => s + montoPen(t), 0);
    const gastos = allTransactions
      .filter((t) => t.tipo === 'gasto')
      .reduce((s, t) => s + montoPen(t), 0);
    return Math.max(0, ingresos - gastos);
  }, [allTransactions]);

  const isLoading = userLoading || goalsLoading;

  function openCreate() {
    setEditGoal(null);
    setNombre('');
    setMontoObjetivo('');
    setMontoActual('');
    setIcono('🎯');
    setFechaLimite('');
    setShowForm(true);
  }

  function openEdit(goal: MetaAhorro) {
    setEditGoal(goal);
    setNombre(goal.nombre);
    setMontoObjetivo(String(goal.monto_objetivo));
    setMontoActual(String(goal.monto_actual));
    setIcono(goal.icono || '');
    setFechaLimite(goal.fecha_limite || '');
    setShowForm(true);
  }

  function openContribute(goal: MetaAhorro) {
    setContributeGoal(goal);
    setContribMonto('');
    setContribTipo('aporte');
    setContribNota('');
  }

  async function handleSave() {
    if (!nombre.trim() || !montoObjetivo) {
      toast.error('Completa nombre y monto objetivo');
      return;
    }

    const payload = {
      nombre: nombre.trim(),
      monto_objetivo: montoObjetivo,
      monto_actual: montoActual || '0',
      icono,
      fecha_limite: fechaLimite || null,
    };

    try {
      if (editGoal) {
        await update.mutateAsync({ ...payload, id: editGoal.id });
        toast.success('Meta actualizada');
      } else {
        await create.mutateAsync(payload);
        toast.success('Meta creada');
      }
      setShowForm(false);
    } catch {
      toast.error('Error al guardar la meta');
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    try {
      await remove.mutateAsync(deleteId);
      toast.success('Meta eliminada');
      setDeleteId(null);
    } catch {
      toast.error('Error al eliminar');
    }
  }

  async function handleContribute() {
    if (!contributeGoal || !contribMonto) return;
    const monto = parseFloat(contribMonto);
    if (isNaN(monto) || monto <= 0) {
      toast.error('Ingresa un monto valido');
      return;
    }
    try {
      const result = await contribute.mutateAsync({
        meta_id: contributeGoal.id,
        monto,
        tipo: contribTipo,
        nota: contribNota || undefined,
      });
      const msg = contribTipo === 'retiro'
        ? 'Retiro registrado'
        : result.milestone
          ? result.milestone === 100
            ? 'Meta cumplida!'
            : `Aporte registrado - ${result.milestone}% alcanzado!`
          : 'Aporte registrado';
      toast.success(msg);
      setContributeGoal(null);
    } catch {
      toast.error('Error al registrar');
    }
  }

  async function toggleComplete(goal: MetaAhorro) {
    try {
      await update.mutateAsync({
        id: goal.id,
        nombre: goal.nombre,
        monto_objetivo: String(goal.monto_objetivo),
        monto_actual: String(goal.completada ? goal.monto_actual : goal.monto_objetivo),
        icono: goal.icono,
        fecha_limite: goal.fecha_limite,
        completada: !goal.completada,
      });
      toast.success(goal.completada ? 'Meta reabierta' : 'Meta completada!');
    } catch {
      toast.error('Error al actualizar');
    }
  }

  async function handleDisableCollab(goalId: string) {
    try {
      await disableCollab.mutateAsync(goalId);
      toast.success('Modo colaborativo desactivado');
    } catch {
      toast.error('Error al desactivar');
    }
  }

  async function handleInvite(goalId: string) {
    try {
      const result = await generateInvite.mutateAsync(goalId);
      await navigator.clipboard.writeText(result.link);
      toast.success('Link de invitacion copiado al portapapeles');
    } catch {
      toast.error('Error al generar invitacion');
    }
  }

  if (isLoading) {
    return (
      <PlanesSkeleton />
    );
  }

  if (!user) {
    return <EmptyState title="Inicia sesion" description="Conecta tu cuenta para ver tus metas de ahorro." />;
  }

  // --- Error de carga (F4) ---
  // El empty de esta pagina dice "aun no tienes planes de ahorro". A quien SI tiene tres
  // y no se pudieron leer, eso le dice que los perdio.
  if (goalsError && goals.length === 0) {
    return <ErrorState titulo="No pudimos cargar tus planes" onReintentar={() => refetchGoals()} />;
  }

  const isPremium = user?.plan === 'premium';
  const activeGoals = goals.filter((g) => (g.status === 'active' || (!g.status && !g.completada)));
  const completedGoals = goals.filter((g) => g.status === 'completed' || (!g.status && g.completada));
  const abandonedGoals = goals.filter((g) => g.status === 'abandoned');
  const goalsLimitReached = hasReachedLimit(user?.plan, 'goals', activeGoals.length);
  const canDynamicAdjust = canAccess(user?.plan, 'metas_dynamic_adjust');
  const canCheckins = canAccess(user?.plan, 'metas_checkins');
  const totalTarget = activeGoals.reduce((s, g) => s + Number(g.monto_objetivo), 0);
  const totalSaved = activeGoals.reduce((s, g) => s + Number(g.monto_actual), 0);

  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Planes de ahorro</h1>
          <p className="text-sm text-muted-foreground mt-1">Planifica tu ahorro y Neto te guía para lograrlo</p>
        </div>
        <HeaderActions>
          {goalsLimitReached && !isPremium && (
            <span className="hidden md:inline-flex"><ProBadge text="Con Neto Pro" /></span>
          )}
          <Button
            onClick={goalsLimitReached && !isPremium ? () => setShowPlanProGate(true) : openCreate}
            size="sm"
            className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Nuevo plan</span>
            <span className="sm:hidden">Nuevo</span>
          </Button>
        </HeaderActions>
      </div>

      {/* ProGate: planes limit reached */}
      {showPlanProGate && (
        <div>
          <ProGate
            featureName="Planes ilimitados"
            description="Con Pro creas todos los planes de ahorro que necesites — viaje, casa, fondo de emergencia y más"
          />
          <button
            onClick={() => setShowPlanProGate(false)}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground-soft transition-colors w-full text-center"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Pro feature hints */}
      {!isPremium && activeGoals.length > 0 && (
        <div className="glass-card p-4 flex flex-wrap gap-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Ajuste dinámico</span>
            <ProBadge text="Pro" />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Check-ins por WhatsApp</span>
            <ProBadge text="Pro" />
          </div>
        </div>
      )}

      {/* Summary cards: en celular, una sola tarjeta (ver `ResumenMovil`) */}
      {activeGoals.length > 0 && (
        <ResumenMovil
          cifras={[
            { etiqueta: 'Planes activos', valor: activeGoals.length },
            { etiqueta: 'Ahorrado', valor: formatCurrency(totalSaved), colorValor: 'text-positive' },
            { etiqueta: 'Objetivo total', valor: formatCurrency(totalTarget) },
          ]}
        />
      )}
      {activeGoals.length > 0 && (
        <div className="hidden sm:grid sm:grid-cols-3 gap-4">
          <div className="glass-card glass-card-glow p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Planes activos</p>
            <p className="text-2xl font-bold text-foreground">{activeGoals.length}</p>
          </div>
          <div className="glass-card glass-card-glow p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Ahorrado</p>
            <p className="text-2xl font-bold text-positive">{formatCurrency(totalSaved)}</p>
          </div>
          <div className="glass-card glass-card-glow p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Objetivo total</p>
            <p className="text-2xl font-bold text-foreground">{formatCurrency(totalTarget)}</p>
          </div>
        </div>
      )}

      {/* Goals grid */}
      {goals.length === 0 ? (
        <EmptyState
          title="Aún no tienes planes de ahorro"
          description="Créalo aquí en la app o por WhatsApp: 'quiero ahorrar S/5000 para julio'"
          showWhatsApp={false}
          actions={[{ label: 'Nuevo plan', onClick: openCreate }]}
        />
      ) : (
        <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {activeGoals.map((goal) => {
            const pct = Number(goal.monto_objetivo) > 0
              ? Math.min(100, (Number(goal.monto_actual) / Number(goal.monto_objetivo)) * 100)
              : 0;
            const remaining = Math.max(0, Number(goal.monto_objetivo) - Number(goal.monto_actual));
            const ritmo = calcularRitmo(goal);

            return (
              <StaggerItem key={goal.id}>
                <div className="glass-card glass-card-glow p-5 space-y-3 group">
                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{goal.icono}</span>
                      <h3 className="text-sm font-semibold text-foreground">{goal.nombre}</h3>
                      {pct >= 90 && pct < 100 && (
                        <Trophy className="h-3.5 w-3.5 text-warning animate-pulse" />
                      )}
                      {goal.status === 'completed' && (
                        <span className="px-1.5 py-0.5 rounded-full bg-primary/15 text-xs text-primary-ink font-medium">Completado</span>
                      )}
                      {goal.status === 'abandoned' && (
                        <span className="px-1.5 py-0.5 rounded-full bg-foreground/6 text-xs text-muted-foreground font-medium">Abandonado</span>
                      )}
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
                      <button onClick={() => openContribute(goal)} className="p-1 rounded text-primary hover:text-primary/80" title="Aportar">
                        <TrendingUp className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => openEdit(goal)} className="p-1 rounded text-muted-foreground hover:text-foreground">
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => toggleComplete(goal)} className="p-1 rounded text-muted-foreground hover:text-primary">
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setDeleteId(goal.id)} className="p-1 rounded text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      {goal.status === 'active' && !goal.completada && (
                        <button
                          onClick={() => abandonPlan.mutate(goal.id)}
                          className="p-1 rounded text-muted-foreground hover:text-negative"
                          title="Abandonar plan"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Monthly quota */}
                  {goal.monthly_quota && goal.status === 'active' && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Calendar className="h-3.5 w-3.5" />
                      <span>Cuota: S/ {Number(goal.monthly_quota).toFixed(0)}/mes</span>
                    </div>
                  )}

                  {/* Collaborative badge + participants */}
                  {goal.colaborativa && (
                    <div className="space-y-2">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warning/10 text-xs text-warning-ink font-medium">
                        <Users className="h-3 w-3" /> Colaborativa
                      </span>
                      <ParticipantsList
                        metaId={goal.id}
                        isOwner={goal.usuario_id === user?.id}
                        onDisable={() => handleDisableCollab(goal.id)}
                      />
                    </div>
                  )}

                  {/* Action buttons row */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => openContribute(goal)}
                      className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary-ink hover:bg-primary/20 transition-colors flex items-center justify-center gap-1.5"
                    >
                      <TrendingUp className="h-3 w-3" />
                      Aportar
                    </button>
                    <button
                      onClick={() => handleInvite(goal.id)}
                      className="py-1.5 px-3 rounded-lg text-xs font-medium bg-warning/10 text-warning-ink hover:bg-warning/20 transition-colors flex items-center justify-center gap-1.5"
                      title="Invitar participantes — convierte en meta colaborativa"
                    >
                      <Link2 className="h-3 w-3" />
                      Invitar
                    </button>
                  </div>

                  {/* Progress bar */}
                  <div className="space-y-1.5">
                    <div className="h-2.5 rounded-full bg-foreground/6 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: pct >= 100 ? 'var(--positive)' : pct >= 60 ? 'var(--warning)' : 'var(--positive)' }}
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{pct.toFixed(0)}%</span>
                      <span className="text-foreground-soft font-medium tabular-nums">
                        {formatCurrency(Number(goal.monto_actual))} / {formatCurrency(Number(goal.monto_objetivo))}
                      </span>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Faltan {formatCurrency(remaining)}</span>
                    {goal.fecha_limite && (
                      <span>Meta: {new Date(goal.fecha_limite + 'T12:00:00').toLocaleDateString('es-PE', { month: 'short', year: 'numeric' })}</span>
                    )}
                  </div>

                  {/* Pace indicator */}
                  {ritmo && (
                    <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg ${ritmo.enRitmo ? 'bg-primary/8 text-primary-ink' : 'bg-warning/8 text-warning-ink'}`}>
                      <TrendingUp className="h-3 w-3" />
                      <span>S/ {ritmo.montoMensual.toFixed(0)}/mes necesarios</span>
                      <span className="ml-auto">{ritmo.enRitmo ? '✅ En ritmo' : '⚠️ Acelerar'}</span>
                    </div>
                  )}

                  {/* Contribution history toggle */}
                  {goal.meta_aportes && goal.meta_aportes.length > 0 && (
                    <button
                      onClick={() => setExpandedHistory(expandedHistory === goal.id ? null : goal.id)}
                      className="text-xs text-muted-foreground hover:text-foreground-soft transition-colors"
                    >
                      {expandedHistory === goal.id ? 'Ocultar' : 'Ver'} historial ({goal.meta_aportes.length} aportes)
                    </button>
                  )}
                  <AnimatePresence>
                    {expandedHistory === goal.id && goal.meta_aportes && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-1 pt-1 border-t border-border">
                          {goal.meta_aportes.slice(0, 5).map((a: MetaAporte) => (
                            <div key={a.id} className="flex justify-between text-xs">
                              <span className={a.tipo === 'retiro' ? 'text-negative' : 'text-positive'}>
                                {a.tipo === 'retiro' ? '−' : '+'} {formatCurrency(Number(a.monto))}
                              </span>
                              <span className="text-muted-foreground">{new Date(a.fecha + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}</span>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </StaggerItem>
            );
          })}
        </StaggerContainer>
      )}

      {/* Completed goals */}
      {completedGoals.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Trophy className="h-4 w-4 text-warning" />
            Planes completados ({completedGoals.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {completedGoals.map((goal) => (
              <div key={goal.id} className="glass-card p-4 opacity-60 group">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span>{goal.icono}</span>
                    <span className="text-sm text-foreground-soft line-through">{goal.nombre}</span>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
                    <button onClick={() => toggleComplete(goal)} className="p-1 rounded text-muted-foreground hover:text-warning" title="Reabrir">
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => setDeleteId(goal.id)} className="p-1 rounded text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-positive mt-1">{formatCurrency(Number(goal.monto_objetivo))} logrados</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Abandoned plans */}
      {abandonedGoals.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <XCircle className="h-4 w-4 text-muted-foreground" />
            Planes abandonados ({abandonedGoals.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {abandonedGoals.map((goal) => (
              <div key={goal.id} className="glass-card p-4 opacity-50 group">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span>{goal.icono}</span>
                    <span className="text-sm text-muted-foreground line-through">{goal.nombre}</span>
                  </div>
                  <button onClick={() => setDeleteId(goal.id)} className="p-1 rounded text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{formatCurrency(Number(goal.monto_actual))} ahorrados</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Achievements section */}
      {achievements.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Award className="h-4 w-4 text-warning" />
            Logros ({achievements.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {achievements.map((logro) => {
              const info = logroInfo(logro.tipo);
              return (
                <div key={logro.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-warning/8 text-xs">
                  <span>{info.emoji}</span>
                  <span className="text-warning-ink">{info.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="glass-card-elevated text-foreground max-w-md">
          <DialogHeader>
            <DialogTitle>{editGoal ? 'Editar plan' : 'Nuevo plan de ahorro'}</DialogTitle>
          </DialogHeader>
          <div className="glass-card-depth space-y-4">
            {/* Icon picker */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Icono</label>
              <div className="flex flex-wrap gap-2">
                {ICONOS.map((ic) => (
                  <button
                    key={ic}
                    onClick={() => setIcono(ic)}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg transition-all ${
                      icono === ic ? 'bg-primary/20 ring-1 ring-primary scale-110' : 'bg-foreground/4 hover:bg-foreground/8'
                    }`}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            </div>

            {/* Name */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Nombre de la meta</label>
              <input
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Ej: Viaje a Cusco"
                className="w-full rounded-lg bg-foreground/4 border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
              />
            </div>

            {/* Amounts */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">Monto objetivo (S/)</label>
                <input
                  type="number"
                  value={montoObjetivo}
                  onChange={(e) => setMontoObjetivo(e.target.value)}
                  placeholder="3000"
                  className="w-full rounded-lg bg-foreground/4 border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">Ahorrado hasta hoy (S/)</label>
                <input
                  type="number"
                  value={montoActual}
                  onChange={(e) => setMontoActual(e.target.value)}
                  placeholder="0"
                  className="w-full rounded-lg bg-foreground/4 border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
                />
              </div>
            </div>

            {/* Deadline */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Fecha limite (opcional)</label>
              <input
                type="date"
                value={fechaLimite}
                onChange={(e) => setFechaLimite(e.target.value)}
                className="w-full rounded-lg bg-foreground/4 border border-border px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
            </div>

            {/* Savings hint */}
            {totalAhorro > 0 && !editGoal && (
              <p className="text-xs text-muted-foreground bg-primary/6 rounded-lg px-3 py-2">
                Tu ahorro historico total es <span className="text-positive-ink font-medium">{formatCurrency(totalAhorro)}</span>
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <Button
                onClick={handleSave}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={create.isPending || update.isPending}
              >
                {create.isPending || update.isPending ? 'Guardando...' : editGoal ? 'Actualizar' : 'Crear meta'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowForm(false)}
                className="border-border bg-transparent text-foreground-soft"
              >
                Cancelar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Contribute dialog */}
      <Dialog open={!!contributeGoal} onOpenChange={(open) => { if (!open) setContributeGoal(null); }}>
        <DialogContent className="glass-card-elevated text-foreground max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {contribTipo === 'retiro' ? <ArrowDown className="h-5 w-5 text-negative-ink" /> : <TrendingUp className="h-5 w-5 text-primary-ink" />}
              {contribTipo === 'retiro' ? 'Retirar de' : 'Aportar a'} {contributeGoal?.nombre}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Type toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => setContribTipo('aporte')}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${contribTipo === 'aporte' ? 'bg-primary/15 text-primary-ink ring-1 ring-primary/30' : 'bg-foreground/4 text-muted-foreground'}`}
              >
                Aportar
              </button>
              <button
                onClick={() => setContribTipo('retiro')}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${contribTipo === 'retiro' ? 'bg-negative/15 text-negative-ink ring-1 ring-negative/30' : 'bg-foreground/4 text-muted-foreground'}`}
              >
                Retirar
              </button>
            </div>

            {/* Quick amounts */}
            <div className="flex gap-2">
              {QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => setContribMonto(String(amt))}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${contribMonto === String(amt) ? 'bg-primary/15 text-primary-ink ring-1 ring-primary/30' : 'bg-foreground/4 text-foreground-soft hover:bg-foreground/8'}`}
                >
                  S/ {amt}
                </button>
              ))}
            </div>

            {/* Custom amount */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Monto (S/)</label>
              <input
                type="number"
                value={contribMonto}
                onChange={(e) => setContribMonto(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg bg-foreground/4 border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
              />
            </div>

            {/* Nota */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Nota (opcional)</label>
              <input
                type="text"
                value={contribNota}
                onChange={(e) => setContribNota(e.target.value)}
                placeholder="Ej: Ahorro del mes"
                className="w-full rounded-lg bg-foreground/4 border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
              />
            </div>

            {/* Progress preview */}
            {contributeGoal && contribMonto && (
              <div className="text-xs text-muted-foreground bg-foreground/3 rounded-lg px-3 py-2">
                {(() => {
                  const actual = Number(contributeGoal.monto_actual);
                  const delta = contribTipo === 'retiro' ? -parseFloat(contribMonto || '0') : parseFloat(contribMonto || '0');
                  const nuevo = Math.max(0, actual + delta);
                  const pctNuevo = Math.min(100, (nuevo / Number(contributeGoal.monto_objetivo)) * 100);
                  return `Despues del ${contribTipo}: ${formatCurrency(nuevo)} / ${formatCurrency(Number(contributeGoal.monto_objetivo))} (${pctNuevo.toFixed(0)}%)`;
                })()}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                onClick={handleContribute}
                className={`flex-1 ${contribTipo === 'retiro' ? 'bg-negative text-negative-foreground hover:bg-negative/90' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}
                disabled={contribute.isPending}
              >
                {contribute.isPending ? 'Registrando...' : contribTipo === 'retiro' ? 'Retirar' : 'Aportar'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setContributeGoal(null)}
                className="border-border bg-transparent text-foreground-soft"
              >
                Cancelar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <DialogContent className="glass-card-elevated text-foreground max-w-sm">
          <DialogHeader>
            <DialogTitle>Eliminar meta</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Esta accion no se puede deshacer.</p>
          <div className="flex gap-2 pt-2">
            <Button
              onClick={handleDelete}
              className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
            >
              {remove.isPending ? 'Eliminando...' : 'Eliminar'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setDeleteId(null)}
              className="border-border bg-transparent text-foreground-soft"
            >
              Cancelar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </FadeIn>
  );
}
