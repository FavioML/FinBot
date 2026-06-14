'use client';

import { useMemo } from 'react';
import { Trophy, Lock, CalendarDays, ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import { LogrosSkeleton } from '@/components/dashboard/skeletons';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { useUser } from '@/lib/hooks/use-user';
import { useGoals, useAchievements, type MetaAhorro } from '@/lib/hooks/use-goals';
import { HeaderActions } from '@/components/dashboard/topbar';
import type { Logro } from '@/lib/hooks/use-goals';

export const dynamic = 'force-dynamic';

const LOGRO_CATALOG = [
  { tipo: 'primera_meta', emoji: '🌟', label: 'Primera meta', desc: 'Crea tu primera meta de ahorro', category: 'metas' },
  { tipo: 'primer_abono', emoji: '💫', label: 'Primer aporte', desc: 'Haz tu primer aporte a una meta', category: 'metas' },
  { tipo: 'milestone_25', emoji: '🥉', label: '25% alcanzado', desc: 'Alcanza el 25% de una meta', category: 'progreso' },
  { tipo: 'milestone_50', emoji: '🥈', label: 'Medio camino', desc: 'Alcanza el 50% de una meta', category: 'progreso' },
  { tipo: 'milestone_75', emoji: '🥇', label: 'Casi listo', desc: 'Alcanza el 75% de una meta', category: 'progreso' },
  { tipo: 'meta_cumplida', emoji: '🏆', label: 'Meta cumplida', desc: 'Completa una meta al 100%', category: 'progreso' },
  { tipo: 'racha_3', emoji: '🔥', label: '3 semanas', desc: 'Aporta 3 semanas consecutivas', category: 'constancia' },
  { tipo: 'racha_5', emoji: '🔥', label: '5 semanas', desc: 'Aporta 5 semanas consecutivas', category: 'constancia' },
  { tipo: 'racha_10', emoji: '💎', label: 'Constancia', desc: 'Aporta 10 semanas consecutivas', category: 'constancia' },
];

function timeAgo(dateStr: string): string {
  const now = new Date();
  const d = new Date(dateStr);
  const diffMs = now.getTime() - d.getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} dias`;
  if (days < 30) return `hace ${Math.floor(days / 7)} sem`;
  if (days < 365) return `hace ${Math.floor(days / 30)} meses`;
  return `hace ${Math.floor(days / 365)} anos`;
}

function calcularRacha(goals: MetaAhorro[]): number {
  // Calculate streak: how many consecutive weeks the user made at least 1 contribution
  const allAportes = goals
    .flatMap((g) => g.meta_aportes || [])
    .filter((a) => a.tipo === 'aporte')
    .map((a) => new Date(a.fecha || a.created_at));

  if (allAportes.length === 0) return 0;

  // Group by ISO week
  const weekSet = new Set<string>();
  for (const d of allAportes) {
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    weekSet.add(`${d.getFullYear()}-W${weekNum}`);
  }

  // Count streak from current week backwards
  const now = new Date();
  let streak = 0;
  let checkDate = new Date(now);

  for (let i = 0; i < 52; i++) {
    const jan1 = new Date(checkDate.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((checkDate.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    const key = `${checkDate.getFullYear()}-W${weekNum}`;

    if (weekSet.has(key)) {
      streak++;
    } else if (i > 0) {
      // Allow current week to not have contribution yet
      break;
    }
    checkDate = new Date(checkDate.getTime() - 7 * 86400000);
  }

  return streak;
}

export default function LogrosPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const { data: goals = [], isLoading: goalsLoading } = useGoals(user?.id);
  const { data: achievements = [], isLoading: achievementsLoading } = useAchievements(user?.id);

  const isLoading = userLoading || goalsLoading || achievementsLoading;

  const { unlockedMap, totalUnlocked, streak, nextToUnlock } = useMemo(() => {
    const unlockedMap = new Map<string, Logro>();
    for (const a of achievements) {
      // Use first occurrence per tipo (they come sorted by created_at desc)
      if (!unlockedMap.has(a.tipo)) {
        unlockedMap.set(a.tipo, a);
      }
    }

    const totalUnlocked = unlockedMap.size;
    const streak = calcularRacha(goals);

    // Find next achievement to unlock
    let nextToUnlock: (typeof LOGRO_CATALOG)[0] | null = null;
    for (const item of LOGRO_CATALOG) {
      if (!unlockedMap.has(item.tipo)) {
        nextToUnlock = item;
        break;
      }
    }

    return { unlockedMap, totalUnlocked, streak, nextToUnlock };
  }, [achievements, goals]);

  if (isLoading) {
    return (
      <LogrosSkeleton />
    );
  }

  // Empty state: no goals and no achievements
  if (achievements.length === 0 && goals.length === 0) {
    return (
      <div className="space-y-6">
        <FadeIn>
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-[#F0EFE8]">Logros</h1>
            <HeaderActions />
          </div>
        </FadeIn>
        <FadeIn delay={0.05}>
          <div className="glass-card p-10 flex flex-col items-center text-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[rgba(29,158,117,0.1)]">
              <Trophy className="h-8 w-8 text-[#1D9E75]/40" />
            </div>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-[#F0EFE8]">Aún no tienes logros</h2>
              <p className="text-sm text-[#8A877D] max-w-xs">
                Completa tus metas de ahorro para desbloquear logros y medallas
              </p>
            </div>
            <a
              href="/dashboard/planes"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1D9E75] text-white text-sm font-medium hover:bg-[#1D9E75]/90 transition-colors"
            >
              Crear mi primera meta
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </FadeIn>
      </div>
    );
  }

  const completedGoals = goals.filter((g) => g.completada).length;
  const totalGoals = goals.length;
  const progressPct = LOGRO_CATALOG.length > 0 ? Math.round((totalUnlocked / LOGRO_CATALOG.length) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <FadeIn>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[rgba(29,158,117,0.12)]">
              <Trophy className="h-5 w-5 text-[#1D9E75]" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[#F0EFE8]">Logros</h1>
              <p className="text-xs text-[#8A877D]">{totalUnlocked} de {LOGRO_CATALOG.length} desbloqueados</p>
            </div>
          </div>
          <HeaderActions />
        </div>
      </FadeIn>

      {/* Stats row */}
      <FadeIn delay={0.1}>
        <div className="grid grid-cols-3 gap-3">
          {/* Total logros */}
          <div className="glass-card p-4 text-center">
            <p className="text-2xl font-bold text-[#1D9E75]">{totalUnlocked}</p>
            <p className="text-[10px] text-[#8A877D] mt-1">Logros</p>
            <div className="mt-2 h-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-[#1D9E75]"
                initial={{ width: 0 }}
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
              />
            </div>
          </div>

          {/* Racha */}
          <div className="glass-card p-4 text-center">
            <p className="text-2xl font-bold text-[#EF9F27]">
              {streak > 0 ? streak : '—'}
            </p>
            <p className="text-[10px] text-[#8A877D] mt-1">
              {streak === 1 ? 'Semana racha' : 'Semanas racha'}
            </p>
            {streak >= 3 && (
              <p className="text-xs mt-1">🔥</p>
            )}
          </div>

          {/* Metas completadas */}
          <div className="glass-card p-4 text-center">
            <p className="text-2xl font-bold text-[#F0EFE8]">{completedGoals}</p>
            <p className="text-[10px] text-[#8A877D] mt-1">
              {totalGoals > 0 ? `de ${totalGoals} metas` : 'Metas cumplidas'}
            </p>
          </div>
        </div>
      </FadeIn>

      {/* Next achievement hint */}
      {nextToUnlock && (
        <FadeIn delay={0.15}>
          <div className="glass-card glass-card-glow p-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[rgba(239,159,39,0.12)] shrink-0">
              <span className="text-lg">{nextToUnlock.emoji}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-[#EF9F27]">Proximo logro</p>
              <p className="text-sm text-[#C8C6BC] font-medium">{nextToUnlock.label}</p>
              <p className="text-[10px] text-[#8A877D]">{nextToUnlock.desc}</p>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Badges grid */}
      <FadeIn delay={0.2}>
        <h2 className="text-sm font-medium text-[#C8C6BC] mb-3">Todos los logros</h2>
      </FadeIn>

      <StaggerContainer>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {LOGRO_CATALOG.map((item) => {
            const unlocked = unlockedMap.get(item.tipo);
            const isUnlocked = !!unlocked;

            return (
              <StaggerItem key={item.tipo}>
                <motion.div
                  className={`glass-card p-4 flex flex-col items-center text-center transition-all duration-300 ${
                    isUnlocked
                      ? 'glass-card-glow ring-1 ring-[rgba(29,158,117,0.2)]'
                      : 'opacity-50 grayscale'
                  }`}
                  whileHover={isUnlocked ? { scale: 1.02 } : undefined}
                >
                  <div className={`flex h-12 w-12 items-center justify-center rounded-2xl mb-2 ${
                    isUnlocked
                      ? 'bg-[rgba(29,158,117,0.12)]'
                      : 'bg-[rgba(255,255,255,0.04)]'
                  }`}>
                    {isUnlocked ? (
                      <span className="text-2xl">{item.emoji}</span>
                    ) : (
                      <Lock className="h-5 w-5 text-[#8A877D]" />
                    )}
                  </div>

                  <p className={`text-xs font-medium ${isUnlocked ? 'text-[#F0EFE8]' : 'text-[#8A877D]'}`}>
                    {item.label}
                  </p>
                  <p className="text-[10px] text-[#8A877D] mt-0.5 leading-snug">
                    {item.desc}
                  </p>

                  {isUnlocked && unlocked.fecha && (
                    <p className="text-[9px] text-[#1D9E75] mt-2 flex items-center gap-1">
                      <CalendarDays className="h-3 w-3" />
                      {timeAgo(unlocked.fecha)}
                    </p>
                  )}
                </motion.div>
              </StaggerItem>
            );
          })}
        </div>
      </StaggerContainer>

      {/* Timeline of recent achievements */}
      {achievements.length > 0 && (
        <FadeIn delay={0.3}>
          <h2 className="text-sm font-medium text-[#C8C6BC] mb-3 mt-6">Historial</h2>
          <div className="space-y-2">
            {achievements.slice(0, 10).map((logro) => {
              const catalogItem = LOGRO_CATALOG.find((c) => c.tipo === logro.tipo);
              if (!catalogItem) return null;

              return (
                <div
                  key={logro.id}
                  className="glass-card p-3 flex items-center gap-3"
                >
                  <span className="text-lg shrink-0">{catalogItem.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[#C8C6BC]">{catalogItem.label}</p>
                    <p className="text-[10px] text-[#8A877D]">{catalogItem.desc}</p>
                  </div>
                  <span className="text-[10px] text-[#8A877D] shrink-0">
                    {logro.fecha
                      ? new Date(logro.fecha + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })
                      : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </FadeIn>
      )}
    </div>
  );
}
