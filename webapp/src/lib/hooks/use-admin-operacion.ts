'use client';

import { useQuery } from '@tanstack/react-query';

// Hooks React Query de la pantalla /admin/operacion. Antes la página hacía 4 fetch crudos en un
// useEffect con useState, ignorando el AdminQueryProvider ya montado: cada visita re-fetcheaba
// todo. Con React Query el cache (staleTime 5min) sobrevive a la navegación y las mutaciones
// invalidan las keys puntuales en vez de refetchear a mano.

export interface AdminStats {
  kpis: {
    mrr: number;
    arr: number;
    cajaMes: number;
    proReal: number;
    proMonthly: number;
    proYearly: number;
    churnRate: number;
    dau: number;
    wau: number;
    mau: number;
    conversionRate: number;
    avgTimeToFirstTx: number;
    txPerActiveUser: number;
  };
  userGrowth: { week: string; free: number; pro: number; total: number }[];
  funnel: {
    registered: number;
    onboardingComplete: number;
    firstTransaction: number;
    pro: number;
  };
  webappCoverage: number;
  nlpActivity: { date: string; errors: number }[];
  revenue: { month: string; mrr: number; newPro: number; churned: number }[];
}

export interface AdminUser {
  id: string;
  // NULLABLE, y el tipo lo decía mal hasta el 10-ago (hallazgo F9). La columna dejó de ser
  // obligatoria con la identidad dual (migración 046: un usuario web-first no tiene número), y
  // los otros tres consumidores del panel ya la tipaban `string | null`. Con el `string` de acá
  // el compilador dejaba pasar `u.whatsapp.replace(...)`, que es F5: el export CSV reventaba
  // con TypeError apenas un usuario sin número entraba en el filtro.
  whatsapp: string | null;
  nombre: string | null;
  email: string | null;
  plan: string;
  estado_pago: string | null;
  tipo_plan: string | null;
  fecha_pago: string | null;
  premium_vence: string | null;
  premium_desde: string | null;
  pago_pendiente: boolean | null;
  onboarding_completado: boolean;
  tiene_gmail: boolean;
  tiene_webapp: boolean;
  canal: 'whatsapp' | 'google' | 'magic_link';
  transacciones: number;
  created_at: string;
  // Actividad (migración 042) — alimenta los segmentos de la página admin/users.
  // Opcionales: operacion no los usa; la ruta /api/admin/users siempre los envía.
  tx_14d?: number;
  tx_30d?: number;
  first_tx_at?: string | null;
  last_tx_at?: string | null;
  // Última señal de vida REAL: transacción o mensaje (migración 053). last_tx_at mide
  // activación (registrar gastos); este mide si el usuario sigue ahí.
  last_activity_at?: string | null;
  is_internal?: boolean;
}

export interface NlpError {
  id: string;
  usuario_id: string;
  whatsapp: string | null;
  mensaje: string;
  intencion: string | null;
  error_tipo: string;
  error_detalle: string | null;
  created_at: string;
}

export interface Ticket {
  id: string;
  usuario_id: string | null;
  whatsapp: string | null;
  nombre_usuario: string | null;
  mensaje_usuario: string | null;
  mensaje_admin: string | null;
  estado: string;
  created_at: string;
  updated_at: string | null;
}

async function getJson(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load ${url}`);
  return res.json();
}

export function useAdminStats() {
  return useQuery<AdminStats>({
    queryKey: ['admin', 'stats'],
    queryFn: () => getJson('/api/admin/stats'),
  });
}

export function useAdminUsers() {
  return useQuery<{ usuarios: AdminUser[]; total: number }>({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const json = await getJson('/api/admin/users');
      return { usuarios: (json.usuarios || []) as AdminUser[], total: json.total || 0 };
    },
  });
}

export function useAdminNlpErrors() {
  return useQuery<{ errors: NlpError[]; total: number; rateLimitTotal: number }>({
    queryKey: ['admin', 'nlp-errors'],
    queryFn: async () => {
      const json = await getJson('/api/admin/nlp-errors?limit=100');
      return {
        errors: (json.errors || []) as NlpError[],
        total: json.total || 0,
        rateLimitTotal: json.rateLimitTotal || 0,
      };
    },
  });
}

interface TicketsFilters {
  page: number;
  estado: string;
  search: string;
}

export function useAdminTickets({ page, estado, search }: TicketsFilters) {
  return useQuery<{ tickets: Ticket[]; total: number }>({
    queryKey: ['admin', 'tickets', { page, estado, search }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '50', offset: String(page * 50) });
      if (estado !== 'todos') params.set('estado', estado);
      if (search) params.set('search', search);
      const json = await getJson(`/api/admin/tickets?${params}`);
      return { tickets: (json.tickets || []) as Ticket[], total: json.total || 0 };
    },
  });
}
