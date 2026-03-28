'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

const ADMIN_EMAIL = 'faviomendoza27jl@gmail.com';

interface AdminUser {
  id: string;
  whatsapp: string;
  nombre: string | null;
  email: string | null;
  plan: string;
  estado_pago: string | null;
  tipo_plan: string | null;
  fecha_pago: string | null;
  premium_vence: string | null;
  onboarding_completado: boolean;
  tiene_gmail: boolean;
  tiene_webapp: boolean;
  transacciones: number;
  created_at: string;
}

interface NlpError {
  id: string;
  usuario_id: string;
  whatsapp: string | null;
  mensaje: string;
  intencion: string | null;
  error_tipo: string;
  error_detalle: string | null;
  created_at: string;
}

interface Ticket {
  id: string;
  usuario_id: string | null;
  whatsapp: string | null;
  mensaje: string;
  estado: string;
  respuesta_admin: string | null;
  respondido_at: string | null;
  created_at: string;
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '\u2014';
  return new Date(dateStr).toLocaleDateString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function PlanBadge({ plan }: { plan: string }) {
  const isPro = plan === 'premium';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        isPro
          ? 'bg-[#1D9E75]/20 text-[#1D9E75]'
          : 'bg-white/5 text-[#F0EFE8]/60'
      }`}
    >
      {isPro ? 'Pro' : 'Free'}
    </span>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        active ? 'bg-[#1D9E75]' : 'bg-white/20'
      }`}
    />
  );
}

