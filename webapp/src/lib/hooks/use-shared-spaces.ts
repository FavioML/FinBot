'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_SPACES, DEMO_SPACE_DETAIL } from '@/lib/demo/mock-data';

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

/** Returns the fraction (0-1) of an expense that belongs to a given user */
export function resolveSplit(
  category: string | null,
  userId: string,
  members: SpaceMember[],
  splitRules: SpaceSplitRule[],
): number {
  if (category) {
    const rule = splitRules.find((r) => r.category === category);
    if (rule && rule.splits[userId] !== undefined) {
      const total = Object.values(rule.splits).reduce((s, v) => s + v, 0);
      return total > 0 ? rule.splits[userId] / total : 1 / members.length;
    }
  }
  const totalPct = members.reduce((s, m) => s + (m.split_percentage || 0), 0);
  const member = members.find((m) => m.user_id === userId);
  return member && totalPct > 0
    ? (member.split_percentage || 0) / totalPct
    : 1 / members.length;
}

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
      if (IS_DEMO) return DEMO_SPACE_DETAIL;
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
      if (IS_DEMO) return { ok: true, id: `demo-${Date.now()}` };
      const res = await fetch(`/api/spaces/${spaceId}/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to add expense');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['space', spaceId] }),
  });
}

export function useSettle(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { to_user: string; amount: number }) => {
      if (IS_DEMO) return { ok: true };
      const res = await fetch(`/api/spaces/${spaceId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to settle');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['space', spaceId] }),
  });
}

export function useJoinSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      if (IS_DEMO) return { ok: true, code };
      const res = await fetch('/api/spaces/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error('Failed to join');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['spaces'] }),
  });
}

export function useCreateSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; type?: string }) => {
      if (IS_DEMO) return { ok: true, id: `demo-${Date.now()}` };
      const res = await fetch('/api/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to create space');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['spaces'] }),
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
