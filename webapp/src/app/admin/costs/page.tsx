'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Eye,
  Pencil,
  Plus,
  Power,
  X,
} from 'lucide-react';
import {
  useAdminCosts,
  useCreateAdminCost,
  useDeleteAdminCost,
  useMarkCostPaid,
  useUpdateAdminCost,
  type CostInput,
} from '@/lib/hooks/use-admin-costs';
import {
  ADMIN_COST_CATEGORY_LABELS,
  ADMIN_COST_FREQUENCY_LABELS,
} from '@/lib/constants';
import type {
  AdminCost,
  AdminCostCategory,
  AdminCostFrequency,
} from '@/lib/types-admin';

const CATEGORIES: AdminCostCategory[] = [
  'infra',
  'domain',
  'comms',
  'ai',
  'compliance',
  'tooling',
  'other',
];
const FREQUENCIES: AdminCostFrequency[] = ['monthly', 'yearly', 'one_time'];

function todayIsoLima(): string {
  const now = new Date();
  const lima = new Date(now.getTime() - 5 * 3600 * 1000);
  const y = lima.getUTCFullYear();
  const m = String(lima.getUTCMonth() + 1).padStart(2, '0');
  const d = String(lima.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function diffDaysUTC(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + 'T00:00:00Z').getTime();
  const b = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()),
  );
  if (target.getUTCDate() !== d.getUTCDate()) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