// --- Action Menu ---
function UserActions({
  user,
  onAction,
}: {
  user: AdminUser;
  onAction: (userId: string, action: string, data?: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(null);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const exec = async (action: string, data?: Record<string, unknown>) => {
    setBusy(true);
    await onAction(user.id, action, data);
    setBusy(false);
    setOpen(false);
    setConfirming(null);
  };

  const isPro = user.plan === 'premium';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(!open); setConfirming(null); }}
        className="rounded-md p-1.5 text-[#F0EFE8]/40 hover:bg-white/5 hover:text-[#F0EFE8] transition-colors"
        title="Acciones"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-56 rounded-xl border border-white/10 bg-[#1A1A18] shadow-xl shadow-black/40">
          {/* Confirming state */}
          {confirming && (
            <div className="p-3">
              <p className="mb-3 text-xs text-[#F0EFE8]/70">
                {confirming === 'delete'
                  ? `Eliminar a ${user.nombre || user.whatsapp}? Se borran TODOS sus datos. Irreversible.`
                  : confirming === 'deactivate'
                    ? `Desactivar a ${user.nombre || user.whatsapp}? Se pasa a Free y se desconecta Gmail.`
                    : `Confirmar accion?`}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirming(null)}
                  disabled={busy}
                  className="flex-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-[#F0EFE8]/60 hover:bg-white/5"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => exec(confirming)}
                  disabled={busy}
                  className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white ${
                    confirming === 'delete'
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-amber-600 hover:bg-amber-700'
                  }`}
                >
                  {busy ? 'Procesando...' : 'Confirmar'}
                </button>
              </div>
            </div>
          )}

          {/* Menu items */}
          {!confirming && (
            <div className="py-1">
              {/* Plan actions */}
              {!isPro && (
                <button
                  onClick={() => exec('set_plan', { plan: 'premium' })}
                  disabled={busy}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-[#F0EFE8]/80 hover:bg-white/5"
                >
                  <span className="text-[#1D9E75]">&#9733;</span> Activar Pro (30 dias)
                </button>
              )}
              {isPro && (
                <>
                  <button
                    onClick={() => exec('extend_premium', { days: 30 })}
                    disabled={busy}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-[#F0EFE8]/80 hover:bg-white/5"
                  >
                    <span className="text-[#1D9E75]">+</span> Extender +30 dias
                  </button>
                  <button
                    onClick={() => exec('set_plan', { plan: 'free' })}
                    disabled={busy}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-[#F0EFE8]/80 hover:bg-white/5"
                  >
                    <span className="text-[#F0EFE8]/40">&#9744;</span> Pasar a Free
                  </button>
                </>
              )}

              <div className="my-1 border-t border-white/5" />

              {/* Deactivate */}
              <button
                onClick={() => setConfirming('deactivate')}
                disabled={busy}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-amber-400/80 hover:bg-white/5"
              >
                <span>&#9888;</span> Desactivar cuenta
              </button>

              {/* Delete */}
              <button
                onClick={() => setConfirming('delete')}
                disabled={busy}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-red-400/80 hover:bg-white/5"
              >
                <span>&#10005;</span> Eliminar usuario
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Toast ---
function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed bottom-6 right-6 z-50 rounded-xl border border-white/10 bg-[#1A1A18] px-4 py-3 text-sm text-[#F0EFE8] shadow-xl shadow-black/40">
      {message}
    </div>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [tab, setTab] = useState<'users' | 'nlp' | 'tickets'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nlpErrors, setNlpErrors] = useState<NlpError[]>([]);
  const [nlpTotal, setNlpTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [nlpSearch, setNlpSearch] = useState('');
  const [nlpTipoFilter, setNlpTipoFilter] = useState<string>('all');
  const [nlpUserFilter, setNlpUserFilter] = useState<string>('all');

  // Tickets state
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsTotal, setTicketsTotal] = useState(0);
  const [ticketEstadoFilter, setTicketEstadoFilter] = useState<string>('todos');
  const [ticketSearch, setTicketSearch] = useState('');
  const [ticketPage, setTicketPage] = useState(0);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);

  // User filters state
  const [userPlanFilter, setUserPlanFilter] = useState<string>('todos');
  const [userOnboardingFilter, setUserOnboardingFilter] = useState<string>('todos');
  const [userGmailFilter, setUserGmailFilter] = useState<string>('todos');
  const [userWebappFilter, setUserWebappFilter] = useState<string>('todos');

  // Check auth
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user || user.email !== ADMIN_EMAIL) {
        router.replace('/dashboard');
        return;
      }
      setAuthorized(true);
      setLoading(false);
    });
  }, [router]);

  // Fetch users
  const fetchUsers = useCallback(async () => {
    const res = await fetch('/api/admin/users');
    if (res.ok) {
      const json = await res.json();
      setUsers(json.usuarios || []);
    }
  }, []);

  // Fetch NLP errors
  const fetchNlpErrors = useCallback(async () => {
    const res = await fetch('/api/admin/nlp-errors?limit=100');
    if (res.ok) {
      const json = await res.json();
      setNlpErrors(json.errors || []);
      setNlpTotal(json.total || 0);
    }
  }, []);

  // Fetch tickets
  const fetchTickets = useCallback(async () => {
    const params = new URLSearchParams({ limit: '50', offset: String(ticketPage * 50) });
    if (ticketEstadoFilter !== 'todos') params.set('estado', ticketEstadoFilter);
    if (ticketSearch) params.set('search', ticketSearch);
    const res = await fetch(`/api/admin/tickets?${params}`);
    if (res.ok) {
      const json = await res.json();
      setTickets(json.tickets || []);
      setTicketsTotal(json.total || 0);
    }
  }, [ticketPage, ticketEstadoFilter, ticketSearch]);

  useEffect(() => {
    if (!authorized) return;
    fetchUsers();
    fetchNlpErrors();
    fetchTickets();
  }, [authorized, fetchUsers, fetchNlpErrors, fetchTickets]);

  // Handle user actions
  const handleUserAction = useCallback(
    async (userId: string, action: string, data?: Record<string, unknown>) => {
      if (action === 'delete') {
        const res = await fetch(`/api/admin/users?id=${userId}`, { method: 'DELETE' });
        if (res.ok) {
          setUsers((prev) => prev.filter((u) => u.id !== userId));
          setToast('Usuario eliminado');
        } else {
          setToast('Error al eliminar');
        }
        return;
      }

      const res = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, action, ...data }),
      });

      if (res.ok) {
        const messages: Record<string, string> = {
          set_plan: data?.plan === 'premium' ? 'Plan Pro activado' : 'Cambiado a Free',
          extend_premium: 'Pro extendido +30 dias',
          deactivate: 'Cuenta desactivada',
        };
        setToast(messages[action] || 'Accion completada');
        fetchUsers();
      } else {
        setToast('Error en la accion');
      }
    },
    [fetchUsers],
  );

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0E0E0C]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#1D9E75] border-t-transparent" />
      </div>
    );
  }

  if (!authorized) return null;

  const filteredUsers = users.filter((u) => {
    if (search) {
      const s = search.toLowerCase();
      const matches =
        (u.nombre && u.nombre.toLowerCase().includes(s)) ||
        (u.email && u.email.toLowerCase().includes(s)) ||
        (u.whatsapp && u.whatsapp.includes(s)) ||
        u.plan.includes(s);
      if (!matches) return false;
    }
    if (userPlanFilter === 'free' && u.plan !== 'free') return false;
    if (userPlanFilter === 'pro' && u.plan !== 'premium') return false;
    if (userOnboardingFilter === 'completado' && !u.onboarding_completado) return false;
    if (userOnboardingFilter === 'pendiente' && u.onboarding_completado) return false;
    if (userGmailFilter === 'conectado' && !u.tiene_gmail) return false;
    if (userGmailFilter === 'no conectado' && u.tiene_gmail) return false;
    if (userWebappFilter === 'conectado' && !u.tiene_webapp) return false;
    if (userWebappFilter === 'no conectado' && u.tiene_webapp) return false;
    return true;
  });

  // CSV export handler
  const handleExportCSV = () => {
    const headers = ['nombre', 'email', 'whatsapp', 'plan', 'estado_pago', 'tiene_gmail', 'tiene_webapp', 'transacciones', 'created_at'];
    const rows = filteredUsers.map((u) => [
      u.nombre || '',
      u.email || '',
      u.whatsapp,
      u.plan,
      u.estado_pago || '',
      u.tiene_gmail ? 'si' : 'no',
      u.tiene_webapp ? 'si' : 'no',
      String(u.transacciones),
      u.created_at,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neto-usuarios-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Ticket reply handler
  const handleTicketReply = async (ticketId: string) => {
    if (!replyText.trim()) return;
    setReplyBusy(true);
    const res = await fetch('/api/admin/tickets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ticketId, action: 'respond', respuesta: replyText.trim() }),
    });
    if (res.ok) {
      setToast('Respuesta enviada');
      setReplyingTo(null);
      setReplyText('');
      fetchTickets();
    } else {
      setToast('Error al responder');
    }
    setReplyBusy(false);
  };

  const handleTicketEstado = async (ticketId: string, estado: string) => {
    const res = await fetch('/api/admin/tickets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ticketId, action: 'set_estado', estado }),
    });
    if (res.ok) {
      setToast(`Estado cambiado a ${estado}`);
      fetchTickets();
    } else {
      setToast('Error al cambiar estado');
    }
  };

  const totalPro = users.filter((u) => u.plan === 'premium').length;
  const totalGmail = users.filter((u) => u.tiene_gmail).length;
  const totalWebapp = users.filter((u) => u.tiene_webapp).length;
  const totalTx = users.reduce((s, u) => s + u.transacciones, 0);

  return (
    <div className="min-h-screen bg-[#0E0E0C] text-[#F0EFE8]">
      {/* Header */}
      <div className="border-b border-white/5 bg-[#0E0E0C]/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-[#1D9E75]">NETO</span>
            <span className="text-sm text-[#F0EFE8]/40">Admin</span>
          </div>
          <a
            href="/dashboard"
            className="text-sm text-[#F0EFE8]/50 hover:text-[#F0EFE8] transition-colors"
          >
            Ir al dashboard
          </a>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* Stats cards */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: 'Usuarios', value: users.length },
            { label: 'Pro', value: totalPro },
            { label: 'Gmail', value: totalGmail },
            { label: 'Webapp', value: totalWebapp },
            { label: 'Transacciones', value: totalTx.toLocaleString() },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-white/5 bg-white/[0.02] p-4"
            >
              <div className="text-xs text-[#F0EFE8]/40">{stat.label}</div>
              <div className="mt-1 text-2xl font-semibold">{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-lg bg-white/[0.03] p-1 w-fit">
          <button
            onClick={() => setTab('users')}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'users'
                ? 'bg-[#1D9E75]/20 text-[#1D9E75]'
                : 'text-[#F0EFE8]/50 hover:text-[#F0EFE8]'
            }`}
          >
            Usuarios ({users.length})
          </button>
          <button
            onClick={() => setTab('nlp')}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'nlp'
                ? 'bg-[#1D9E75]/20 text-[#1D9E75]'
                : 'text-[#F0EFE8]/50 hover:text-[#F0EFE8]'
            }`}
          >
            NLP Errors ({nlpTotal})
          </button>
          <button
            onClick={() => setTab('tickets')}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'tickets'
                ? 'bg-[#1D9E75]/20 text-[#1D9E75]'
                : 'text-[#F0EFE8]/50 hover:text-[#F0EFE8]'
            }`}
          >
            Tickets ({tickets.filter((t) => t.estado === 'pendiente' || t.estado === 'esperando_mensaje').length})
          </button>
        </div>

        {/* Users Tab */}
        {tab === 'users' && (
          <>
            <div className="mb-4 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  placeholder="Buscar por nombre, email o WhatsApp..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full max-w-md rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-[#F0EFE8] placeholder-[#F0EFE8]/30 outline-none focus:border-[#1D9E75]/50"
                />
                <button
                  onClick={handleExportCSV}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-[#F0EFE8]/70 hover:bg-white/5 hover:text-[#F0EFE8] transition-colors"
                >
                  Exportar CSV
                </button>
              </div>
              <div className="flex flex-wrap gap-3">
                <select
                  value={userPlanFilter}
                  onChange={(e) => setUserPlanFilter(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
                >
                  <option value="todos" className="bg-[#1A1A18]">Plan: Todos</option>
                  <option value="free" className="bg-[#1A1A18]">Free</option>
                  <option value="pro" className="bg-[#1A1A18]">Pro</option>
                </select>
                <select
                  value={userOnboardingFilter}
                  onChange={(e) => setUserOnboardingFilter(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
                >
                  <option value="todos" className="bg-[#1A1A18]">Onboarding: Todos</option>
                  <option value="completado" className="bg-[#1A1A18]">Completado</option>
                  <option value="pendiente" className="bg-[#1A1A18]">Pendiente</option>
                </select>
                <select
                  value={userGmailFilter}
                  onChange={(e) => setUserGmailFilter(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
                >
                  <option value="todos" className="bg-[#1A1A18]">Gmail: Todos</option>
                  <option value="conectado" className="bg-[#1A1A18]">Conectado</option>
                  <option value="no conectado" className="bg-[#1A1A18]">No conectado</option>
                </select>
                <select
                  value={userWebappFilter}
                  onChange={(e) => setUserWebappFilter(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
                >
                  <option value="todos" className="bg-[#1A1A18]">Webapp: Todos</option>
                  <option value="conectado" className="bg-[#1A1A18]">Conectado</option>
                  <option value="no conectado" className="bg-[#1A1A18]">No conectado</option>
                </select>
                {(userPlanFilter !== 'todos' || userOnboardingFilter !== 'todos' || userGmailFilter !== 'todos' || userWebappFilter !== 'todos') && (
                  <button
                    onClick={() => { setUserPlanFilter('todos'); setUserOnboardingFilter('todos'); setUserGmailFilter('todos'); setUserWebappFilter('todos'); }}
                    className="rounded-lg border border-white/10 px-3 py-2 text-xs text-[#F0EFE8]/50 hover:bg-white/5 hover:text-[#F0EFE8]"
                  >
                    Limpiar filtros
                  </button>
                )}
              </div>
              <div className="text-xs text-[#F0EFE8]/40">
                {filteredUsers.length} de {users.length} usuarios
              </div>
            </div>

            {/* Desktop table */}
            <div className="hidden overflow-x-auto rounded-xl border border-white/5 md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5 bg-white/[0.02]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">
                      Usuario
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">
                      WhatsApp
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">
                      Plan
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">
                      Pago
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-[#F0EFE8]/40">
                      Gmail
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-[#F0EFE8]/40">
                      Webapp
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[#F0EFE8]/40">
                      Txs
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">
                      Registro
                    </th>
                    <th className="w-10 px-2 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {filteredUsers.map((u) => (
                    <tr key={u.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium">{u.nombre || 'Sin nombre'}</div>
                        <div className="text-xs text-[#F0EFE8]/40">{u.email || '\u2014'}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{u.whatsapp}</td>
                      <td className="px-4 py-3">
                        <PlanBadge plan={u.plan} />
                      </td>
                      <td className="px-4 py-3 text-xs text-[#F0EFE8]/50">
                        {u.plan === 'premium' ? (
                          <div>
                            <div>{u.estado_pago || '\u2014'}</div>
                            {u.premium_vence && (
                              <div className="text-[#F0EFE8]/30">
                                Vence: {formatDate(u.premium_vence)}
                              </div>
                            )}
                          </div>
                        ) : (
                          '\u2014'
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <StatusDot active={u.tiene_gmail} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <StatusDot active={u.tiene_webapp} />
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {u.transacciones}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#F0EFE8]/40">
                        {formatDate(u.created_at)}
                      </td>
                      <td className="px-2 py-3">
                        <UserActions user={u} onAction={handleUserAction} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {filteredUsers.map((u) => (
                <div
                  key={u.id}
                  className="rounded-xl border border-white/5 bg-white/[0.02] p-4"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium">{u.nombre || 'Sin nombre'}</div>
                      <div className="text-xs text-[#F0EFE8]/40">{u.email || '\u2014'}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <PlanBadge plan={u.plan} />
                      <UserActions user={u} onAction={handleUserAction} />
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-[#F0EFE8]/40">WhatsApp:</span>{' '}
                      <span className="font-mono">{u.whatsapp}</span>
                    </div>
                    <div>
                      <span className="text-[#F0EFE8]/40">Txs:</span> {u.transacciones}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <StatusDot active={u.tiene_gmail} />
                      <span className="text-[#F0EFE8]/40">Gmail</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <StatusDot active={u.tiene_webapp} />
                      <span className="text-[#F0EFE8]/40">Webapp</span>
                    </div>
                    {u.plan === 'premium' && u.premium_vence && (
                      <div className="col-span-2">
                        <span className="text-[#F0EFE8]/40">Vence:</span>{' '}
                        {formatDate(u.premium_vence)}
                      </div>
                    )}
                    <div className="col-span-2 text-[#F0EFE8]/30">
                      Registro: {formatDate(u.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* NLP Errors Tab */}
        {tab === 'nlp' && (() => {
          // Derive unique types and users for filters
          const tiposUnicos = [...new Set(nlpErrors.map((e) => e.error_tipo))];
          const usersUnicos = [...new Set(nlpErrors.filter((e) => e.whatsapp).map((e) => e.whatsapp!))];

          // Map whatsapp to user name for display
          const whatsappToName: Record<string, string> = {};
          for (const u of users) {
            if (u.whatsapp) whatsappToName[u.whatsapp] = u.nombre || u.whatsapp;
          }

          const filtered = nlpErrors.filter((err) => {
            if (nlpTipoFilter !== 'all' && err.error_tipo !== nlpTipoFilter) return false;
            if (nlpUserFilter !== 'all' && err.whatsapp !== nlpUserFilter) return false;
            if (nlpSearch) {
              const s = nlpSearch.toLowerCase();
              const matchMsg = err.mensaje.toLowerCase().includes(s);
              const matchIntent = err.intencion?.toLowerCase().includes(s);
              const matchDetail = err.error_detalle?.toLowerCase().includes(s);
              const matchWhatsapp = err.whatsapp?.includes(s);
              if (!matchMsg && !matchIntent && !matchDetail && !matchWhatsapp) return false;
            }
            return true;
          });

          return (
            <div className="space-y-4">
              {/* Filters */}
              <div className="flex flex-wrap gap-3">
                <input
                  type="text"
                  placeholder="Buscar en mensajes..."
                  value={nlpSearch}
                  onChange={(e) => setNlpSearch(e.target.value)}
                  className="w-full max-w-xs rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-[#F0EFE8] placeholder-[#F0EFE8]/30 outline-none focus:border-[#1D9E75]/50"
                />
                <select
                  value={nlpTipoFilter}
                  onChange={(e) => setNlpTipoFilter(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
                >
                  <option value="all" className="bg-[#1A1A18]">Todos los tipos</option>
                  {tiposUnicos.map((t) => (
                    <option key={t} value={t} className="bg-[#1A1A18]">{t}</option>
                  ))}
                </select>
                <select
                  value={nlpUserFilter}
                  onChange={(e) => setNlpUserFilter(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
                >
                  <option value="all" className="bg-[#1A1A18]">Todos los usuarios</option>
                  {usersUnicos.map((w) => (
                    <option key={w} value={w} className="bg-[#1A1A18]">{whatsappToName[w] || w}</option>
                  ))}
                </select>
                {(nlpSearch || nlpTipoFilter !== 'all' || nlpUserFilter !== 'all') && (
                  <button
                    onClick={() => { setNlpSearch(''); setNlpTipoFilter('all'); setNlpUserFilter('all'); }}
                    className="rounded-lg border border-white/10 px-3 py-2 text-xs text-[#F0EFE8]/50 hover:bg-white/5 hover:text-[#F0EFE8]"
                  >
                    Limpiar filtros
                  </button>
                )}
              </div>

              {/* Count */}
              <div className="text-xs text-[#F0EFE8]/40">
                {filtered.length} de {nlpErrors.length} errores
              </div>

              {/* Error list */}
              {filtered.length === 0 ? (
                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center text-[#F0EFE8]/40">
                  {nlpErrors.length === 0
                    ? 'No hay errores NLP registrados aun.'
                    : 'Ningun error coincide con los filtros.'}
                  <br />
                  <span className="text-xs">
                    Los mensajes no procesados apareceran aqui cuando ocurran.
                  </span>
                </div>
              ) : (
                filtered.map((err) => (
                  <div
                    key={err.id}
                    className="rounded-xl border border-white/5 bg-white/[0.02] p-4"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-sm">
                          &ldquo;{err.mensaje}&rdquo;
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          <span
                            className={`rounded-full px-2 py-0.5 ${
                              err.error_tipo === 'error'
                                ? 'bg-red-500/10 text-red-400'
                                : 'bg-amber-500/10 text-amber-400'
                            }`}
                          >
                            {err.error_tipo}
                          </span>
                          {err.intencion && (
                            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[#F0EFE8]/50">
                              Intento: {err.intencion}
                            </span>
                          )}
                          {err.whatsapp && (
                            <button
                              onClick={() => setNlpUserFilter(err.whatsapp!)}
                              className="font-mono text-[#F0EFE8]/30 hover:text-[#1D9E75] transition-colors"
                              title="Filtrar por este usuario"
                            >
                              {whatsappToName[err.whatsapp] || err.whatsapp}
                            </button>
                          )}
                        </div>
                        {err.error_detalle && (
                          <div className="mt-1 text-xs text-[#F0EFE8]/30">
                            {err.error_detalle}
                          </div>
                        )}
                      </div>
                      <div className="ml-3 whitespace-nowrap text-xs text-[#F0EFE8]/30">
                        {formatDateTime(err.created_at)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          );
        })()}

        {/* Tickets Tab */}
        {tab === 'tickets' && (() => {
          const ticketsPendientes = tickets.filter((t) => t.estado === 'pendiente' || t.estado === 'esperando_mensaje').length;
          const totalPages = Math.ceil(ticketsTotal / 50);

          const estadoBadge = (estado: string) => {
            const styles: Record<string, string> = {
              esperando_mensaje: 'bg-yellow-500/10 text-yellow-400',
              pendiente: 'bg-orange-500/10 text-orange-400',
              respondido: 'bg-[#1D9E75]/10 text-[#1D9E75]',
              cerrado: 'bg-white/5 text-[#F0EFE8]/40',
            };
            const labels: Record<string, string> = {
              esperando_mensaje: 'Esperando',
              pendiente: 'Pendiente',
              respondido: 'Respondido',
              cerrado: 'Cerrado',
            };
            return (
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[estado] || 'bg-white/5 text-[#F0EFE8]/40'}`}>
                {labels[estado] || estado}
              </span>
            );
          };

          // Map whatsapp to user name
          const whatsappToName: Record<string, string> = {};
          for (const u of users) {
            if (u.whatsapp) whatsappToName[u.whatsapp] = u.nombre || u.whatsapp;
          }

          return (
            <div className="space-y-4">
              {/* Filters */}
              <div className="flex flex-wrap gap-3">
                <input
                  type="text"
                  placeholder="Buscar en mensajes o WhatsApp..."
                  value={ticketSearch}
                  onChange={(e) => { setTicketSearch(e.target.value); setTicketPage(0); }}
                  className="w-full max-w-xs rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-[#F0EFE8] placeholder-[#F0EFE8]/30 outline-none focus:border-[#1D9E75]/50"
                />
                <select
                  value={ticketEstadoFilter}
                  onChange={(e) => { setTicketEstadoFilter(e.target.value); setTicketPage(0); }}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
                >
                  <option value="todos" className="bg-[#1A1A18]">Todos los estados</option>
                  <option value="esperando_mensaje" className="bg-[#1A1A18]">Esperando mensaje</option>
                  <option value="pendiente" className="bg-[#1A1A18]">Pendiente</option>
                  <option value="respondido" className="bg-[#1A1A18]">Respondido</option>
                  <option value="cerrado" className="bg-[#1A1A18]">Cerrado</option>
                </select>
                {(ticketSearch || ticketEstadoFilter !== 'todos') && (
                  <button
                    onClick={() => { setTicketSearch(''); setTicketEstadoFilter('todos'); setTicketPage(0); }}
                    className="rounded-lg border border-white/10 px-3 py-2 text-xs text-[#F0EFE8]/50 hover:bg-white/5 hover:text-[#F0EFE8]"
                  >
                    Limpiar filtros
                  </button>
                )}
              </div>

              {/* Count */}
              <div className="text-xs text-[#F0EFE8]/40">
                {ticketsTotal} tickets total{ticketsPendientes > 0 && ` (${ticketsPendientes} pendientes)`}
              </div>

              {/* Tickets list */}
              {tickets.length === 0 ? (
                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center text-[#F0EFE8]/40">
                  No hay tickets de soporte.
                </div>
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="hidden overflow-x-auto rounded-xl border border-white/5 md:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/5 bg-white/[0.02]">
                          <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Usuario</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">WhatsApp</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Mensaje</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Estado</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Fecha</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {tickets.map((t) => (
                          <tr key={t.id} className="hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-3 text-sm">
                              {t.whatsapp ? (whatsappToName[t.whatsapp] || 'Sin nombre') : '\u2014'}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs">{t.whatsapp || '\u2014'}</td>
                            <td className="max-w-xs px-4 py-3">
                              <div className="truncate text-sm">{t.mensaje}</div>
                              {t.respuesta_admin && (
                                <div className="mt-1 truncate text-xs text-[#1D9E75]/70">
                                  Respuesta: {t.respuesta_admin}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">{estadoBadge(t.estado)}</td>
                            <td className="px-4 py-3 text-xs text-[#F0EFE8]/40 whitespace-nowrap">
                              {formatDateTime(t.created_at)}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                {t.estado !== 'cerrado' && (
                                  <button
                                    onClick={() => { setReplyingTo(replyingTo === t.id ? null : t.id); setReplyText(''); }}
                                    className="rounded-md px-2 py-1 text-xs text-[#1D9E75] hover:bg-[#1D9E75]/10 transition-colors"
                                  >
                                    Responder
                                  </button>
                                )}
                                {t.estado !== 'cerrado' && (
                                  <button
                                    onClick={() => handleTicketEstado(t.id, 'cerrado')}
                                    className="rounded-md px-2 py-1 text-xs text-[#F0EFE8]/40 hover:bg-white/5 transition-colors"
                                  >
                                    Cerrar
                                  </button>
                                )}
                              </div>
                              {replyingTo === t.id && (
                                <div className="mt-2 flex gap-2">
                                  <input
                                    type="text"
                                    value={replyText}
                                    onChange={(e) => setReplyText(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') handleTicketReply(t.id); }}
                                    placeholder="Escribir respuesta..."
                                    className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-[#F0EFE8] placeholder-[#F0EFE8]/30 outline-none focus:border-[#1D9E75]/50"
                                    autoFocus
                                  />
                                  <button
                                    onClick={() => handleTicketReply(t.id)}
                                    disabled={replyBusy || !replyText.trim()}
                                    className="rounded-lg bg-[#1D9E75] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1D9E75]/80 disabled:opacity-50 transition-colors"
                                  >
                                    {replyBusy ? '...' : 'Enviar'}
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile cards */}
                  <div className="space-y-3 md:hidden">
                    {tickets.map((t) => (
                      <div key={t.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="text-sm font-medium">{t.whatsapp ? (whatsappToName[t.whatsapp] || t.whatsapp) : 'Sin usuario'}</div>
                            <div className="mt-1 text-sm text-[#F0EFE8]/70">{t.mensaje}</div>
                            {t.respuesta_admin && (
                              <div className="mt-1 text-xs text-[#1D9E75]/70">Respuesta: {t.respuesta_admin}</div>
                            )}
                          </div>
                          <div className="ml-2">{estadoBadge(t.estado)}</div>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-xs text-[#F0EFE8]/30">
                          <span>{formatDateTime(t.created_at)}</span>
                          <div className="flex gap-2">
                            {t.estado !== 'cerrado' && (
                              <button
                                onClick={() => { setReplyingTo(replyingTo === t.id ? null : t.id); setReplyText(''); }}
                                className="text-[#1D9E75] hover:text-[#1D9E75]/80"
                              >
                                Responder
                              </button>
                            )}
                            {t.estado !== 'cerrado' && (
                              <button
                                onClick={() => handleTicketEstado(t.id, 'cerrado')}
                                className="text-[#F0EFE8]/40 hover:text-[#F0EFE8]"
                              >
                                Cerrar
                              </button>
                            )}
                          </div>
                        </div>
                        {replyingTo === t.id && (
                          <div className="mt-2 flex gap-2">
                            <input
                              type="text"
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') handleTicketReply(t.id); }}
                              placeholder="Escribir respuesta..."
                              className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-[#F0EFE8] placeholder-[#F0EFE8]/30 outline-none focus:border-[#1D9E75]/50"
                              autoFocus
                            />
                            <button
                              onClick={() => handleTicketReply(t.id)}
                              disabled={replyBusy || !replyText.trim()}
                              className="rounded-lg bg-[#1D9E75] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1D9E75]/80 disabled:opacity-50"
                            >
                              {replyBusy ? '...' : 'Enviar'}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 pt-2">
                      <button
                        onClick={() => setTicketPage(Math.max(0, ticketPage - 1))}
                        disabled={ticketPage === 0}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-[#F0EFE8]/50 hover:bg-white/5 disabled:opacity-30"
                      >
                        Anterior
                      </button>
                      <span className="text-xs text-[#F0EFE8]/40">
                        Pagina {ticketPage + 1} de {totalPages}
                      </span>
                      <button
                        onClick={() => setTicketPage(Math.min(totalPages - 1, ticketPage + 1))}
                        disabled={ticketPage >= totalPages - 1}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-[#F0EFE8]/50 hover:bg-white/5 disabled:opacity-30"
                      >
                        Siguiente
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}
      </div>

      {/* Toast */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
