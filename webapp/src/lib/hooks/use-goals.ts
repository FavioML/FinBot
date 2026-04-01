'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface MetaAhorro {
  id: string;
  usuario_id: string;
  nombre: string;
  monto_objetivo: number;
  monto_actual: number;
  icono: string;
  fecha_limite: string | null;
  completada: boolean;
  created_at: string;
  updated_at: string;
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
      const res = await fetch('/api/goals');
      if (!res.ok) throw new Error('Failed to fetch goals');
      return res.json();
    },
    enabled: !!userId,
  });
}

export function useGoalContributions(metaId?: string) {
  return useQuery<MetaAporte[]>({
    queryKey: ['goal-contributions', metaId],
    queryFn: async () => {
      const res = await fetch(`/api/goals/aportes?meta_id=${metaId}`);
      if (!res.ok) throw new Error('Failed to fetch contributions');
      return res.json();
    },
    enabled: !!metaId,
  });
}

export function useAchievements(userId?: string) {
  return useQuery<Logro[]>({
    queryKey: ['achievements', userId],
    queryFn: async () => {
      const res = await fetch('/api/achievements');
      if (!res.ok) throw new Error('Failed to fetch achievements');
      return res.json();
    },
    enabled: !!userId,
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
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(goal),
      });
      if (!res.ok) throw new Error('Failed to create goal');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] }),
  });

  const update = useMutation({
    mutationFn: async (goal: GoalInput) => {
      const res = await fetch('/api/goals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(goal),
      });
      if (!res.ok) throw new Error('Failed to update goal');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/goals?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete goal');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] }),
  });

  const contribute = useMutation({
    mutationFn: async (data: { meta_id: string; monto: number; tipo?: 'aporte' | 'retiro'; nota?: string }) => {
      const res = await fetch('/api/goals/aportes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to register contribution');
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      queryClient.invalidateQueries({ queryKey: ['goal-contributions', variables.meta_id] });
      queryClient.invalidateQueries({ queryKey: ['achievements'] });
    },
  });

  const removeContribution = useMutation({
    mutationFn: async (id: string) => {
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

  return { create, update, remove, contribute, removeContribution, generateInvite, joinGoal };
}
