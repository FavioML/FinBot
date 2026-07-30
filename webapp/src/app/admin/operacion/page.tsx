'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAdminStats,
  useAdminUsers,
  useAdminNlpErrors,
  useAdminTickets,
  type AdminUser,
} from '@/lib/hooks/use-admin-operacion';

interface Pago {
  id: string;
  monto: number | null;
  moneda: string | null;
  tipo_plan: string | null;
  metodo_pago: string | null;
  estado: string;
  origen: string | null;
  comprobante_signed_url: string | null;
  monto_detectado: number | null;
  premium_desde: string | null;
  premium_vence: string | null;
  detectado_at: string | null;
  aprobado_at: string | null;
  created_at: string;
}

function hasTimezone(s: string) {
  return /Z$|[+-]\d{2}:?\d{2}$/.test(s);
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  const d = new Date(hasTimezone(dateStr) ? dateStr : dateStr + 'Z');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'America/Lima',
  });
}

function formatDateTime(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  const d = new Date(hasTimezone(dateStr) ? dateStr : dateStr + 'Z');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Lima',
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

function CanalBadge({ canal }: { canal: 'whatsapp' | 'google' | 'magic_link' }) {
  const styles = {
    whatsapp: 'bg-[#25D366]/15 text-[#25D366]',
    google: 'bg-[#4285F4]/15 text-[#7AAFFF]',
    magic_link: 'bg-[#6366F1]/15 text-[#818CF8]',
  };
  const labels = {
    whatsapp: 'WhatsApp',
    google: 'Google',
    magic_link: 'Magic Link',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[canal]}`}>
      {labels[canal]}
    </span>
  );
}

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

          {!confirming && (
            <div className="py-1">
              <button
                onClick={() => exec('view_payments')}
                disabled={busy}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-[#F0EFE8]/80 hover:bg-white/5"
              >
                <span className="text-[#F0EFE8]/40">&#128179;</span> Ver pagos / comprobante
                {user.pago_pendiente && <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">pendiente</span>}
              </button>

              <div className="my-1 border-t border-white/5" />

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
                    onClick={() => exec('notify_pro', { tipo_plan: user.tipo_plan || 'mensual' })}
                    disabled={busy}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-[#F0EFE8]/80 hover:bg-white/5"
                  >
                    <span className="text-[#25D366]">&#128172;</span> Notificar Pro por WhatsApp
                  </button>
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

              <button
                onClick={() => setConfirming('deactivate')}
                disabled={busy}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-amber-400/80 hover:bg-white/5"
              >
                <span>&#9888;</span> Desactivar cuenta
              </button>

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

function PagoEstadoBadge({ estado }: { estado: string }) {
  const styles: Record<string, string> = {
    aprobado: 'bg-[#1D9E75]/20 text-[#1D9E75]',
    pendiente: 'bg-amber-500/15 text-amber-400',
    rechazado: 'bg-red-500/15 text-red-400',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[estado] || 'bg-white/5 text-[#F0EFE8]/50'}`}>
      {estado}
    </span>
  );
}