function formatPen(n: number, decimals = 2): string {
  return `S/ ${n.toLocaleString('es-PE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatDateLima(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function CategoryBadge({ category }: { category: AdminCostCategory }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#C8C6BC]">
      {ADMIN_COST_CATEGORY_LABELS[category]}
    </span>
  );
}

function DueBadge({ cost, today }: { cost: AdminCost; today: string }) {
  if (!cost.active) {
    return (
      <span className="inline-flex items-center rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#8A877D]">
        Pausado
      </span>
    );
  }
  if (!cost.next_due_date) return null;

  const days = diffDaysUTC(today, cost.next_due_date);
  if (days < 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-[rgba(216,90,48,0.12)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#D85A30]">
        Atrasado
      </span>
    );
  }
  if (days === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-[rgba(216,90,48,0.12)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#D85A30]">
        Vence HOY
      </span>
    );
  }
  if (days <= 7) {
    return (
      <span className="inline-flex items-center rounded-full bg-[rgba(239,159,39,0.12)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#EF9F27]">
        En {days} {days === 1 ? 'día' : 'días'}
      </span>
    );
  }
  return null;
}

function AmountCell({ cost }: { cost: AdminCost }) {
  if (cost.currency === 'USD' && cost.amount_original !== null) {
    return (
      <div>
        <div className="text-sm">{formatPen(Number(cost.amount_pen))}</div>
        <div className="text-[11px] text-[#8A877D]">
          ${Number(cost.amount_original).toFixed(2)}
        </div>
      </div>
    );
  }
  return <div className="text-sm">{formatPen(Number(cost.amount_pen))}</div>;
}

interface CostFormState {
  label: string;
  category: AdminCostCategory;
  frequency: AdminCostFrequency;
  isUSD: boolean;
  amountPen: string;
  amountUSD: string;
  exchangeRate: string;
  nextDueDate: string;
  notes: string;
  active: boolean;
}

function emptyForm(): CostFormState {
  return {
    label: '',
    category: 'other',
    frequency: 'monthly',
    isUSD: false,
    amountPen: '',
    amountUSD: '',
    exchangeRate: '3.50',
    nextDueDate: '',
    notes: '',
    active: true,
  };
}

function costToForm(cost: AdminCost): CostFormState {
  const isUSD = cost.currency === 'USD';
  const exchangeRate =
    isUSD && cost.amount_original
      ? (Number(cost.amount_pen) / Number(cost.amount_original)).toFixed(4)
      : '3.50';
  return {
    label: cost.label,
    category: cost.category,
    frequency: cost.frequency,
    isUSD,
    amountPen: String(cost.amount_pen),
    amountUSD: cost.amount_original ? String(cost.amount_original) : '',
    exchangeRate,
    nextDueDate: cost.next_due_date || '',
    notes: cost.notes || '',
    active: cost.active,
  };
}

function formToInput(form: CostFormState): CostInput {
  let amountPen = Number(form.amountPen) || 0;
  let amountOriginal: number | null = null;
  if (form.isUSD) {
    const usd = Number(form.amountUSD) || 0;
    const rate = Number(form.exchangeRate) || 0;
    amountPen = Math.round(usd * rate * 100) / 100;
    amountOriginal = usd;
  }
  return {
    label: form.label.trim(),
    category: form.category,
    frequency: form.frequency,
    currency: form.isUSD ? 'USD' : 'PEN',
    amount_pen: amountPen,
    amount_original: amountOriginal,
    next_due_date:
      form.frequency === 'one_time' && !form.nextDueDate
        ? null
        : form.nextDueDate || null,
    notes: form.notes.trim() || null,
    active: form.active,
  };
}

function CostFormModal({
  open,
  cost,
  onClose,
}: {
  open: boolean;
  cost: AdminCost | null;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CostFormState>(
    cost ? costToForm(cost) : emptyForm(),
  );
  const [error, setError] = useState<string | null>(null);

  const create = useCreateAdminCost();
  const update = useUpdateAdminCost(cost?.id || '');

  // Reset form when modal opens/cost changes
  useEffect(() => {
    setForm(cost ? costToForm(cost) : emptyForm());
    setError(null);
  }, [cost, open]);

  if (!open) return null;

  const isEdit = !!cost;
  const busy = create.isPending || update.isPending;

  const computedPen = (() => {
    if (!form.isUSD) return Number(form.amountPen) || 0;
    const usd = Number(form.amountUSD) || 0;
    const rate = Number(form.exchangeRate) || 0;
    return Math.round(usd * rate * 100) / 100;
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.label.trim()) {
      setError('El label es requerido');
      return;
    }
    const input = formToInput(form);
    if (input.amount_pen < 0 || !Number.isFinite(input.amount_pen)) {
      setError('El monto debe ser un número ≥ 0');
      return;
    }
    try {
      if (isEdit) await update.mutateAsync(input);
      else await create.mutateAsync(input);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="glass-card-elevated max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl p-5"
      >
        <h3 className="mb-4 text-lg font-semibold text-[#F0EFE8]">
          {isEdit ? 'Editar costo' : 'Añadir costo'}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-[#8A877D]">
              Label
            </label>
            <input
              type="text"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              maxLength={100}
              required
              className="form-input w-full"
              placeholder="Ej. Railway prod"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-[#8A877D]">
                Categoría
              </label>
              <select
                value={form.category}
                onChange={(e) =>
                  setForm({
                    ...form,
                    category: e.target.value as AdminCostCategory,
                  })
                }
                className="form-input w-full"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c} className="bg-[#1A1A17]">
                    {ADMIN_COST_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-[#8A877D]">
                Frecuencia
              </label>
              <div className="flex rounded-lg border border-white/10 bg-[#1A1A17] p-1">
                {FREQUENCIES.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setForm({ ...form, frequency: f })}
                    className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                      form.frequency === f
                        ? 'bg-[rgba(29,158,117,0.18)] text-[#1D9E75]'
                        : 'text-[#8A877D] hover:text-[#F0EFE8]'
                    }`}
                  >
                    {ADMIN_COST_FREQUENCY_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 flex items-center justify-between text-xs uppercase tracking-wider text-[#8A877D]">
              <span>Monto en PEN</span>
              <label className="flex items-center gap-2 normal-case tracking-normal">
                <input
                  type="checkbox"
                  checked={form.isUSD}
                  onChange={(e) =>
                    setForm({ ...form, isUSD: e.target.checked })
                  }
                  className="h-3.5 w-3.5 accent-[#1D9E75]"
                />
                <span className="text-[11px] text-[#C8C6BC]">¿Es en USD?</span>
              </label>
            </label>
            {!form.isUSD && (
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.amountPen}
                onChange={(e) => setForm({ ...form, amountPen: e.target.value })}
                required
                className="form-input w-full"
                placeholder="0.00"
              />
            )}
            {form.isUSD && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.amountUSD}
                    onChange={(e) =>
                      setForm({ ...form, amountUSD: e.target.value })
                    }
                    required
                    className="form-input w-full"
                    placeholder="USD"
                  />
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    value={form.exchangeRate}
                    onChange={(e) =>
                      setForm({ ...form, exchangeRate: e.target.value })
                    }
                    required
                    className="form-input w-full"
                    placeholder="Tipo de cambio"
                  />
                </div>
                <div className="text-xs text-[#8A877D]">
                  Equivalente: <span className="text-[#1D9E75]">{formatPen(computedPen)}</span>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-[#8A877D]">
              Próximo vencimiento{form.frequency === 'one_time' ? ' (opcional)' : ''}
            </label>
            <input
              type="date"
              value={form.nextDueDate}
              onChange={(e) =>
                setForm({ ...form, nextDueDate: e.target.value })
              }
              className="form-input w-full"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-[#8A877D]">
              Notas
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="form-input w-full resize-none"
              placeholder="Opcional"
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
              className="h-4 w-4 accent-[#1D9E75]"
            />
            <span className="text-sm text-[#F0EFE8]">Activo</span>
          </label>

          {error && (
            <div className="rounded-lg border border-[rgba(216,90,48,0.35)] bg-[rgba(216,90,48,0.08)] p-2 text-xs text-[#D85A30]">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-white/10 bg-[#131311] px-4 py-2 text-sm text-[#C8C6BC] hover:text-[#F0EFE8] disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[#1D9E75] px-4 py-2 text-sm font-medium text-white hover:bg-[#178a65] disabled:opacity-50"
          >
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function MarkPaidModal({
  cost,
  onClose,
}: {
  cost: AdminCost | null;
  onClose: () => void;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const markPaid = useMarkCostPaid(cost?.id || '');

  // Reset state when modal target changes
  useEffect(() => {
    setCustomMode(false);
    setCustomAmount('');
    setError(null);
  }, [cost?.id]);

  if (!cost) return null;

  const today = todayIsoLima();
  const reference = cost.next_due_date || today;
  const newDate =
    cost.frequency === 'monthly'
      ? addMonthsIso(reference, 1)
      : cost.frequency === 'yearly'
        ? addMonthsIso(reference, 12)
        : null;

  const handleConfirm = async () => {
    setError(null);
    let amount: number | undefined = undefined;
    if (customMode) {
      const n = Number(customAmount);
      if (!Number.isFinite(n) || n < 0) {
        setError('Monto inválido');
        return;
      }
      amount = n;
    }
    try {
      await markPaid.mutateAsync(amount !== undefined ? { amount_pen: amount } : undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al confirmar');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-card-elevated w-full max-w-md rounded-xl p-5"
      >
        <h3 className="mb-3 text-lg font-semibold text-[#F0EFE8]">
          Marcar como pagado
        </h3>
        <p className="text-sm text-[#C8C6BC]">
          Estás marcando <span className="font-medium text-[#F0EFE8]">{cost.label}</span> como pagado por{' '}
          <span className="font-medium text-[#F0EFE8]">{formatPen(Number(cost.amount_pen))}</span>.
        </p>
        {newDate && (
          <p className="mt-2 text-sm text-[#C8C6BC]">
            La próxima fecha avanzará a{' '}
            <span className="font-medium text-[#1D9E75]">{formatDateLima(newDate)}</span>.
          </p>
        )}
        {cost.frequency === 'one_time' && (
          <p className="mt-2 text-sm text-[#C8C6BC]">
            Este costo es de pago único, quedará pausado tras confirmar.
          </p>
        )}

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={customMode}
            onChange={(e) => setCustomMode(e.target.checked)}
            className="h-4 w-4 accent-[#1D9E75]"
          />
          <span className="text-[#F0EFE8]">Pagué un monto distinto</span>
        </label>
        {customMode && (
          <input
            type="number"
            step="0.01"
            min="0"
            value={customAmount}
            onChange={(e) => setCustomAmount(e.target.value)}
            placeholder="Monto pagado en PEN"
            className="form-input mt-2 w-full"
          />
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-[rgba(216,90,48,0.35)] bg-[rgba(216,90,48,0.08)] p-2 text-xs text-[#D85A30]">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={markPaid.isPending}
            className="rounded-lg border border-white/10 bg-[#131311] px-4 py-2 text-sm text-[#C8C6BC] hover:text-[#F0EFE8] disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={markPaid.isPending}
            className="rounded-lg bg-[#1D9E75] px-4 py-2 text-sm font-medium text-white hover:bg-[#178a65] disabled:opacity-50"
          >
            {markPaid.isPending ? 'Confirmando…' : 'Confirmar pago'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CostDetailModal({
  cost,
  onClose,
}: {
  cost: AdminCost | null;
  onClose: () => void;
}) {
  if (!cost) return null;
  const history = [...(cost.paid_history || [])].sort((a, b) =>
    a.paid_at < b.paid_at ? 1 : -1,
  );
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-card-elevated max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl p-5"
      >
        <h3 className="text-lg font-semibold text-[#F0EFE8]">{cost.label}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <CategoryBadge category={cost.category} />
          <span className="text-xs text-[#8A877D]">
            {ADMIN_COST_FREQUENCY_LABELS[cost.frequency]} ·{' '}
            {formatPen(Number(cost.amount_pen))}
          </span>
        </div>

        {cost.notes && (
          <div className="mt-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-sm text-[#C8C6BC]">
            {cost.notes}
          </div>
        )}

        <div className="mt-4">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8A877D]">
            Historial de pagos
          </h4>
          {history.length === 0 ? (
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-[#8A877D]">
              Aún sin pagos registrados.
            </div>
          ) : (
            <ul className="space-y-2">
              {history.map((p, i) => (
                <li
                  key={`${p.paid_at}-${i}`}
                  className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-sm"
                >
                  <span className="text-[#F0EFE8]">{formatDateLima(p.paid_at)}</span>
                  <span className="text-[#1D9E75]">{formatPen(p.amount_pen)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-[#8A877D]">
          <div>
            <div className="uppercase tracking-wider">Próximo</div>
            <div className="mt-1 text-[#F0EFE8]">
              {formatDateLima(cost.next_due_date)}
            </div>
          </div>
          <div>
            <div className="uppercase tracking-wider">Creado</div>
            <div className="mt-1 text-[#F0EFE8]">
              {formatDateLima(cost.created_at.slice(0, 10))}
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-[#131311] px-4 py-2 text-sm text-[#C8C6BC] hover:text-[#F0EFE8]"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

function CostRowActions({
  cost,
  onView,
  onEdit,
  onMarkPaid,
}: {
  cost: AdminCost;
  onView: () => void;
  onEdit: () => void;
  onMarkPaid: () => void;
}) {
  const toggle = useDeleteAdminCost(cost.id);
  const update = useUpdateAdminCost(cost.id);

  const handleToggleActive = async () => {
    if (cost.active) {
      await toggle.mutateAsync();
    } else {
      await update.mutateAsync({ active: true });
    }
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <button
        onClick={onView}
        title="Ver detalle"
        className="rounded-md p-1.5 text-[#8A877D] hover:bg-white/5 hover:text-[#F0EFE8]"
      >
        <Eye className="h-4 w-4" />
      </button>
      <button
        onClick={onEdit}
        title="Editar"
        className="rounded-md p-1.5 text-[#8A877D] hover:bg-white/5 hover:text-[#F0EFE8]"
      >
        <Pencil className="h-4 w-4" />
      </button>
      {cost.active && (
        <button
          onClick={onMarkPaid}
          title="Marcar como pagado"
          className="rounded-md p-1.5 text-[#1D9E75] hover:bg-[rgba(29,158,117,0.12)]"
        >
          <Check className="h-4 w-4" />
        </button>
      )}
      <button
        onClick={handleToggleActive}
        disabled={toggle.isPending || update.isPending}
        title={cost.active ? 'Pausar' : 'Reactivar'}
        className="rounded-md p-1.5 text-[#8A877D] hover:bg-white/5 hover:text-[#F0EFE8] disabled:opacity-50"
      >
        {cost.active ? <X className="h-4 w-4" /> : <Power className="h-4 w-4" />}
      </button>
    </div>
  );
}

export default function AdminCostsPage() {
  const { data: costs, isLoading, error } = useAdminCosts();
  const [showInactive, setShowInactive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingCost, setEditingCost] = useState<AdminCost | null>(null);
  const [viewCost, setViewCost] = useState<AdminCost | null>(null);
  const [markPaidCost, setMarkPaidCost] = useState<AdminCost | null>(null);

  const today = todayIsoLima();

  const filtered = useMemo(() => {
    if (!costs) return [];
    return showInactive ? costs : costs.filter((c) => c.active);
  }, [costs, showInactive]);

  const stats = useMemo(() => {
    const active = (costs || []).filter((c) => c.active);
    let monthly = 0;
    for (const c of active) {
      if (c.frequency === 'monthly') monthly += Number(c.amount_pen);
      else if (c.frequency === 'yearly') monthly += Number(c.amount_pen) / 12;
    }
    monthly = Math.round(monthly * 100) / 100;
    const inSevenDays = (() => {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString().slice(0, 10);
    })();
    const dueWeek = active.filter(
      (c) =>
        c.next_due_date !== null &&
        c.next_due_date >= today &&
        c.next_due_date <= inSevenDays,
    ).length;
    const dueToday = active.filter((c) => c.next_due_date === today).length;
    return { monthly, dueWeek, dueToday };
  }, [costs, today]);

  if (error) {
    return (
      <div className="rounded-xl border border-[rgba(216,90,48,0.35)] bg-[rgba(216,90,48,0.08)] p-4 text-sm text-[#D85A30]">
        Error al cargar costos. {error instanceof Error ? error.message : ''}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-[#F0EFE8]">Costos operativos</h2>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#1D9E75] px-3 py-2 text-sm font-medium text-white hover:bg-[#178a65]"
        >
          <Plus className="h-4 w-4" />
          Añadir costo
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="glass-card rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-[#8A877D]">
            Costos mensuales totales
          </div>
          <div className="mt-1 text-xl font-semibold text-[#F0EFE8]">
            {formatPen(stats.monthly)}
          </div>
        </div>
        <div className="glass-card rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-[#8A877D]">
            Vencen esta semana
          </div>
          <div className="mt-1 text-xl font-semibold text-[#F0EFE8]">
            {stats.dueWeek}
          </div>
        </div>
        <div
          className={`glass-card rounded-xl p-4 ${
            stats.dueToday > 0 ? 'ring-1 ring-[rgba(239,159,39,0.35)]' : ''
          }`}
        >
          <div className="text-xs uppercase tracking-wider text-[#8A877D]">
            Vencen hoy
          </div>
          <div
            className={`mt-1 text-xl font-semibold ${
              stats.dueToday > 0 ? 'text-[#EF9F27]' : 'text-[#F0EFE8]'
            }`}
          >
            {stats.dueToday}
          </div>
        </div>
      </div>

      {/* Filtro */}
      <label className="flex items-center gap-2 text-xs text-[#C8C6BC]">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
          className="h-3.5 w-3.5 accent-[#1D9E75]"
        />
        Mostrar pausados
      </label>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]"
            />
          ))}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="glass-card rounded-xl p-8 text-center text-sm text-[#8A877D]">
          No hay costos {showInactive ? 'registrados' : 'activos'} aún.
        </div>
      )}

      {/* Desktop table */}
      {!isLoading && filtered.length > 0 && (
        <div className="hidden overflow-x-auto rounded-xl border border-white/5 bg-[#131311] md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 bg-white/[0.02] text-left text-[10px] uppercase tracking-wider text-[#8A877D]">
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">Categoría</th>
                <th className="px-4 py-3">Monto</th>
                <th className="px-4 py-3">Frecuencia</th>
                <th className="px-4 py-3">Próximo</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map((cost) => (
                <tr
                  key={cost.id}
                  className={`hover:bg-white/[0.02] ${cost.active ? '' : 'opacity-50'}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-[#F0EFE8]">{cost.label}</div>
                    {cost.notes && (
                      <div className="mt-0.5 truncate text-xs text-[#8A877D]">
                        {cost.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <CategoryBadge category={cost.category} />
                  </td>
                  <td className="px-4 py-3">
                    <AmountCell cost={cost} />
                  </td>
                  <td className="px-4 py-3 text-[#C8C6BC]">
                    {ADMIN_COST_FREQUENCY_LABELS[cost.frequency]}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-[#F0EFE8]">
                      {formatDateLima(cost.next_due_date)}
                    </div>
                    <div className="mt-1">
                      <DueBadge cost={cost} today={today} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <CostRowActions
                      cost={cost}
                      onView={() => setViewCost(cost)}
                      onEdit={() => setEditingCost(cost)}
                      onMarkPaid={() => setMarkPaidCost(cost)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile cards */}
      {!isLoading && filtered.length > 0 && (
        <div className="space-y-3 md:hidden">
          {filtered.map((cost) => (
            <div
              key={cost.id}
              className={`glass-card rounded-xl p-4 ${cost.active ? '' : 'opacity-50'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-[#F0EFE8]">{cost.label}</span>
                    <CategoryBadge category={cost.category} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#8A877D]">
                    <span>{ADMIN_COST_FREQUENCY_LABELS[cost.frequency]}</span>
                    <span>·</span>
                    <span>{formatDateLima(cost.next_due_date)}</span>
                    <DueBadge cost={cost} today={today} />
                  </div>
                </div>
                <div className="text-right">
                  <AmountCell cost={cost} />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <CostRowActions
                  cost={cost}
                  onView={() => setViewCost(cost)}
                  onEdit={() => setEditingCost(cost)}
                  onMarkPaid={() => setMarkPaidCost(cost)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <CostFormModal
        open={createOpen || !!editingCost}
        cost={editingCost}
        onClose={() => {
          setCreateOpen(false);
          setEditingCost(null);
        }}
      />
      <MarkPaidModal cost={markPaidCost} onClose={() => setMarkPaidCost(null)} />
      <CostDetailModal cost={viewCost} onClose={() => setViewCost(null)} />
    </div>
  );
}
