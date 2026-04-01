'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface GastoParticipante {
  id: string;
  gasto_id: string;
  nombre: string;
  usuario_id: string | null;
  monto_debe: number;
  pagado: boolean;
  created_at: string;
}

export interface GastoCompartido {
  id: string;
  creador_id: string;
  descripcion: string;
  monto_total: number;
  moneda: string;
  fecha: string;
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

  const create = useMutation({
    mutationFn: async (data: {
      descripcion: string;
      monto_total: number;
      moneda?: string;
      categoria?: string;
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

  return { create, markPaid, remove };
}
