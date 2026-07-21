'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_SPACES, DEMO_SPACE_DETAIL, DEMO_SPACE_DETAIL_MAP, DEMO_USER_ID } from '@/lib/demo/mock-data';

export interface SharedSpace {
  id: string;
  name: string;
  type: 'pareja' | 'roommates' | 'custom';
  invite_code: string;
  role: 'owner' | 'member';
  created_at: string;
}

export interface SpaceMember {
  user_id: string;
  role: string;
  split_percentage: number;
  usuarios: { nombre: string };
}

export interface SpaceExpense {
  id: string;
  paid_by: string;
  amount: number;
  description: string | null;
  category: string | null;
  created_at: string;
  usuarios: { nombre: string };
}

export interface SpaceSettlement {
  id: string;
  from_user: string;
  to_user: string;
  amount: number;
  settled_at: string;
  from?: { nombre: string };
  to?: { nombre: string };
}

export interface SpaceSplitRule {
  id: string;
  category: string;
  splits: Record<string, number>; // user_id -> percentage (0-100)
}

export interface SpaceBudget {
  id: string;
  category: string;
  limit: number; // monthly cap in PEN
}

export interface SpaceDetail {
  space: { id: string; name: string; type: string; invite_code: string };
  members: SpaceMember[];
  expenses: SpaceExpense[];
  settlements: SpaceSettlement[];
  balance: Record<string, number>;
  splitRules: SpaceSplitRule[];
  budgets: SpaceBudget[];
  currentUserId: string;
  isPro: boolean;
}

/**
 * Fraction (0-1) of an expense that belongs to a given user.
 * Re-exported from the shared split engine so the "tu parte" rendered here and
 * the balances computed server-side can never drift apart again.
 */
export { resolveSplit } from '@/lib/spaces-split';

export function useSpaces() {
  return useQuery<{ spaces: SharedSpace[]; isPro: boolean }>({
    queryKey: ['spaces'],
    queryFn: async () => {
      if (IS_DEMO) return DEMO_SPACES;
      const res = await fetch('/api/spaces');
      if (!res.ok) throw new Error('Failed to fetch spaces');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useSpaceDetail(spaceId: string) {
  return useQuery<SpaceDetail>({
    queryKey: ['space', spaceId],
    queryFn: async () => {
      if (IS_DEMO) return DEMO_SPACE_DETAIL_MAP[spaceId] ?? DEMO_SPACE_DETAIL;
      const res = await fetch(`/api/spaces/${spaceId}`);
      if (!res.ok) throw new Error('Failed to fetch space');
      return res.json();
    },
    enabled: IS_DEMO || !!spaceId,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useAddExpense(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { amount: number; description: string; category?: string }) => {
      if (IS_DEMO) {
        const newExpense: SpaceExpense = {
          id: `sexp-${Date.now()}`,
          paid_by: DEMO_USER_ID,
          amount: data.amount,
          description: data.description,
          category: data.category ?? null,
          created_at: new Date().toISOString(),
          usuarios: { nombre: 'Favio Demo' },
        };
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) =>
          old ? { ...old, expenses: [newExpense, ...old.expenses] } : old
        );
        return { ok: true, id: newExpense.id };
      }
      const res = await fetch(`/api/spaces/${spaceId}/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to add expense');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
    },
  });
}

export function useDeleteExpense(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (expenseId: string) => {
      if (IS_DEMO) {
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) =>
          old ? { ...old, expenses: old.expenses.filter((e) => e.id !== expenseId) } : old
        );
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}/expenses?id=${expenseId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete expense');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
    },
  });
}

export function useEditExpense(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { id: string; amount?: number; description?: string; category?: string }) => {
      if (IS_DEMO) {
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) =>
          old
            ? {
                ...old,
                expenses: old.expenses.map((e) =>
                  e.id === data.id
                    ? {
                        ...e,
                        amount: data.amount ?? e.amount,
                        description: data.description ?? e.description,
                        category: data.category ?? e.category,
                      }
                    : e
                ),
              }
            : old
        );
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}/expenses`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to edit expense');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
    },
  });
}

export function useSettle(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { to_user: string; amount: number }) => {
      if (IS_DEMO) {
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) => {
          if (!old) return old;
          const newSettlement: SpaceSettlement = {
            id: `settle-${Date.now()}`,
            from_user: DEMO_USER_ID,
            to_user: data.to_user,
            amount: data.amount,
            settled_at: new Date().toISOString(),
            from: { nombre: 'Favio Demo' },
            to: old.members.find((m) => m.user_id === data.to_user)?.usuarios,
          };
          const newBalance = { ...old.balance };
          newBalance[DEMO_USER_ID] = (newBalance[DEMO_USER_ID] ?? 0) + data.amount;
          newBalance[data.to_user] = (newBalance[data.to_user] ?? 0) - data.amount;
          return { ...old, settlements: [newSettlement, ...old.settlements], balance: newBalance };
        });
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to settle');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
    },
  });
}

