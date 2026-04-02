'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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

export interface SpaceDetail {
  space: { id: string; name: string; type: string; invite_code: string };
  members: SpaceMember[];
  expenses: SpaceExpense[];
  settlements: SpaceSettlement[];
  balance: Record<string, number>;
  currentUserId: string;
  isPro: boolean;
}

export function useSpaces() {
  return useQuery<{ spaces: SharedSpace[]; isPro: boolean }>({
    queryKey: ['spaces'],
    queryFn: async () => {
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
      const res = await fetch(`/api/spaces/${spaceId}`);
      if (!res.ok) throw new Error('Failed to fetch space');
      return res.json();
    },
    enabled: !!spaceId,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useAddExpense(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { amount: number; description: string; category?: string }) => {
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
