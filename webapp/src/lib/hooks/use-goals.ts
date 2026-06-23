'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_GOALS, DEMO_GOAL_CONTRIBUTIONS, DEMO_ACHIEVEMENTS, DEMO_USER_ID } from '@/lib/demo/mock-data';
import { hoyPeru } from '@/lib/dates';
import { track, EVENTS } from '@/lib/analytics';

export interface MetaAhorro {
  id: string;
  usuario_id: string;
  nombre: string;
  monto_objetivo: number;
  monto_actual: number;
  icono: string | null;
  fecha_limite: string | null;
  completada: boolean;
  colaborativa?: boolean;
  invite_code?: string | null;
  max_participantes?: number;
  created_at: string;
  updated_at: string | null;
  // v2 — Planes de Ahorro
  monthly_quota: number | null;
  status: 'active' | 'completed' | 'abandoned';
  space_id: string | null;
  meta_aportes?: MetaAporte[];
}

export interface MetaAporte {
  id: string;
  meta_id: string;
  monto: number;
  tipo: 'aporte' | 'retiro';
  fecha: string;
  nota: string | null;
  created_at: string;
}

export interface Logro {
  id: string;
  usuario_id: string;
  tipo: string;
  meta_id: string | null;
  datos: Record<string, unknown>;
  fecha: string;
  created_at: string;
}

export function useGoals(userId?: string) {
  return useQuery<MetaAhorro[]>({
    queryKey: ['goals', userId],
    queryFn: async () => {
      if (IS_DEMO) return DEMO_GOALS;
      const res = await fetch('/api/goals');
      if (!res.ok) throw new Error('Failed to fetch goals');
      return res.json();
    },
    enabled: IS_DEMO || !!userId,
  });
}

export function useGoalContributions(metaId?: string) {
  return useQuery<MetaAporte[]>({
    queryKey: ['goal-contributions', metaId],
    queryFn: async () => {
      if (IS_DEMO) return DEMO_GOAL_CONTRIBUTIONS.filter(a => a.meta_id === metaId);
      const res = await fetch(`/api/goals/aportes?meta_id=${metaId}`);
      if (!res.ok) throw new Error('Failed to fetch contributions');
      return res.json();
    },
    enabled: IS_DEMO || !!metaId,
  });
}

export function useAchievements(userId?: string) {
  return useQuery<Logro[]>({
    queryKey: ['achievements', userId],
    queryFn: async () => {
      if (IS_DEMO) return DEMO_ACHIEVEMENTS;
      const res = await fetch('/api/achievements');
      if (!res.ok) throw new Error('Failed to fetch achievements');
      return res.json();
    },
    enabled: IS_DEMO || !!userId,
  });
}

export interface MetaParticipante {
  id: string;
  usuario_id: string;
  rol: string;
  fecha_union: string;
  nombre: string;
  whatsapp: string | null;
  total_aportado: number;
}

export function useGoalParticipants(metaId?: string) {
  return useQuery<MetaParticipante[]>({
    queryKey: ['goal-participants', metaId],
    queryFn: async () => {
      if (IS_DEMO) return [];
      const res = await fetch(`/api/goals/participants?meta_id=${metaId}`);
      if (!res.ok) throw new Error('Failed to fetch participants');
      return res.json();
    },
    enabled: IS_DEMO || !!metaId,
  });
}

