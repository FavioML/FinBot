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
  const [tab, setTab] = useState<'users' | 'nlp'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nlpErrors, setNlpErrors] = useState<NlpError[]>([]);
  const [nlpTotal, setNlpTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);

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

  useEffect(() => {
    if (!authorized) return;
    fetchUsers();
    fetchNlpErrors();
  }, [authorized, fetchUsers, fetchNlpErrors]);

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
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (u.nombre && u.nombre.toLowerCase().includes(s)) ||
      (u.email && u.email.toLowerCase().includes(s)) ||
      (u.whatsapp && u.whatsapp.includes(s)) ||
      u.plan.includes(s)
    );
  });

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
        </div>

        {/* Users Tab */}
        {tab === 'users' && (
          <>
            <div className="mb-4">
              <input
                type="text"
                placeholder="Buscar por nombre, email o WhatsApp..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full max-w-md rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-[#F0EFE8] placeholder-[#F0EFE8]/30 outline-none focus:border-[#1D9E75]/50"
              />
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
        {tab === 'nlp' && (
          <div className="space-y-3">
            {nlpErrors.length === 0 ? (
              <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center text-[#F0EFE8]/40">
                No hay errores NLP registrados aun.
                <br />
                <span className="text-xs">
                  Los mensajes no procesados apareceran aqui cuando ocurran.
                </span>
              </div>
            ) : (
              nlpErrors.map((err) => (
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
                        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-400">
                          {err.error_tipo}
                        </span>
                        {err.intencion && (
                          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[#F0EFE8]/50">
                            Intento: {err.intencion}
                          </span>
                        )}
                        {err.whatsapp && (
                          <span className="font-mono text-[#F0EFE8]/30">
                            {err.whatsapp}
                          </span>
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
        )}
      </div>

      {/* Toast */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