function PaymentsModal({
  user,
  onClose,
  onApproved,
  setToast,
}: {
  user: AdminUser;
  onClose: () => void;
  onApproved: () => void;
  setToast: (m: string) => void;
}) {
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [planSel, setPlanSel] = useState<string>(user.tipo_plan || 'mensual');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/admin/payments?user_id=${user.id}`);
      if (res.ok) {
        const json = await res.json();
        setPagos(json.pagos || []);
      } else {
        const json = await res.json().catch(() => ({}));
        setToast(json.error || 'Error cargando pagos');
      }
      setLoading(false);
    })();
  }, [user.id, setToast]);

  const hasPending = user.pago_pendiente || pagos.some((p) => p.estado === 'pendiente');

  const approve = async () => {
    setBusy(true);
    const res = await fetch('/api/admin/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.id, tipo_plan: planSel }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && json.ok) {
      setToast('Pro activado y usuario notificado por WhatsApp');
      onApproved();
      onClose();
    } else {
      setToast(json.error || 'Error aprobando pago');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-[#1A1A18] p-5 shadow-xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-[#F0EFE8]">Pagos de {user.nombre || user.whatsapp}</h3>
            <p className="text-xs text-[#F0EFE8]/40">
              {user.plan === 'premium'
                ? `Pro · vence ${formatDate(user.premium_vence)}`
                : 'Free'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-[#F0EFE8]/40 hover:bg-white/5 hover:text-[#F0EFE8]">
            &#10005;
          </button>
        </div>

        {hasPending && (
          <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3">
            <div className="mb-2 text-sm font-medium text-amber-300">Pago pendiente de aprobación</div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={planSel}
                onChange={(e) => setPlanSel(e.target.value)}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
              >
                <option value="mensual" className="bg-[#1A1A18]">Mensual (S/10)</option>
                <option value="anual" className="bg-[#1A1A18]">Anual (S/99)</option>
              </select>
              <button
                onClick={approve}
                disabled={busy}
                className="rounded-lg bg-[#1D9E75] px-4 py-2 text-sm font-medium text-white hover:bg-[#1D9E75]/80 disabled:opacity-50"
              >
                {busy ? 'Activando...' : 'Aprobar y notificar'}
              </button>
            </div>
            <p className="mt-2 text-xs text-[#F0EFE8]/40">Activa Pro y le manda el WhatsApp de confirmación + link de Gmail.</p>
          </div>
        )}

        {loading ? (
          <div className="py-8 text-center text-sm text-[#F0EFE8]/40">Cargando...</div>
        ) : pagos.length === 0 ? (
          <div className="py-8 text-center text-sm text-[#F0EFE8]/40">Sin pagos registrados todavía.</div>
        ) : (
          <div className="space-y-3">
            {pagos.map((p) => (
              <div key={p.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PagoEstadoBadge estado={p.estado} />
                    <span className="text-sm font-medium">
                      {p.monto != null ? `S/ ${Number(p.monto).toFixed(2)}` : '—'}
                    </span>
                    <span className="text-xs text-[#F0EFE8]/40">{p.tipo_plan || '—'} · {p.metodo_pago || '—'}</span>
                    {p.origen && (
                      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${p.origen === 'webapp' ? 'bg-[#1D9E75]/15 text-[#1D9E75]' : 'bg-[#EF9F27]/15 text-[#EF9F27]'}`}>
                        {p.origen === 'webapp' ? 'webapp' : 'whatsapp'}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-[#F0EFE8]/30">{formatDateTime(p.created_at)}</span>
                </div>
                {(p.premium_desde || p.premium_vence) && (
                  <div className="mt-1 text-xs text-[#F0EFE8]/40">
                    {p.premium_desde ? `Desde ${formatDate(p.premium_desde)}` : ''}
                    {p.premium_vence ? ` · Vence ${formatDate(p.premium_vence)}` : ''}
                  </div>
                )}
                {p.comprobante_signed_url ? (
                  <a
                    href={p.comprobante_signed_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.comprobante_signed_url}
                      alt="Comprobante de pago"
                      className="max-h-40 rounded-lg border border-white/10 object-contain"
                    />
                  </a>
                ) : (
                  <div className="mt-2 text-xs text-[#F0EFE8]/30">Sin comprobante adjunto</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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

function OperacionKpiSkeleton() {
  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-5 w-16" />
          </div>
        ))}
      </div>
    </>
  );
}

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export default function AdminOperacionPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'users' | 'nlp' | 'tickets'>('users');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [paymentsUser, setPaymentsUser] = useState<AdminUser | null>(null);
  const [nlpSearch, setNlpSearch] = useState('');
  const [nlpTipoFilter, setNlpTipoFilter] = useState<string>('all');
  const [nlpUserFilter, setNlpUserFilter] = useState<string>('all');

  const [ticketEstadoFilter, setTicketEstadoFilter] = useState<string>('todos');
  const [ticketSearch, setTicketSearch] = useState('');
  const [ticketPage, setTicketPage] = useState(0);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);

  const [userPlanFilter, setUserPlanFilter] = useState<string>('todos');
  const [userOnboardingFilter, setUserOnboardingFilter] = useState<string>('todos');
  const [userGmailFilter, setUserGmailFilter] = useState<string>('todos');
  const [userWebappFilter, setUserWebappFilter] = useState<string>('todos');
  const [userCanalFilter, setUserCanalFilter] = useState<string>('todos');

  // Data via React Query (cache compartido del AdminQueryProvider): sobrevive a la navegación,
  // sin re-fetch en cada visita. Las mutaciones invalidan keys puntuales en vez de refetchear a
  // mano. Ver use-admin-operacion.ts.
  const usersQuery = useAdminUsers();
  const statsQuery = useAdminStats();
  const nlpQuery = useAdminNlpErrors();
  const ticketsQuery = useAdminTickets({
    page: ticketPage,
    estado: ticketEstadoFilter,
    search: ticketSearch,
  });

  // useMemo: `users` alimenta las deps de handleUserAction (useCallback); sin ref estable se
  // recrearía en cada render.
  const users = useMemo(() => usersQuery.data?.usuarios ?? [], [usersQuery.data?.usuarios]);
  const stats = statsQuery.data ?? null;
  const nlpErrors = nlpQuery.data?.errors ?? [];
  const nlpTotal = nlpQuery.data?.total ?? 0;
  const nlpRateLimit = nlpQuery.data?.rateLimitTotal ?? 0;
  const tickets = ticketsQuery.data?.tickets ?? [];
  const ticketsTotal = ticketsQuery.data?.total ?? 0;

  const handleUserAction = useCallback(
    async (userId: string, action: string, data?: Record<string, unknown>) => {
      if (action === 'view_payments') {
        const u = users.find((x) => x.id === userId);
        if (u) setPaymentsUser(u);
        return;
      }

      if (action === 'notify_pro') {
        const res = await fetch('/api/admin/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, tipo_plan: data?.tipo_plan || 'mensual' }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.ok) {
          setToast('Pro confirmado y WhatsApp enviado');
          queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
        } else {
          setToast(json.error || 'Error notificando');
        }
        return;
      }

      if (action === 'delete') {
        const doDelete = async (force: boolean) =>
          fetch(`/api/admin/users?id=${userId}${force ? '&force=1' : ''}`, { method: 'DELETE' });

        let res = await doDelete(false);
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          // Pagador protegido: pedir confirmación y reintentar forzado.
          if (res.status === 409 && json.requiresForce) {
            const u = users.find((x) => x.id === userId);
            if (!window.confirm(`${u?.nombre || u?.whatsapp || 'Este usuario'} tiene un pago aprobado. ¿Borrarlo igual? Se pierde su historial de pagos.`)) {
              return;
            }
            res = await doDelete(true);
          } else {
            setToast(json.message || json.error || 'Error al eliminar');
            return;
          }
        }
        if (res.ok) {
          queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
          setToast('Usuario eliminado');
        } else {
          const json = await res.json().catch(() => ({}));
          setToast(json.message || json.error || 'Error al eliminar');
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
        queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      } else {
        setToast('Error en la accion');
      }
    },
    [queryClient, users],
  );

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
    if (userCanalFilter !== 'todos' && u.canal !== userCanalFilter) return false;
    return true;
  });

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
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neto-usuarios-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
      queryClient.invalidateQueries({ queryKey: ['admin', 'tickets'] });
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
      queryClient.invalidateQueries({ queryKey: ['admin', 'tickets'] });
    } else {
      setToast('Error al cambiar estado');
    }
  };

  const totalPro = users.filter((u) => u.plan === 'premium').length;
  const totalWebapp = users.filter((u) => u.tiene_webapp).length;
  const totalTx = users.reduce((s, u) => s + u.transacciones, 0);

  return (
    <>
      {statsQuery.isLoading ? (
        <OperacionKpiSkeleton />
      ) : (
        <>
      {/* KPI Cards — Row 1: Core metrics */}
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#F0EFE8]/40">MRR</span>
            <span className="text-[10px] text-[#F0EFE8]/30" title="Ingreso anual recurrente">
              ARR S/{(stats?.kpis.arr ?? 0).toLocaleString('es-PE')}
            </span>
          </div>
          <div className="mt-1 text-2xl font-semibold text-[#1D9E75]">
            S/{stats?.kpis.mrr ?? '—'}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-[#F0EFE8]/30">
            <span>{stats?.kpis.proReal ?? totalPro} Pro</span>
            <span className="text-[#F0EFE8]/20">·</span>
            <span>{stats?.kpis.proYearly ?? 0} anual</span>
            <span>{stats?.kpis.proMonthly ?? 0} mensual</span>
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="text-xs text-[#F0EFE8]/40">Caja del mes</div>
          <div className="mt-1 text-2xl font-semibold text-[#F0EFE8]">
            S/{stats?.kpis.cajaMes ?? '—'}
          </div>
          <div className="mt-0.5 text-xs text-[#F0EFE8]/30">
            Conversion {stats?.kpis.conversionRate ?? 0}% · {stats?.kpis.proReal ?? totalPro} de {(users.length)}
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="text-xs text-[#F0EFE8]/40">Usuarios Activos</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold">{stats?.kpis.mau ?? '—'}</span>
            <span className="text-xs text-[#F0EFE8]/40">MAU</span>
          </div>
          <div className="mt-0.5 flex gap-3 text-xs text-[#F0EFE8]/30">
            <span>WAU: {stats?.kpis.wau ?? '—'}</span>
            <span>DAU: {stats?.kpis.dau ?? '—'}</span>
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="text-xs text-[#F0EFE8]/40">Txs / Usuario Activo</div>
          <div className="mt-1 text-2xl font-semibold">{stats?.kpis.txPerActiveUser ?? '—'}</div>
          <div className="mt-0.5 text-xs text-[#F0EFE8]/30">{totalTx.toLocaleString()} txs total</div>
        </div>
      </div>

      {/* KPI Cards — Row 2: Secondary metrics */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <div className="text-xs text-[#F0EFE8]/40">Churn Rate</div>
          <div className={`mt-1 text-lg font-semibold ${(stats?.kpis.churnRate ?? 0) > 10 ? 'text-[#E85D3A]' : 'text-[#F0EFE8]'}`}>
            {stats?.kpis.churnRate ?? '—'}%
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <div className="text-xs text-[#F0EFE8]/40">Avg 1a Transaccion</div>
          <div className="mt-1 text-lg font-semibold">
            {stats?.kpis.avgTimeToFirstTx ?? '—'} <span className="text-xs font-normal text-[#F0EFE8]/40">dias</span>
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <div className="text-xs text-[#F0EFE8]/40">Canales Webapp</div>
          <div className="mt-1 text-lg font-semibold">{totalWebapp}</div>
          <div className="flex gap-2 text-xs text-[#F0EFE8]/30">
            <span>Google: {users.filter(u => u.canal === 'google').length}</span>
            <span>ML: {users.filter(u => u.canal === 'magic_link').length}</span>
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <div className="text-xs text-[#F0EFE8]/40">Total Usuarios</div>
          <div className="mt-1 text-lg font-semibold">{users.length}</div>
          <div className="text-xs text-[#F0EFE8]/30">Onboarding: {stats?.funnel.onboardingComplete ?? '—'}</div>
        </div>
      </div>

      {/* Charts Section */}
      {stats && (
        <div className="mb-6 grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <h3 className="mb-3 text-sm font-medium text-[#F0EFE8]/60">Crecimiento Usuarios (12 semanas)</h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.userGrowth} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="gradFree" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#F0EFE8" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#F0EFE8" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradPro" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1D9E75" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#1D9E75" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="week" tick={{ fill: '#F0EFE840', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#F0EFE840', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#1A1A17', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#F0EFE8' }}
                  />
                  <Area type="monotone" dataKey="free" stackId="1" stroke="#F0EFE860" fill="url(#gradFree)" name="Free" />
                  <Area type="monotone" dataKey="pro" stackId="1" stroke="#1D9E75" fill="url(#gradPro)" name="Pro" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <h3 className="mb-3 text-sm font-medium text-[#F0EFE8]/60">Embudo de Onboarding</h3>
            <div className="space-y-2.5">
              {[
                { label: 'Registrados', value: stats.funnel.registered, color: '#F0EFE8' },
                { label: 'Onboarding OK', value: stats.funnel.onboardingComplete, color: '#E8A838' },
                { label: '1a Transaccion', value: stats.funnel.firstTransaction, color: '#D85A30' },
                { label: 'Pro', value: stats.funnel.pro, color: '#1D9E75' },
              ].map((step) => {
                const pct = stats.funnel.registered > 0 ? Math.round((step.value / stats.funnel.registered) * 100) : 0;
                return (
                  <div key={step.label}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-[#F0EFE8]/60">{step.label}</span>
                      <span className="font-mono text-[#F0EFE8]/80">{step.value} <span className="text-[#F0EFE8]/30">({pct}%)</span></span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${pct}%`, backgroundColor: step.color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Webapp: métrica transversal (no downstream de 1a tx), fuera del embudo. */}
            <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-3 text-xs">
              <span className="text-[#F0EFE8]/40">Cobertura webapp (Google + ML)</span>
              <span className="font-mono text-[#818CF8]">
                {stats.webappCoverage}
                <span className="text-[#F0EFE8]/30">
                  {' '}({stats.funnel.registered > 0 ? Math.round((stats.webappCoverage / stats.funnel.registered) * 100) : 0}%)
                </span>
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <h3 className="mb-3 text-sm font-medium text-[#F0EFE8]/60">Errores NLP (30 dias)</h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats.nlpActivity} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: '#F0EFE840', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    interval={6}
                  />
                  <YAxis tick={{ fill: '#F0EFE840', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#1A1A17', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#F0EFE8' }}
                  />
                  <Line type="monotone" dataKey="errors" stroke="#E85D3A" strokeWidth={1.5} dot={false} name="Errores" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
        </>
      )}

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
              <select
                value={userCanalFilter}
                onChange={(e) => setUserCanalFilter(e.target.value)}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]/50"
              >
                <option value="todos" className="bg-[#1A1A18]">Canal: Todos</option>
                <option value="whatsapp" className="bg-[#1A1A18]">Solo WhatsApp</option>
                <option value="google" className="bg-[#1A1A18]">Google OAuth</option>
                <option value="magic_link" className="bg-[#1A1A18]">Magic Link</option>
              </select>
              {(userPlanFilter !== 'todos' || userOnboardingFilter !== 'todos' || userGmailFilter !== 'todos' || userWebappFilter !== 'todos' || userCanalFilter !== 'todos') && (
                <button
                  onClick={() => { setUserPlanFilter('todos'); setUserOnboardingFilter('todos'); setUserGmailFilter('todos'); setUserWebappFilter('todos'); setUserCanalFilter('todos'); }}
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
                  <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Usuario</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">WhatsApp</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Plan</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Pago</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-[#F0EFE8]/40">Gmail</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-[#F0EFE8]/40">Webapp</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[#F0EFE8]/40">Txs</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Canal</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[#F0EFE8]/40">Registro</th>
                  <th className="w-10 px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {usersQuery.isLoading && users.length === 0 &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={`sk-${i}`}>
                      <td colSpan={10} className="px-4 py-3">
                        <Skeleton className="h-8 w-full" />
                      </td>
                    </tr>
                  ))}
                {filteredUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium">{u.nombre || 'Sin nombre'}</div>
                      <div className="text-xs text-[#F0EFE8]/40">{u.email || '—'}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{u.whatsapp}</td>
                    <td className="px-4 py-3">
                      <PlanBadge plan={u.plan} />
                      {u.plan === 'premium' && (
                        <div className="mt-1 text-[10px] uppercase tracking-wide text-[#F0EFE8]/40">
                          {u.tipo_plan === 'anual' ? 'Anual' : 'Mensual'}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#F0EFE8]/50">
                      {u.plan === 'premium' ? (
                        <div>
                          <div>{u.fecha_pago ? `Pagó ${formatDate(u.fecha_pago)}` : (u.estado_pago || '—')}</div>
                          {u.premium_vence && (() => {
                            const daysLeft = Math.ceil((new Date(u.premium_vence).getTime() - Date.now()) / 86400000);
                            return (
                              <div className={daysLeft <= 7 ? 'text-[#E85D3A] font-medium' : 'text-[#F0EFE8]/30'}>
                                {daysLeft <= 0 ? 'Vencido' : daysLeft <= 7 ? `Vence en ${daysLeft}d` : `Vence: ${formatDate(u.premium_vence)}`}
                              </div>
                            );
                          })()}
                        </div>
                      ) : u.pago_pendiente ? (
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-400">Pendiente</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-center"><StatusDot active={u.tiene_gmail} /></td>
                    <td className="px-4 py-3 text-center"><StatusDot active={u.tiene_webapp} /></td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{u.transacciones}</td>
                    <td className="px-4 py-3"><CanalBadge canal={u.canal} /></td>
                    <td className="px-4 py-3 text-xs text-[#F0EFE8]/40">{formatDateTime(u.created_at)}</td>
                    <td className="px-2 py-3"><UserActions user={u} onAction={handleUserAction} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {usersQuery.isLoading && users.length === 0 && <ListSkeleton rows={4} />}
            {filteredUsers.map((u) => (
              <div key={u.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{u.nombre || 'Sin nombre'}</div>
                    <div className="text-xs text-[#F0EFE8]/40">{u.email || '—'}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <PlanBadge plan={u.plan} />
                    <UserActions user={u} onAction={handleUserAction} />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-[#F0EFE8]/40">WhatsApp:</span> <span className="font-mono">{u.whatsapp}</span></div>
                  <div><span className="text-[#F0EFE8]/40">Txs:</span> {u.transacciones}</div>
                  <div className="flex items-center gap-1.5"><StatusDot active={u.tiene_gmail} /><span className="text-[#F0EFE8]/40">Gmail</span></div>
                  <div className="flex items-center gap-1.5"><StatusDot active={u.tiene_webapp} /><span className="text-[#F0EFE8]/40">Webapp</span></div>
                  <div className="flex items-center gap-1.5"><CanalBadge canal={u.canal} /></div>
                  {u.plan === 'premium' && u.premium_vence && (() => {
                    const daysLeft = Math.ceil((new Date(u.premium_vence).getTime() - Date.now()) / 86400000);
                    return (
                      <div className={`col-span-2 ${daysLeft <= 7 ? 'text-[#E85D3A] font-medium' : ''}`}>
                        <span className="text-[#F0EFE8]/40">Vence:</span>{' '}
                        {daysLeft <= 0 ? 'Vencido' : daysLeft <= 7 ? `en ${daysLeft} dias` : formatDate(u.premium_vence)}
                      </div>
                    );
                  })()}
                  <div className="col-span-2 text-[#F0EFE8]/30">Registro: {formatDateTime(u.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* NLP Errors Tab */}
      {tab === 'nlp' && (() => {
        const tiposUnicos = [...new Set(nlpErrors.map((e) => e.error_tipo))];
        const usersUnicos = [...new Set(nlpErrors.filter((e) => e.whatsapp).map((e) => e.whatsapp!))];

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

            <div className="flex flex-wrap items-center gap-2 text-xs text-[#F0EFE8]/40">
              <span>{filtered.length} de {nlpErrors.length} errores NLP reales</span>
              {nlpRateLimit > 0 && (
                <span className="rounded-full bg-white/5 px-2 py-0.5 text-[#F0EFE8]/50" title="Errores 429 de OpenAI (saturación de tokens). Es infra, no NLP. Se muestran aparte.">
                  + {nlpRateLimit} rate-limit (infra, oculto)
                </span>
              )}
            </div>

            {nlpErrors.length > 0 && nlpTipoFilter === 'all' && nlpUserFilter === 'all' && !nlpSearch && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                  <h4 className="mb-2 text-xs font-medium text-[#F0EFE8]/50">Top 5 mensajes que fallan</h4>
                  {(() => {
                    const msgCounts: Record<string, number> = {};
                    for (const err of nlpErrors) {
                      const key = err.mensaje.toLowerCase().trim().slice(0, 80);
                      msgCounts[key] = (msgCounts[key] || 0) + 1;
                    }
                    const sorted = Object.entries(msgCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
                    const maxCount = sorted[0]?.[1] || 1;
                    return (
                      <div className="space-y-2">
                        {sorted.map(([msg, count]) => (
                          <div key={msg}>
                            <div className="flex items-center justify-between text-xs">
                              <span className="max-w-[200px] truncate text-[#F0EFE8]/60">&ldquo;{msg}&rdquo;</span>
                              <span className="font-mono text-[#F0EFE8]/40">{count}x</span>
                            </div>
                            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/5">
                              <div className="h-full rounded-full bg-[#E85D3A]/60" style={{ width: `${(count / maxCount) * 100}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                  <h4 className="mb-2 text-xs font-medium text-[#F0EFE8]/50">Errores por tipo</h4>
                  {(() => {
                    const tipoCounts: Record<string, number> = {};
                    for (const err of nlpErrors) {
                      tipoCounts[err.error_tipo] = (tipoCounts[err.error_tipo] || 0) + 1;
                    }
                    return (
                      <div className="space-y-2">
                        {Object.entries(tipoCounts).sort((a, b) => b[1] - a[1]).map(([tipo, count]) => (
                          <div key={tipo} className="flex items-center justify-between text-xs">
                            <span className={`rounded-full px-2 py-0.5 ${
                              tipo === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'
                            }`}>{tipo}</span>
                            <span className="font-mono text-[#F0EFE8]/40">{count}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {nlpQuery.isLoading ? (
              <ListSkeleton rows={6} />
            ) : filtered.length === 0 ? (
              <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center text-[#F0EFE8]/40">
                {nlpErrors.length === 0
                  ? 'No hay errores NLP registrados aun.'
                  : 'Ningun error coincide con los filtros.'}
                <br />
                <span className="text-xs">Los mensajes no procesados apareceran aqui cuando ocurran.</span>
              </div>
            ) : (
              filtered.map((err) => (
                <div key={err.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-sm">&ldquo;{err.mensaje}&rdquo;</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <span className={`rounded-full px-2 py-0.5 ${
                          err.error_tipo === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'
                        }`}>{err.error_tipo}</span>
                        {err.intencion && (
                          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[#F0EFE8]/50">Intento: {err.intencion}</span>
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
                        <div className="mt-1 text-xs text-[#F0EFE8]/30">{err.error_detalle}</div>
                      )}
                    </div>
                    <div className="ml-3 whitespace-nowrap text-xs text-[#F0EFE8]/30">{formatDateTime(err.created_at)}</div>
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

        const whatsappToName: Record<string, string> = {};
        for (const u of users) {
          if (u.whatsapp) whatsappToName[u.whatsapp] = u.nombre || u.whatsapp;
        }

        return (
          <div className="space-y-4">
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

            <div className="text-xs text-[#F0EFE8]/40">
              {ticketsTotal} tickets total{ticketsPendientes > 0 && ` (${ticketsPendientes} pendientes)`}
            </div>

            {ticketsQuery.isLoading ? (
              <ListSkeleton rows={6} />
            ) : tickets.length === 0 ? (
              <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center text-[#F0EFE8]/40">
                No hay tickets de soporte.
              </div>
            ) : (
              <>
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
                            {t.whatsapp ? (whatsappToName[t.whatsapp] || 'Sin nombre') : '—'}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">{t.whatsapp || '—'}</td>
                          <td className="max-w-xs px-4 py-3">
                            <div className="truncate text-sm">{t.mensaje_usuario || <span className="text-[#F0EFE8]/30">(sin mensaje aún)</span>}</div>
                            {t.mensaje_admin && (
                              <div className="mt-1 truncate text-xs text-[#1D9E75]/70">Respuesta: {t.mensaje_admin}</div>
                            )}
                          </td>
                          <td className="px-4 py-3">{estadoBadge(t.estado)}</td>
                          <td className="px-4 py-3 text-xs text-[#F0EFE8]/40 whitespace-nowrap">{formatDateTime(t.created_at)}</td>
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

                <div className="space-y-3 md:hidden">
                  {tickets.map((t) => (
                    <div key={t.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="text-sm font-medium">{t.whatsapp ? (whatsappToName[t.whatsapp] || t.whatsapp) : 'Sin usuario'}</div>
                          <div className="mt-1 text-sm text-[#F0EFE8]/70">{t.mensaje_usuario || <span className="text-[#F0EFE8]/30">(sin mensaje aún)</span>}</div>
                          {t.mensaje_admin && (
                            <div className="mt-1 text-xs text-[#1D9E75]/70">Respuesta: {t.mensaje_admin}</div>
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

      {paymentsUser && (
        <PaymentsModal
          user={paymentsUser}
          onClose={() => setPaymentsUser(null)}
          onApproved={() => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })}
          setToast={setToast}
        />
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </>
  );
}