export function useGoalMutations() {
  const queryClient = useQueryClient();

  type GoalInput = Omit<Partial<MetaAhorro>, 'monto_objetivo' | 'monto_actual'> & {
    monto_objetivo?: number | string;
    monto_actual?: number | string;
  };

  const create = useMutation({
    mutationFn: async (goal: GoalInput) => {
      const id = `demo-${Date.now()}`;
      if (IS_DEMO) {
        const newGoal: MetaAhorro = {
          id,
          usuario_id: DEMO_USER_ID,
          nombre: goal.nombre || '',
          monto_objetivo: parseFloat(String(goal.monto_objetivo ?? 0)),
          monto_actual: parseFloat(String(goal.monto_actual ?? 0)),
          icono: goal.icono ?? '🎯',
          fecha_limite: goal.fecha_limite ?? null,
          completada: false,
          monthly_quota: null,
          status: 'active',
          space_id: null,
          created_at: new Date().toISOString(),
          updated_at: null,
        };
        queryClient.setQueryData<MetaAhorro[]>(['goals', DEMO_USER_ID], (old) =>
          old ? [...old, newGoal] : [newGoal]
        );
        return { ok: true, id };
      }
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(goal),
      });
      if (!res.ok) throw new Error('Failed to create goal');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) {
        queryClient.invalidateQueries({ queryKey: ['goals'] });
        track(EVENTS.GOAL_CREATED);
      }
    },
  });

  const update = useMutation({
    mutationFn: async (goal: GoalInput) => {
      if (IS_DEMO) {
        queryClient.setQueryData<MetaAhorro[]>(['goals', DEMO_USER_ID], (old) =>
          (old ?? []).map((g) =>
            g.id === goal.id
              ? {
                  ...g,
                  nombre: goal.nombre ?? g.nombre,
                  monto_objetivo: goal.monto_objetivo !== undefined ? parseFloat(String(goal.monto_objetivo)) : g.monto_objetivo,
                  monto_actual: goal.monto_actual !== undefined ? parseFloat(String(goal.monto_actual)) : g.monto_actual,
                  icono: goal.icono !== undefined ? goal.icono : g.icono,
                  fecha_limite: goal.fecha_limite !== undefined ? goal.fecha_limite ?? null : g.fecha_limite,
                  completada: goal.completada !== undefined ? goal.completada : g.completada,
                  status: goal.completada ? 'completed' : goal.completada === false ? 'active' : g.status,
                  updated_at: new Date().toISOString(),
                }
              : g
          )
        );
        return { ok: true, id: goal.id };
      }
      const res = await fetch('/api/goals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(goal),
      });
      if (!res.ok) throw new Error('Failed to update goal');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (IS_DEMO) {
        queryClient.setQueryData<MetaAhorro[]>(['goals', DEMO_USER_ID], (old) =>
          (old ?? []).filter((g) => g.id !== id)
        );
        return { ok: true, id };
      }
      const res = await fetch(`/api/goals?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete goal');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });

  const contribute = useMutation({
    mutationFn: async (data: { meta_id: string; monto: number; tipo?: 'aporte' | 'retiro'; nota?: string }) => {
      const tipo = data.tipo ?? 'aporte';
      if (IS_DEMO) {
        const delta = tipo === 'retiro' ? -data.monto : data.monto;
        // Update goal amount
        queryClient.setQueryData<MetaAhorro[]>(['goals', DEMO_USER_ID], (old) =>
          (old ?? []).map((g) => {
            if (g.id !== data.meta_id) return g;
            const newAmount = Math.max(0, g.monto_actual + delta);
            const newAporte: MetaAporte = {
              id: `ap-${Date.now()}`,
              meta_id: data.meta_id,
              monto: data.monto,
              tipo,
              fecha: hoyPeru(),
              nota: data.nota ?? null,
              created_at: new Date().toISOString(),
            };
            return {
              ...g,
              monto_actual: newAmount,
              completada: newAmount >= g.monto_objetivo,
              status: newAmount >= g.monto_objetivo ? 'completed' as const : g.status,
              updated_at: new Date().toISOString(),
              meta_aportes: [newAporte, ...(g.meta_aportes ?? [])],
            };
          })
        );
        // Update contributions cache
        queryClient.setQueryData<MetaAporte[]>(['goal-contributions', data.meta_id], (old) => {
          const newAporte: MetaAporte = {
            id: `ap-${Date.now()}`,
            meta_id: data.meta_id,
            monto: data.monto,
            tipo,
            fecha: hoyPeru(),
            nota: data.nota ?? null,
            created_at: new Date().toISOString(),
          };
          return [newAporte, ...(old ?? [])];
        });
        const goal = queryClient.getQueryData<MetaAhorro[]>(['goals', DEMO_USER_ID])?.find((g) => g.id === data.meta_id);
        const milestone = goal && goal.monto_actual >= goal.monto_objetivo ? 100 : undefined;
        return { ok: true, id: `demo-${Date.now()}`, milestone };
      }
      const res = await fetch('/api/goals/aportes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to register contribution');
      return res.json();
    },
    onSuccess: (_data, variables) => {
      if (!IS_DEMO) {
        queryClient.invalidateQueries({ queryKey: ['goals'] });
        queryClient.invalidateQueries({ queryKey: ['goal-contributions', variables.meta_id] });
        queryClient.invalidateQueries({ queryKey: ['achievements'] });
      }
    },
  });

  const removeContribution = useMutation({
    mutationFn: async (id: string) => {
      if (IS_DEMO) return { ok: true, id };
      const res = await fetch(`/api/goals/aportes?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete contribution');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      queryClient.invalidateQueries({ queryKey: ['goal-contributions'] });
      queryClient.invalidateQueries({ queryKey: ['achievements'] });
    },
  });

  const generateInvite = useMutation({
    mutationFn: async (meta_id: string) => {
      if (IS_DEMO) return { invite_code: 'DEMO-INVITE', link: 'https://demo.neto.pe/join/DEMO-INVITE' };
      const res = await fetch('/api/goals/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta_id }),
      });
      if (!res.ok) throw new Error('Failed to generate invite');
      return res.json() as Promise<{ invite_code: string; link: string }>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] }),
  });

  const joinGoal = useMutation({
    mutationFn: async (code: string) => {
      if (IS_DEMO) return { ok: true, code };
      const res = await fetch('/api/goals/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error('Failed to join goal');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] }),
  });

  const disableCollab = useMutation({
    mutationFn: async (meta_id: string) => {
      if (IS_DEMO) return { ok: true, meta_id };
      const res = await fetch(`/api/goals/participants?meta_id=${meta_id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to disable collaborative mode');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      queryClient.invalidateQueries({ queryKey: ['goal-participants'] });
    },
  });

  return { create, update, remove, contribute, removeContribution, generateInvite, joinGoal, disableCollab };
}

export function useAbandonPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (metaId: string) => {
      if (IS_DEMO) {
        queryClient.setQueryData<MetaAhorro[]>(['goals', DEMO_USER_ID], (old) =>
          (old ?? []).map((g) =>
            g.id === metaId ? { ...g, status: 'abandoned' as const, updated_at: new Date().toISOString() } : g
          )
        );
        return { ok: true, id: metaId };
      }
      const res = await fetch(`/api/goals/${metaId}/abandon`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to abandon plan');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}
