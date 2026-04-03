'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_DEBTS, DEMO_USER_ID } from '@/lib/demo/mock-data';

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
  invite_code: string | null;
  deuda_vinculada_id: string | null;
  created_at: string;
  updated_at: string;
  deuda_abonos?: DeudaAbono[];
}

export function useDebts(userId?: string) {
  return useQuery<Deuda[]>({
    queryKey: ['debts', userId],
    queryFn: async () => {
      if (IS_DEMO) return DEMO_DEBTS;
      const res = await fetch('/api/debts');
      if (!res.ok) throw new Error('Failed to fetch debts');
      return res.json();
    },
    enabled: IS_DEMO || !!userId,
  });
}

export interface DebtGroup {
  contraparte: string;
  pen: number;
  usd: number;
  debts: Deuda[];
}

export function groupDebtsByContraparte(debts: Deuda[]): DebtGroup[] {
  const map = new Map<string, DebtGroup>();
  for (const d of debts) {
    const key = d.contraparte.toLowerCase().trim();
    if (!map.has(key)) {
      map.set(key, { contraparte: d.contraparte, pen: 0, usd: 0, debts: [] });
    }
    const group = map.get(key)!;
    const monto = Number(d.monto_pendiente);
    if (d.moneda === 'USD') group.usd += monto;
    else group.pen += monto;
    group.debts.push(d);
  }
  return Array.from(map.values()).sort((a, b) => (b.pen + b.usd) - (a.pen + a.usd));
}

export function useDebtMutations() {
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: async (debt: Partial<Deuda> & { monto_original: number }) => {
      const id = `debt-${Date.now()}`;
      if (IS_DEMO) {
        const newDebt: Deuda = {
          id,
          usuario_id: DEMO_USER_ID,
          tipo: debt.tipo ?? 'debo',
          contraparte: debt.contraparte ?? '',
          monto_original: debt.monto_original,
          monto_pendiente: debt.monto_original,
          moneda: debt.moneda ?? 'PEN',
          descripcion: debt.descripcion ?? null,
          fecha_inicio: new Date().toISOString().split('T')[0],
          fecha_vencimiento: debt.fecha_vencimiento ?? null,
          estado: 'activa',
          invite_code: null,
          deuda_vinculada_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deuda_abonos: [],
        };
        queryClient.setQueryData<Deuda[]>(['debts', DEMO_USER_ID], (old) =>
          old ? [newDebt, ...old] : [newDebt]
        );
        return { ok: true, id };
      }
      const res = await fetch('/api/debts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(debt),
      });
      if (!res.ok) throw new Error('Failed to create debt');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['debts'] });
    },
  });

  const pay = useMutation({
    mutationFn: async ({ id, monto, nota }: { id: string; monto: number; nota?: string }) => {
      if (IS_DEMO) {
        queryClient.setQueryData<Deuda[]>(['debts', DEMO_USER_ID], (old) =>
          (old ?? []).map((d) => {
            if (d.id !== id) return d;
            const newPendiente = Math.max(0, d.monto_pendiente - monto);
            const newAbono: DeudaAbono = {
              id: `dab-${Date.now()}`,
              deuda_id: id,
              monto,
              fecha: new Date().toISOString().split('T')[0],
              nota: nota ?? null,
              created_at: new Date().toISOString(),
            };
            return {
              ...d,
              monto_pendiente: newPendiente,
              estado: newPendiente <= 0 ? 'pagada' as const : d.estado,
              updated_at: new Date().toISOString(),
              deuda_abonos: [...(d.deuda_abonos ?? []), newAbono],
            };
          })
        );
        return { ok: true, id };
      }
      const res = await fetch('/api/debts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'abonar', monto, nota }),
      });
      if (!res.ok) throw new Error('Failed to register payment');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['debts'] });
    },
  });

  const markPaid = useMutation({
    mutationFn: async (id: string) => {
      if (IS_DEMO) {
        queryClient.setQueryData<Deuda[]>(['debts', DEMO_USER_ID], (old) =>
          (old ?? []).map((d) =>
            d.id === id ? { ...d, monto_pendiente: 0, estado: 'pagada' as const, updated_at: new Date().toISOString() } : d
          )
        );
        return { ok: true, id };
      }
      const res = await fetch('/api/debts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'marcar_pagada' }),
      });
      if (!res.ok) throw new Error('Failed to mark as paid');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['debts'] });
    },
  });

  const update = useMutation({
    mutationFn: async ({ id, ...fields }: { id: string; contraparte?: string; descripcion?: string | null; fecha_vencimiento?: string | null }) => {
      if (IS_DEMO) {
        queryClient.setQueryData<Deuda[]>(['debts', DEMO_USER_ID], (old) =>
          (old ?? []).map((d) =>
            d.id === id ? { ...d, ...fields, updated_at: new Date().toISOString() } : d
          )
        );
        return { ok: true, id };
      }
      const res = await fetch('/api/debts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      });
      if (!res.ok) throw new Error('Failed to update debt');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['debts'] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (IS_DEMO) {
        queryClient.setQueryData<Deuda[]>(['debts', DEMO_USER_ID], (old) =>
          (old ?? []).filter((d) => d.id !== id)
        );
        return { ok: true, id };
      }
      const res = await fetch(`/api/debts?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete debt');
      return res.json();
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['debts'] });
    },
  });

  const shareDebt = useMutation({
    mutationFn: async (deuda_id: string) => {
      if (IS_DEMO) return { invite_code: 'DEMO-DEBT-INVITE', link: 'https://demo.neto.pe/debt/DEMO-DEBT-INVITE' };
      const res = await fetch('/api/debts/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deuda_id }),
      });
      if (!res.ok) throw new Error('Failed to generate invite link');
      return res.json() as Promise<{ invite_code: string; link: string }>;
    },
    onSuccess: () => {
      if (!IS_DEMO) queryClient.invalidateQueries({ queryKey: ['debts'] });
    },
  });

  return { create, update, pay, markPaid, remove, shareDebt };
}
