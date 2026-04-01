'use client';

import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Plus, Flag, Trash2, Edit2, Check, X, Trophy, TrendingUp, Flame, Award, ArrowDown, Users, Link2, Copy } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { ProBadge } from '@/components/shared/upgrade-prompt';
import { FREE_LIMITS, hasReachedLimit } from '@/lib/plan';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { UserMenu } from '@/components/dashboard/user-menu';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { useGoals, useGoalMutations, useGoalContributions, useAchievements, type MetaAhorro, type MetaAporte } from '@/lib/hooks/use-goals';
import { formatCurrency } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const ICONOS = ['🎯', '✈️', '🏠', '🚗', '💻', '📱', '🎓', '💍', '🏖️', '💰', '🛡️', '🎮'];

const LOGRO_LABELS: Record<string, { emoji: string; label: string }> = {
  milestone_25: { emoji: '🥉', label: '25% alcanzado' },
  milestone_50: { emoji: '🥈', label: '50% alcanzado' },
  milestone_75: { emoji: '🥇', label: '75% alcanzado' },
  meta_cumplida: { emoji: '🏆', label: 'Meta cumplida' },
  primera_meta: { emoji: '🌟', label: 'Primera meta' },
  primer_abono: { emoji: '💫', label: 'Primer aporte' },
  racha_3: { emoji: '🔥', label: '3 semanas seguidas' },
  racha_5: { emoji: '🔥', label: '5 semanas seguidas' },
  racha_10: { emoji: '💎', label: '10 semanas seguidas' },
};

