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

  return { create, update, remove };
}
