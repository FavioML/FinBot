'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface DeudaAbono {
  id: string;
  deuda_id: string;
  monto: number;
  fecha: string;
  nota: string | null;
  created_at: string;
}

export interface Deuda {
  id: string;
  usuario_id: string;
  tipo: 'debo' | 'me_deben';
  contraparte: string;
  monto_original: number;
  monto_pendiente: number;
  moneda: 'PEN' | 'USD';
  descripcion: string | null;
  fecha_inicio: string;
  fecha_vencimiento: string | null;
  estado: 'activa' | 'pagada';
  created_at: string;
  updated_at: string;
  deuda_abonos?: DeudaAbono[];
}

export function useDebts(userId?: string) {
  return useQuery<Deuda[]>({
    queryKey: ['debts', userId],
    queryFn: async () => {
      const res = await fetch('/api/debts');
      if (!res.ok) throw new Error('Failed to fetch debts');
      return res.json();
    },
    enabled: !!userId,
  });
}

export function useDebtMutations() {
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: async (debt: Partial<Deuda> & { monto_original: number }) => {
      const res = await fetch('/api/debts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(debt),
      });
      if (!res.ok) throw new Error('Failed to create debt');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['debts'] }),
  });

  const pay = useMutation({
    mutationFn: async ({ id, monto, nota }: { id: string; monto: number; nota?: string }) => {
      const res = await fetch('/api/debts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'abonar', monto, nota }),
      });
      if (!res.ok) throw new Error('Failed to register payment');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['debts'] }),
  });

  const markPaid = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch('/api/debts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'marcar_pagada' }),
      });
      if (!res.ok) throw new Error('Failed to mark as paid');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['debts'] }),
  });

  const update = useMutation({
    mutationFn: async ({ id, ...fields }: { id: string; contraparte?: string; descripcion?: string | null; fecha_vencimiento?: string | null }) => {
      const res = await fetch('/api/debts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      });
      if (!res.ok) throw new Error('Failed to update debt');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['debts'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/debts?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete debt');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['debts'] }),
  });

  return { create, update, pay, markPaid, remove };
}