export function useJoinSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      if (IS_DEMO) {
        const joined: SharedSpace = {
          id: `space-joined-${Date.now()}`,
          name: `Espacio ${code}`,
          type: 'custom',
          invite_code: code,
          role: 'member',
          created_at: new Date().toISOString(),
        };
        queryClient.setQueryData<{ spaces: SharedSpace[]; isPro: boolean }>(['spaces'], (old) =>
          old ? { ...old, spaces: [...old.spaces, joined] } : { spaces: [joined], isPro: true }
        );
        return { ok: true, code };
      }
      const res = await fetch('/api/spaces/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error('Failed to join');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function useCreateSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; type?: string }) => {
      const id = `space-${Date.now()}`;
      if (IS_DEMO) {
        const newSpace: SharedSpace = {
          id,
          name: data.name,
          type: (data.type as SharedSpace['type']) || 'custom',
          invite_code: generateCode(),
          role: 'owner',
          created_at: new Date().toISOString(),
        };
        queryClient.setQueryData<{ spaces: SharedSpace[]; isPro: boolean }>(['spaces'], (old) =>
          old ? { ...old, spaces: [...old.spaces, newSpace] } : { spaces: [newSpace], isPro: true }
        );
        // Also seed the space detail cache
        queryClient.setQueryData<SpaceDetail>(['space', id], {
          space: { id, name: data.name, type: data.type || 'custom', invite_code: newSpace.invite_code },
          members: [{ user_id: DEMO_USER_ID, role: 'owner', split_percentage: 100, usuarios: { nombre: 'Favio Demo' } }],
          expenses: [],
          settlements: [],
          balance: { [DEMO_USER_ID]: 0 },
          splitRules: [],
          budgets: [],
          currentUserId: DEMO_USER_ID,
          isPro: true,
        });
        return { ok: true, id };
      }
      const res = await fetch('/api/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to create space');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

export function useUpdateDefaultSplit(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (splits: Record<string, number>) => {
      if (IS_DEMO) {
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) => {
          if (!old) return old;
          const updatedMembers = old.members.map((m) => ({
            ...m,
            split_percentage: splits[m.user_id] ?? m.split_percentage,
          }));
          return { ...old, members: updatedMembers };
        });
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}/default-split`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ splits }),
      });
      if (!res.ok) throw new Error('Failed to update default split');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
    },
  });
}

export function useUpdateSplitRules(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (rules: SpaceSplitRule[]) => {
      if (IS_DEMO) {
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) =>
          old ? { ...old, splitRules: rules } : old
        );
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}/split-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      if (!res.ok) throw new Error('Failed to update split rules');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
    },
  });
}

export function useUpdateBudgets(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (budgets: SpaceBudget[]) => {
      if (IS_DEMO) {
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) =>
          old ? { ...old, budgets } : old
        );
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}/budgets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgets }),
      });
      if (!res.ok) throw new Error('Failed to update budgets');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
    },
  });
}

export function useRenameSpace(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      if (IS_DEMO) {
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) =>
          old ? { ...old, space: { ...old.space, name } } : old
        );
        queryClient.setQueryData<{ spaces: SharedSpace[]; isPro: boolean }>(['spaces'], (old) =>
          old ? { ...old, spaces: old.spaces.map((s) => s.id === spaceId ? { ...s, name } : s) } : old
        );
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('Failed to rename space');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) {
        queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
        queryClient.invalidateQueries({ queryKey: ['spaces'] });
      }
    },
  });
}

export function useDeleteSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (spaceId: string) => {
      if (IS_DEMO) {
        queryClient.setQueryData<{ spaces: SharedSpace[]; isPro: boolean }>(['spaces'], (old) =>
          old ? { ...old, spaces: old.spaces.filter((s) => s.id !== spaceId) } : old
        );
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete space');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

export function useRemoveMember(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      if (IS_DEMO) {
        queryClient.setQueryData<SpaceDetail>(['space', spaceId], (old) => {
          if (!old) return old;
          const newMembers = old.members.filter((m) => m.user_id !== userId);
          const newBalance = { ...old.balance };
          delete newBalance[userId];
          return { ...old, members: newMembers, balance: newBalance };
        });
        return { ok: true };
      }
      const res = await fetch(`/api/spaces/${spaceId}/members?userId=${userId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove member');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
    },
  });
}

/** Max members per space type */
export const SPACE_MEMBER_LIMITS: Record<string, number> = {
  pareja: 2,
  roommates: 6,
  custom: 6,
};
