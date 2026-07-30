'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminCost, AdminCostCategory, AdminCostFrequency } from '@/lib/types-admin';

export interface CostInput {
  label: string;
  category: AdminCostCategory;
  frequency: AdminCostFrequency;
  currency: 'PEN' | 'USD';
  amount_pen: number;
  amount_original?: number | null;
  next_due_date?: string | null;
  notes?: string | null;
  active?: boolean;
  auto_debit?: boolean;
}

export function useAdminCosts() {
  return useQuery<AdminCost[]>({
    queryKey: ['admin', 'costs'],
    queryFn: async () => {
      const res = await fetch('/api/admin/costs', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load costs');
      const json = await res.json();
      return json.costs || [];
    },
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['admin', 'costs'] });
  queryClient.invalidateQueries({ queryKey: ['admin', 'economics'] });
}

export function useCreateAdminCost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CostInput) => {
      const res = await fetch('/api/admin/costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Error al crear costo');
      }
      return (await res.json()).cost as AdminCost;
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function useUpdateAdminCost(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<CostInput>) => {
      const res = await fetch(`/api/admin/costs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Error al actualizar costo');
      }
      return (await res.json()).cost as AdminCost;
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function useDeleteAdminCost(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/costs/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Error al pausar costo');
      }
      return (await res.json()).cost as AdminCost;
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function useMarkCostPaid(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input?: { amount_pen?: number }) => {
      const res = await fetch(`/api/admin/costs/${id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input || {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Error al marcar pagado');
      }
      return (await res.json()).cost as AdminCost;
    },
    onSuccess: () => invalidate(queryClient),
  });
}
