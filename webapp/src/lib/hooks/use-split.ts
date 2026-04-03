'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_SPLITS } from '@/lib/demo/mock-data';

export interface GastoParticipanteAbono {
  id: string;
  participante_id: string;
  monto: number;
  nota: string | null;
  created_at: string;
}

export interface GastoParticipante {
  id: string;
  gasto_id: string;
  nombre: string;
  usuario_id: string | null;
  monto_debe: number;
  monto_pagado: number;
  pagado: boolean;
  invite_code: string | null;
  notas: string | null;
  created_at: string;
  gasto_participante_abonos?: GastoParticipanteAbono[];
}

export interface GastoCompartido {
  id: string;
  creador_id: string;
  descripcion: string;
  monto_total: number;
  moneda: string;
  fecha: string;
  fecha_limite: string | null;
  notas: string | null;
  categoria: string | null;
  estado: 'activo' | 'liquidado';
  created_at: string;
  gasto_participantes?: GastoParticipante[];
}

export function useSplitExpenses(userId?: string) {
  return useQuery<GastoCompartido[]>({
    queryKey: ['split-expenses', userId],
    queryFn: async () => {
      if (IS_DEMO) return DEMO_SPLITS;
      const res = await fetch('/api/split');
      if (!res.ok) throw new Error('Failed to fetch split expenses');
      return res.json();
    },
    enabled: IS_DEMO || !!userId,
  });
}

export function useSplitMutations() {
  const queryClient = useQueryClient();

  const update = useMutation({
    mutationFn: async (data: {
      id: string;
      descripcion?: string;
      fecha_limite?: string | null;
      notas?: string | null;
      participantes?: { id: string; nombre: string }[];
    }) => {
      if (IS_DEMO) return { ok: true, id: data.id };
      const res = await fetch('/api/split', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to update split expense');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['split-expenses'] }),
  });

  const create = useMutation({
    mutationFn: async (data: {
      descripcion: string;
      monto_total: number;
      moneda?: string;
      categoria?: string;
      fecha_limite?: string;
      participantes: { nombre: string; monto_debe: number }[];
    }) => {
      if (IS_DEMO) return { ok: true, id: `demo-${Date.now()}` };
      const res = await fetch('/api/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to create split expense');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['split-expenses'] }),
  });

  const markPaid = useMutation({
    mutationFn: async (data: { gasto_id: string; participante_id: string; pagado?: boolean }) => {
      if (IS_DEMO) return { ok: true };
      const res = await fetch('/api/split', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to update payment');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['split-expenses'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (IS_DEMO) return { ok: true, id };
      const res = await fetch(`/api/split?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete split expense');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['split-expenses'] }),
  });

  const addPayment = useMutation({
    mutationFn: async (data: { gasto_id: string; participante_id: string; monto: number; nota?: string }) => {
      if (IS_DEMO) return { ok: true, id: `demo-${Date.now()}` };
      const res = await fetch('/api/split', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, action: 'abonar' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error || 'Failed to add payment');
      }
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['split-expenses'] }),
  });

  const shareSplit = useMutation({
    mutationFn: async (data: { gasto_id: string; participante_id: string }) => {
      if (IS_DEMO) return { invite_code: 'DEMO-SPLIT-INVITE', link: 'https://demo.neto.pe/split/DEMO-SPLIT-INVITE' };
      const res = await fetch('/api/split/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to generate invite');
      return res.json() as Promise<{ invite_code: string; link: string }>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['split-expenses'] }),
  });

  return { create, update, markPaid, addPayment, shareSplit, remove };
}
