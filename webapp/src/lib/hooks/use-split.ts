'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
      const res = await fetch('/api/split');
      if (!res.ok) throw new Error('Failed to fetch split expenses');
      return res.json();
    },
    enabled: !!userId,
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
      const res = await fetch(`/api/split?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete split expense');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['split-expenses'] }),
  });

  const addPayment = useMutation({
    mutationFn: async (data: { gasto_id: string; participante_id: string; monto: number; nota?: string }) => {
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