const QUICK_AMOUNTS = [50, 100, 200, 500];

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
  const { data: goals = [], isLoading: goalsLoading } = useGoals(user?.id);
  const { data: allTransactions = [] } = useTransactions({ usuarioId: user?.id });
  const { data: achievements = [] } = useAchievements(user?.id);
  const { create, update, remove, contribute, generateInvite } = useGoalMutations();

  const [showForm, setShowForm] = useState(false);
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
      .reduce((s, t) => s + t.monto_pen, 0);
    const gastos = allTransactions
      .filter((t) => t.tipo === 'gasto')
      .reduce((s, t) => s + t.monto_pen, 0);
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
    setIcono(goal.icono);
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
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-[200px] rounded-2xl" />)}
        </div>
      </div>
    );
  }

  if (!user) {
    return <EmptyState title="Inicia sesion" description="Conecta tu cuenta para ver tus metas de ahorro." />;
  }

  const isPremium = user?.plan === 'premium';
  const activeGoals = goals.filter((g) => !g.completada);
  const completedGoals = goals.filter((g) => g.completada);
  const goalsLimitReached = hasReachedLimit(user?.plan, 'goals', activeGoals.length);
  const totalTarget = activeGoals.reduce((s, g) => s + Number(g.monto_objetivo), 0);
  const totalSaved = activeGoals.reduce((s, g) => s + Number(g.monto_actual), 0);

  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#F0EFE8]">Metas de ahorro</h1>
          <p className="text-sm text-[#8A877D] mt-1">Define objetivos y mide tu progreso</p>
        </div>
        <div className="flex items-center gap-3">
          {goalsLimitReached && !isPremium && (
            <ProBadge text={`Limite: ${FREE_LIMITS.goals} meta`} />
          )}
          <Button
            onClick={openCreate}
            className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-2"
            disabled={goalsLimitReached && !isPremium}
          >
            <Plus className="h-4 w-4" />
            Nueva meta
          </Button>
          <UserMenu />
        </div>
      </div>

      {/* Summary cards */}
      {activeGoals.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="glass-card glass-card-glow p-4 text-center">
            <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-1">Metas activas</p>
            <p className="text-2xl font-bold text-[#F0EFE8]">{activeGoals.length}</p>
          </div>
          <div className="glass-card glass-card-glow p-4 text-center">
            <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-1">Ahorrado</p>
            <p className="text-2xl font-bold text-[#1D9E75]">{formatCurrency(totalSaved)}</p>
          </div>
          <div className="glass-card glass-card-glow p-4 text-center">
            <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-1">Objetivo total</p>
            <p className="text-2xl font-bold text-[#F0EFE8]">{formatCurrency(totalTarget)}</p>
          </div>
        </div>
      )}

      {/* Goals grid */}
      {goals.length === 0 ? (
        <EmptyState
          title="Sin metas de ahorro"
          description="Crea tu primera meta para empezar a ahorrar con proposito. Por ejemplo: viaje, fondo de emergencia, o una compra especial."
          showWhatsApp={false}
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
                      <h3 className="text-sm font-semibold text-[#F0EFE8]">{goal.nombre}</h3>
                      {pct >= 90 && pct < 100 && (
                        <Trophy className="h-3.5 w-3.5 text-[#EF9F27] animate-pulse" />
                      )}
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => openContribute(goal)} className="p-1 rounded text-[#1D9E75] hover:text-[#1D9E75]/80" title="Aportar">
                        <TrendingUp className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => openEdit(goal)} className="p-1 rounded text-[#8A877D] hover:text-[#F0EFE8]">
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => toggleComplete(goal)} className="p-1 rounded text-[#8A877D] hover:text-[#1D9E75]">
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setDeleteId(goal.id)} className="p-1 rounded text-[#8A877D] hover:text-[#D85A30]">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Collaborative badge + invite */}
                  {(goal as MetaAhorro & { colaborativa?: boolean }).colaborativa && (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[rgba(239,159,39,0.1)] text-[10px] text-[#EF9F27] font-medium">
                        <Users className="h-3 w-3" /> Colaborativa
                      </span>
                    </div>
                  )}

                  {/* Action buttons row */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => openContribute(goal)}
                      className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-[rgba(29,158,117,0.1)] text-[#1D9E75] hover:bg-[rgba(29,158,117,0.2)] transition-colors flex items-center justify-center gap-1.5"
                    >
                      <TrendingUp className="h-3 w-3" />
                      Aportar
                    </button>
                    {goal.usuario_id === user?.id && (
                      <button
                        onClick={() => handleInvite(goal.id)}
                        className="py-1.5 px-3 rounded-lg text-xs font-medium bg-[rgba(239,159,39,0.1)] text-[#EF9F27] hover:bg-[rgba(239,159,39,0.2)] transition-colors flex items-center justify-center gap-1.5"
                        title="Invitar participantes"
                      >
                        <Link2 className="h-3 w-3" />
                        Invitar
                      </button>
                    )}
                  </div>

                  {/* Progress bar */}
                  <div className="space-y-1.5">
                    <div className="h-2.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: pct >= 100 ? '#1D9E75' : pct >= 60 ? '#EF9F27' : '#1D9E75' }}
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-[#8A877D]">{pct.toFixed(0)}%</span>
                      <span className="text-[#C8C6BC] font-medium tabular-nums">
                        {formatCurrency(Number(goal.monto_actual))} / {formatCurrency(Number(goal.monto_objetivo))}
                      </span>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-between text-xs text-[#8A877D]">
                    <span>Faltan {formatCurrency(remaining)}</span>
                    {goal.fecha_limite && (
                      <span>Meta: {new Date(goal.fecha_limite + 'T12:00:00').toLocaleDateString('es-PE', { month: 'short', year: 'numeric' })}</span>
                    )}
                  </div>

                  {/* Pace indicator */}
                  {ritmo && (
                    <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg ${ritmo.enRitmo ? 'bg-[rgba(29,158,117,0.08)] text-[#1D9E75]' : 'bg-[rgba(239,159,39,0.08)] text-[#EF9F27]'}`}>
                      <TrendingUp className="h-3 w-3" />
                      <span>S/ {ritmo.montoMensual.toFixed(0)}/mes necesarios</span>
                      <span className="ml-auto">{ritmo.enRitmo ? '✅ En ritmo' : '⚠️ Acelerar'}</span>
                    </div>
                  )}

                  {/* Contribution history toggle */}
                  {goal.meta_aportes && goal.meta_aportes.length > 0 && (
                    <button
                      onClick={() => setExpandedHistory(expandedHistory === goal.id ? null : goal.id)}
                      className="text-xs text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
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
                        <div className="space-y-1 pt-1 border-t border-[rgba(255,255,255,0.06)]">
                          {goal.meta_aportes.slice(0, 5).map((a: MetaAporte) => (
                            <div key={a.id} className="flex justify-between text-xs">
                              <span className={a.tipo === 'retiro' ? 'text-[#D85A30]' : 'text-[#1D9E75]'}>
                                {a.tipo === 'retiro' ? '−' : '+'} {formatCurrency(Number(a.monto))}
                              </span>
                              <span className="text-[#8A877D]">{new Date(a.fecha + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}</span>
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
          <h2 className="text-sm font-medium text-[#8A877D] flex items-center gap-2">
            <Trophy className="h-4 w-4 text-[#EF9F27]" />
            Metas completadas ({completedGoals.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {completedGoals.map((goal) => (
              <div key={goal.id} className="glass-card p-4 opacity-60 group">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span>{goal.icono}</span>
                    <span className="text-sm text-[#C8C6BC] line-through">{goal.nombre}</span>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => toggleComplete(goal)} className="p-1 rounded text-[#8A877D] hover:text-[#EF9F27]" title="Reabrir">
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => setDeleteId(goal.id)} className="p-1 rounded text-[#8A877D] hover:text-[#D85A30]">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-[#1D9E75] mt-1">{formatCurrency(Number(goal.monto_objetivo))} logrados</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Achievements section */}
      {achievements.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-[#8A877D] flex items-center gap-2">
            <Award className="h-4 w-4 text-[#EF9F27]" />
            Logros ({achievements.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {achievements.map((logro) => {
              const info = LOGRO_LABELS[logro.tipo] || { emoji: '⭐', label: logro.tipo };
              return (
                <div key={logro.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[rgba(239,159,39,0.08)] text-xs">
                  <span>{info.emoji}</span>
                  <span className="text-[#EF9F27]">{info.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
          <DialogHeader>
            <DialogTitle>{editGoal ? 'Editar meta' : 'Nueva meta de ahorro'}</DialogTitle>
          </DialogHeader>
          <div className="glass-card-depth space-y-4">
            {/* Icon picker */}
            <div>
              <label className="text-xs text-[#8A877D] mb-1.5 block">Icono</label>
              <div className="flex flex-wrap gap-2">
                {ICONOS.map((ic) => (
                  <button
                    key={ic}
                    onClick={() => setIcono(ic)}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg transition-all ${
                      icono === ic ? 'bg-[#1D9E75]/20 ring-1 ring-[#1D9E75] scale-110' : 'bg-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.08)]'
                    }`}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            </div>

            {/* Name */}
            <div>
              <label className="text-xs text-[#8A877D] mb-1.5 block">Nombre de la meta</label>
              <input
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Ej: Viaje a Cusco"
                className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
              />
            </div>

            {/* Amounts */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-[#8A877D] mb-1.5 block">Monto objetivo (S/)</label>
                <input
                  type="number"
                  value={montoObjetivo}
                  onChange={(e) => setMontoObjetivo(e.target.value)}
                  placeholder="3000"
                  className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                />
              </div>
              <div>
                <label className="text-xs text-[#8A877D] mb-1.5 block">Ahorrado hasta hoy (S/)</label>
                <input
                  type="number"
                  value={montoActual}
                  onChange={(e) => setMontoActual(e.target.value)}
                  placeholder="0"
                  className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                />
              </div>
            </div>

            {/* Deadline */}
            <div>
              <label className="text-xs text-[#8A877D] mb-1.5 block">Fecha limite (opcional)</label>
              <input
                type="date"
                value={fechaLimite}
                onChange={(e) => setFechaLimite(e.target.value)}
                className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]"
              />
            </div>

            {/* Savings hint */}
            {totalAhorro > 0 && !editGoal && (
              <p className="text-xs text-[#8A877D] bg-[rgba(29,158,117,0.06)] rounded-lg px-3 py-2">
                Tu ahorro historico total es <span className="text-[#1D9E75] font-medium">{formatCurrency(totalAhorro)}</span>
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <Button
                onClick={handleSave}
                className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
                disabled={create.isPending || update.isPending}
              >
                {create.isPending || update.isPending ? 'Guardando...' : editGoal ? 'Actualizar' : 'Crear meta'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowForm(false)}
                className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
              >
                Cancelar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Contribute dialog */}
      <Dialog open={!!contributeGoal} onOpenChange={(open) => { if (!open) setContributeGoal(null); }}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {contribTipo === 'retiro' ? <ArrowDown className="h-5 w-5 text-[#D85A30]" /> : <TrendingUp className="h-5 w-5 text-[#1D9E75]" />}
              {contribTipo === 'retiro' ? 'Retirar de' : 'Aportar a'} {contributeGoal?.nombre}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Type toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => setContribTipo('aporte')}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${contribTipo === 'aporte' ? 'bg-[rgba(29,158,117,0.15)] text-[#1D9E75] ring-1 ring-[#1D9E75]/30' : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D]'}`}
              >
                Aportar
              </button>
              <button
                onClick={() => setContribTipo('retiro')}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${contribTipo === 'retiro' ? 'bg-[rgba(216,90,48,0.15)] text-[#D85A30] ring-1 ring-[#D85A30]/30' : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D]'}`}
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
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${contribMonto === String(amt) ? 'bg-[rgba(29,158,117,0.15)] text-[#1D9E75] ring-1 ring-[#1D9E75]/30' : 'bg-[rgba(255,255,255,0.04)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.08)]'}`}
                >
                  S/ {amt}
                </button>
              ))}
            </div>

            {/* Custom amount */}
            <div>
              <label className="text-xs text-[#8A877D] mb-1.5 block">Monto (S/)</label>
              <input
                type="number"
                value={contribMonto}
                onChange={(e) => setContribMonto(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
              />
            </div>

            {/* Nota */}
            <div>
              <label className="text-xs text-[#8A877D] mb-1.5 block">Nota (opcional)</label>
              <input
                type="text"
                value={contribNota}
                onChange={(e) => setContribNota(e.target.value)}
                placeholder="Ej: Ahorro del mes"
                className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
              />
            </div>

            {/* Progress preview */}
            {contributeGoal && contribMonto && (
              <div className="text-xs text-[#8A877D] bg-[rgba(255,255,255,0.03)] rounded-lg px-3 py-2">
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
                className={`flex-1 text-white ${contribTipo === 'retiro' ? 'bg-[#D85A30] hover:bg-[#D85A30]/90' : 'bg-[#1D9E75] hover:bg-[#1D9E75]/90'}`}
                disabled={contribute.isPending}
              >
                {contribute.isPending ? 'Registrando...' : contribTipo === 'retiro' ? 'Retirar' : 'Aportar'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setContributeGoal(null)}
                className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
              >
                Cancelar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
          <DialogHeader>
            <DialogTitle>Eliminar meta</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-[#8A877D]">Esta accion no se puede deshacer.</p>
          <div className="flex gap-2 pt-2">
            <Button
              onClick={handleDelete}
              className="flex-1 bg-[#D85A30] text-white hover:bg-[#D85A30]/90"
              disabled={remove.isPending}
            >
              {remove.isPending ? 'Eliminando...' : 'Eliminar'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setDeleteId(null)}
              className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
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
