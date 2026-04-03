'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Plus, CreditCard, Copy, Check, Users, UserPlus, Pencil, Trash2, PieChart, Target } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { FadeIn } from '@/components/shared/motion-wrapper';
import {
  useSpaceDetail,
  useAddExpense,
  useSettle,
  useUpdateSplitRules,
  useUpdateBudgets,
  useUpdateDefaultSplit,
  resolveSplit,
} from '@/lib/hooks/use-shared-spaces';
import type { SpaceSplitRule, SpaceBudget } from '@/lib/hooks/use-shared-spaces';
import { formatCurrency } from '@/lib/utils';
import { CATEGORIAS, getCategoriaEmoji } from '@/lib/constants';

function BalanceCard({
  name,
  balance,
  isCurrentUser,
}: {
  name: string;
  balance: number;
  isCurrentUser: boolean;
}) {
  const abs = Math.abs(balance);
  const isPositive = balance > 0;
  const isZero = Math.abs(balance) < 0.01;

  return (
    <div className={`glass-card p-4 ${isCurrentUser ? 'border border-[rgba(29,158,117,0.3)]' : ''}`}>
      <p className="text-xs text-[#8A877D] mb-1">{name}{isCurrentUser ? ' (tú)' : ''}</p>
      {isZero ? (
        <p className="text-sm font-semibold text-[#1D9E75]">Al día ✅</p>
      ) : isPositive ? (
        <p className="text-sm font-semibold text-[#1D9E75]">Te deben {formatCurrency(abs)}</p>
      ) : (
        <p className="text-sm font-semibold text-[#E85D3A]">Debes {formatCurrency(abs)}</p>
      )}
    </div>
  );
}

export default function SpaceDetailPage() {
  const params = useParams<{ id: string }>();
  const spaceId = params.id;
  const { data, isLoading } = useSpaceDetail(spaceId);
  const addExpense = useAddExpense(spaceId);
  const settle = useSettle(spaceId);
  const updateSplitRules = useUpdateSplitRules(spaceId);
  const updateBudgets = useUpdateBudgets(spaceId);
  const updateDefaultSplit = useUpdateDefaultSplit(spaceId);

  const [showExpenseDialog, setShowExpenseDialog] = useState(false);
  const [showSettleDialog, setShowSettleDialog] = useState(false);
  const [showSplitRuleDialog, setShowSplitRuleDialog] = useState(false);
  const [showBudgetDialog, setShowBudgetDialog] = useState(false);
  const [showDefaultSplitDialog, setShowDefaultSplitDialog] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // Expense form state
  const [expAmount, setExpAmount] = useState('');
  const [expDescription, setExpDescription] = useState('');
  const [expCategory, setExpCategory] = useState('');

  // Split rule form state
  const [ruleCategory, setRuleCategory] = useState('');
  const [ruleSplits, setRuleSplits] = useState<Record<string, string>>({});

  // Budget form state
  const [budgetCategory, setBudgetCategory] = useState('');
  const [budgetLimit, setBudgetLimit] = useState('');

  // Default split form state
  const [defaultSplits, setDefaultSplits] = useState<Record<string, string>>({});

  // Settle form state
  const [settleToUser, setSettleToUser] = useState('');
  const [settleAmount, setSettleAmount] = useState('');

  async function handleAddExpense() {
    const amount = parseFloat(expAmount);
    if (!amount || amount <= 0) { toast.error('Monto inválido'); return; }
    try {
      await addExpense.mutateAsync({ amount, description: expDescription, category: expCategory || undefined });
      toast.success('Gasto registrado');
      setShowExpenseDialog(false);
      setExpAmount(''); setExpDescription(''); setExpCategory('');
    } catch {
      toast.error('No se pudo registrar el gasto');
    }
  }

  async function handleSettle() {
    const amount = parseFloat(settleAmount);
    if (!settleToUser || !amount || amount <= 0) { toast.error('Completa todos los campos'); return; }
    try {
      await settle.mutateAsync({ to_user: settleToUser, amount });
      toast.success('Pago registrado');
      setShowSettleDialog(false);
      setSettleAmount(''); setSettleToUser('');
    } catch {
      toast.error('No se pudo registrar el pago');
    }
  }

  function copyInviteCode() {
    if (!data?.space?.invite_code) return;
    navigator.clipboard.writeText(data.space.invite_code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
    toast.success('Código copiado');
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[120px] rounded-2xl" />
        <Skeleton className="h-[200px] rounded-2xl" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-[#8A877D]">Espacio no encontrado o sin acceso.</p>
        <Link href="/dashboard/espacios" className="text-[#1D9E75] text-sm mt-2 inline-block">← Volver</Link>
      </div>
    );
  }

  const { space, members, expenses, balance, currentUserId } = data;
  const otherMembers = members.filter((m) => m.user_id !== currentUserId);

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <FadeIn>
        <div className="flex items-center gap-3">
          <Link href="/dashboard/espacios" className="text-[#8A877D] hover:text-[#F0EFE8] transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-[#F0EFE8]">{space.name}</h1>
            <p className="text-xs text-[#8A877D]">{members.length} miembro{members.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
      </FadeIn>

      {/* A. Balance section */}
      <FadeIn delay={0.05}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#F0EFE8]">Balances</h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowSettleDialog(true)}
              className="text-xs border-[rgba(255,255,255,0.1)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.04)] gap-1.5"
            >
              <CreditCard className="w-3.5 h-3.5" />
              Registrar pago
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {members.map((m) => (
              <BalanceCard
                key={m.user_id}
                name={m.usuarios?.nombre ?? m.user_id}
                balance={balance[m.user_id] ?? 0}
                isCurrentUser={m.user_id === currentUserId}
              />
            ))}
          </div>
          {/* Simplified debts */}
          {members.some((m) => (balance[m.user_id] ?? 0) < -0.01) && (
            <div className="glass-card p-4 space-y-1.5">
              <p className="text-xs font-medium text-[#8A877D] uppercase tracking-wide">Resumen de deudas</p>
              {members
                .filter((m) => (balance[m.user_id] ?? 0) < -0.01)
                .map((debtor) => {
                  const creditor = members.find((m) => (balance[m.user_id] ?? 0) > 0.01);
                  if (!creditor) return null;
                  return (
                    <p key={debtor.user_id} className="text-sm text-[#C8C6BC]">
                      <span className="text-[#E85D3A]">{debtor.usuarios?.nombre}</span>
                      {' le debe '}
                      <span className="font-semibold">{formatCurrency(Math.abs(balance[debtor.user_id]))}</span>
                      {' a '}
                      <span className="text-[#1D9E75]">{creditor.usuarios?.nombre}</span>
                    </p>
                  );
                })}
            </div>
          )}
        </div>
      </FadeIn>

      {/* B. Expenses section */}
      <FadeIn delay={0.1}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#F0EFE8]">Gastos recientes</h2>
            <Button
              size="sm"
              onClick={() => setShowExpenseDialog(true)}
              className="text-xs bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Agregar
            </Button>
          </div>
          {expenses.length === 0 ? (
            <div className="glass-card p-6 text-center">
              <p className="text-sm text-[#8A877D]">Sin gastos registrados aún</p>
            </div>
          ) : (
            <div className="space-y-2">
              {expenses.map((exp) => {
                const paidByMe = exp.paid_by === currentUserId;
                const myFraction = resolveSplit(exp.category, currentUserId, members, data.splitRules ?? []);
                const myShare = Number(exp.amount) * myFraction;
                const hasRule = exp.category && (data.splitRules ?? []).some((r) => r.category === exp.category);
                const myPct = Math.round(myFraction * 100);

                return (
                  <div key={exp.id} className="glass-card p-3.5 flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#F0EFE8] truncate">{exp.description || 'Sin descripción'}</p>
                      <p className="text-xs text-[#8A877D] mt-0.5">
                        {paidByMe ? 'Pagaste tú' : `Pagó ${exp.usuarios?.nombre}`}
                        {exp.category ? ` · ${exp.category}` : ''}
                        {' · '}{new Date(exp.created_at).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}
                        {hasRule && <span className="text-[#1D9E75]"> · {myPct}%</span>}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-[#F0EFE8]">{formatCurrency(Number(exp.amount))}</p>
                      <p className="text-xs text-[#8A877D]">tu parte: {formatCurrency(myShare)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </FadeIn>

      {/* C. Members section */}
      <FadeIn delay={0.15}>
        <div className="glass-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#F0EFE8] flex items-center gap-2">
              <Users className="w-4 h-4 text-[#8A877D]" />
              Miembros ({members.length})
            </h2>
            <div className="flex items-center gap-3">
              <button
                onClick={copyInviteCode}
                className="flex items-center gap-1.5 text-xs text-[#8A877D] hover:text-[#C8C6BC]"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-[#1D9E75]" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedCode ? 'Copiado' : space.invite_code}
              </button>
              <button
                onClick={() => {
                  const link = `${window.location.origin}/dashboard/espacios?join=${space.invite_code}`;
                  navigator.clipboard.writeText(link);
                  setCopiedLink(true);
                  setTimeout(() => setCopiedLink(false), 2000);
                  toast.success('Link de invitación copiado');
                }}
                className="flex items-center gap-1.5 text-xs text-[#1D9E75] hover:underline"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5" /> : <UserPlus className="w-3.5 h-3.5" />}
                {copiedLink ? 'Copiado' : 'Invitar'}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            {members.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-[rgba(29,158,117,0.15)] flex items-center justify-center text-xs text-[#1D9E75] font-bold">
                    {(m.usuarios?.nombre ?? '?').charAt(0).toUpperCase()}
                  </div>
                  <span className="text-[#C8C6BC]">
                    {m.usuarios?.nombre ?? m.user_id}
                    {m.user_id === currentUserId ? ' (tú)' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-[#8A877D]">
                  <span>{m.split_percentage ?? 50}%</span>
                  <span className="capitalize">{m.role}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </FadeIn>

      {/* D. Reglas de División */}
      <FadeIn delay={0.2}>
        <div className="glass-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#F0EFE8] flex items-center gap-2">
              <PieChart className="w-4 h-4 text-[#8A877D]" />
              Reglas de División
            </h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRuleCategory('');
                setRuleSplits(Object.fromEntries(members.map((m) => [m.user_id, ''])));
                setShowSplitRuleDialog(true);
              }}
              className="text-xs border-[rgba(255,255,255,0.1)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.04)] gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Agregar regla
            </Button>
          </div>

          {/* Default rule */}
          <div className="rounded-lg bg-[rgba(255,255,255,0.02)] p-3 border border-[rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-[#8A877D]">Por defecto (todas las categorías sin regla)</p>
              <button
                onClick={() => {
                  setDefaultSplits(Object.fromEntries(members.map((m) => [m.user_id, String(m.split_percentage ?? 50)])));
                  setShowDefaultSplitDialog(true);
                }}
                className="text-[#8A877D] hover:text-[#1D9E75] transition-colors"
              >
                <Pencil className="w-3 h-3" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              {members.map((m) => (
                <div key={m.user_id} className="flex-1">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-[#C8C6BC]">{m.usuarios?.nombre}</span>
                    <span className="text-[#8A877D]">{m.split_percentage}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                    <div className="h-full rounded-full bg-[#8A877D]" style={{ width: `${m.split_percentage}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Category-specific rules */}
          {(data.splitRules ?? []).map((rule) => (
            <div key={rule.id} className="rounded-lg bg-[rgba(255,255,255,0.02)] p-3 border border-[rgba(29,158,117,0.15)]">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-[#F0EFE8]">
                  {getCategoriaEmoji(rule.category)} {rule.category}
                </p>
                <button
                  onClick={() => {
                    const updated = (data.splitRules ?? []).filter((r) => r.id !== rule.id);
                    updateSplitRules.mutate(updated);
                    toast.success('Regla eliminada');
                  }}
                  className="text-[#8A877D] hover:text-[#E85D3A] transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                {members.map((m) => {
                  const pct = rule.splits[m.user_id] ?? 0;
                  return (
                    <div key={m.user_id} className="flex-1">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-[#C8C6BC]">{m.usuarios?.nombre}</span>
                        <span className="text-[#1D9E75] font-medium">{pct}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                        <div className="h-full rounded-full bg-[#1D9E75]" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </FadeIn>

      {/* E. Presupuestos del Espacio */}
      <FadeIn delay={0.25}>
        <div className="glass-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#F0EFE8] flex items-center gap-2">
              <Target className="w-4 h-4 text-[#8A877D]" />
              Presupuestos Mensuales
            </h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBudgetCategory('');
                setBudgetLimit('');
                setShowBudgetDialog(true);
              }}
              className="text-xs border-[rgba(255,255,255,0.1)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.04)] gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Agregar
            </Button>
          </div>

          {(data.budgets ?? []).length === 0 ? (
            <p className="text-sm text-[#8A877D] text-center py-4">Sin presupuestos configurados</p>
          ) : (
            <div className="space-y-3">
              {(data.budgets ?? []).map((budget) => {
                const spent = expenses
                  .filter((e) => e.category === budget.category)
                  .reduce((s, e) => s + Number(e.amount), 0);
                const pct = budget.limit > 0 ? Math.round((spent / budget.limit) * 100) : 0;
                const barColor = pct > 90 ? '#E85D3A' : pct > 70 ? '#E8A838' : '#1D9E75';

                return (
                  <div key={budget.id} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-[#F0EFE8]">
                        {getCategoriaEmoji(budget.category)} {budget.category}
                      </p>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-[#8A877D]">
                          {formatCurrency(spent)} / {formatCurrency(budget.limit)}
                        </span>
                        <button
                          onClick={() => {
                            const updated = (data.budgets ?? []).filter((b) => b.id !== budget.id);
                            updateBudgets.mutate(updated);
                            toast.success('Presupuesto eliminado');
                          }}
                          className="text-[#8A877D] hover:text-[#E85D3A] transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: barColor }}
                      />
                    </div>
                    <div className="text-[10px] text-[#8A877D] space-y-0.5">
                      {members.map((m) => {
                        const frac = resolveSplit(budget.category, m.user_id, members, data.splitRules ?? []);
                        const memberSpent = expenses
                          .filter((e) => e.category === budget.category && e.paid_by === m.user_id)
                          .reduce((s, e) => s + Number(e.amount), 0);
                        return (
                          <div key={m.user_id} className="flex justify-between">
                            <span>{m.usuarios?.nombre}</span>
                            <span>
                              pagó {formatCurrency(memberSpent)} · le toca {formatCurrency(budget.limit * frac)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </FadeIn>

      {/* Add Expense Dialog */}
      <Dialog open={showExpenseDialog} onOpenChange={setShowExpenseDialog}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
          <DialogHeader>
            <DialogTitle>Agregar gasto</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Monto (S/)</label>
              <Input
                type="number"
                placeholder="0.00"
                value={expAmount}
                onChange={(e) => setExpAmount(e.target.value)}
                className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]"
              />
            </div>
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Descripción</label>
              <Input
                placeholder="ej: Mercado, luz, internet"
                value={expDescription}
                onChange={(e) => setExpDescription(e.target.value)}
                className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]"
              />
            </div>
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Categoría (opcional)</label>
              <Select value={expCategory || undefined} onValueChange={(v) => setExpCategory(v ?? '')}>
                <SelectTrigger className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]">
                  <SelectValue placeholder="Seleccionar categoría" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIAS.map((c) => (
                    <SelectItem key={c.nombre} value={c.nombre}>
                      {c.emoji} {c.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {expCategory && (() => {
              const rule = (data?.splitRules ?? []).find((r) => r.category === expCategory);
              return (
                <div className="rounded-lg bg-[rgba(29,158,117,0.08)] p-2.5 text-xs">
                  {rule ? (
                    <p className="text-[#1D9E75]">
                      División: {members.map((m) =>
                        `${m.usuarios?.nombre} ${rule.splits[m.user_id] ?? 0}%`
                      ).join(', ')}
                    </p>
                  ) : (
                    <p className="text-[#8A877D]">
                      Se usará la división global ({members.map((m) => `${m.split_percentage}%`).join('/')})
                    </p>
                  )}
                </div>
              );
            })()}
            <Button
              onClick={handleAddExpense}
              disabled={addExpense.isPending}
              className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
            >
              {addExpense.isPending ? 'Guardando...' : 'Registrar gasto'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Settle Dialog */}
      <Dialog open={showSettleDialog} onOpenChange={setShowSettleDialog}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
          <DialogHeader>
            <DialogTitle>Registrar pago</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Pagar a</label>
              <div className="space-y-1.5">
                {otherMembers.map((m) => (
                  <button
                    key={m.user_id}
                    onClick={() => setSettleToUser(m.user_id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                      settleToUser === m.user_id
                        ? 'border-[#1D9E75] bg-[rgba(29,158,117,0.1)] text-[#1D9E75]'
                        : 'border-[rgba(255,255,255,0.08)] text-[#C8C6BC]'
                    }`}
                  >
                    {m.usuarios?.nombre ?? m.user_id}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Monto (S/)</label>
              <Input
                type="number"
                placeholder="0.00"
                value={settleAmount}
                onChange={(e) => setSettleAmount(e.target.value)}
                className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]"
              />
            </div>
            <Button
              onClick={handleSettle}
              disabled={settle.isPending || !settleToUser}
              className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
            >
              {settle.isPending ? 'Guardando...' : 'Registrar pago'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Split Rule Dialog */}
      <Dialog open={showSplitRuleDialog} onOpenChange={setShowSplitRuleDialog}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
          <DialogHeader>
            <DialogTitle>Nueva regla de división</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Categoría</label>
              <Select value={ruleCategory || undefined} onValueChange={(v) => setRuleCategory(v ?? '')}>
                <SelectTrigger className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]">
                  <SelectValue placeholder="Seleccionar categoría" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIAS
                    .filter((c) => !(data?.splitRules ?? []).some((r) => r.category === c.nombre))
                    .map((c) => (
                      <SelectItem key={c.nombre} value={c.nombre}>
                        {c.emoji} {c.nombre}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {members.map((m) => (
              <div key={m.user_id}>
                <label className="text-xs text-[#8A877D] mb-1 block">
                  {m.usuarios?.nombre} (%)
                </label>
                <Input
                  type="number"
                  placeholder="50"
                  min={0}
                  max={100}
                  value={ruleSplits[m.user_id] ?? ''}
                  onChange={(e) => setRuleSplits((prev) => ({ ...prev, [m.user_id]: e.target.value }))}
                  className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]"
                />
              </div>
            ))}
            {(() => {
              const total = Object.values(ruleSplits).reduce((s, v) => s + (parseFloat(v) || 0), 0);
              const isValid = total === 100;
              return (
                <>
                  <p className={`text-xs ${isValid ? 'text-[#1D9E75]' : 'text-[#E85D3A]'}`}>
                    Total: {total}% {isValid ? '✓' : '(debe sumar 100%)'}
                  </p>
                  <Button
                    onClick={() => {
                      if (!ruleCategory || !isValid) return;
                      const splits: Record<string, number> = {};
                      for (const [uid, val] of Object.entries(ruleSplits)) {
                        splits[uid] = parseFloat(val) || 0;
                      }
                      const newRule: SpaceSplitRule = {
                        id: `rule-${Date.now()}`,
                        category: ruleCategory,
                        splits,
                      };
                      const updated = [...(data?.splitRules ?? []), newRule];
                      updateSplitRules.mutate(updated);
                      toast.success(`Regla para ${ruleCategory} creada`);
                      setShowSplitRuleDialog(false);
                    }}
                    disabled={!ruleCategory || !isValid}
                    className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
                  >
                    Guardar regla
                  </Button>
                </>
              );
            })()}
          </div>
        </DialogContent>
      </Dialog>

      {/* Budget Dialog */}
      <Dialog open={showBudgetDialog} onOpenChange={setShowBudgetDialog}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
          <DialogHeader>
            <DialogTitle>Nuevo presupuesto</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Categoría</label>
              <Select value={budgetCategory || undefined} onValueChange={(v) => setBudgetCategory(v ?? '')}>
                <SelectTrigger className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]">
                  <SelectValue placeholder="Seleccionar categoría" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIAS
                    .filter((c) => !(data?.budgets ?? []).some((b) => b.category === c.nombre))
                    .map((c) => (
                      <SelectItem key={c.nombre} value={c.nombre}>
                        {c.emoji} {c.nombre}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Límite mensual (S/)</label>
              <Input
                type="number"
                placeholder="0.00"
                value={budgetLimit}
                onChange={(e) => setBudgetLimit(e.target.value)}
                className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]"
              />
            </div>
            <Button
              onClick={() => {
                const limit = parseFloat(budgetLimit);
                if (!budgetCategory || !limit || limit <= 0) {
                  toast.error('Completa todos los campos');
                  return;
                }
                const newBudget: SpaceBudget = {
                  id: `sbud-${Date.now()}`,
                  category: budgetCategory,
                  limit,
                };
                const updated = [...(data?.budgets ?? []), newBudget];
                updateBudgets.mutate(updated);
                toast.success(`Presupuesto para ${budgetCategory} creado`);
                setShowBudgetDialog(false);
              }}
              disabled={!budgetCategory || !budgetLimit}
              className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
            >
              Guardar presupuesto
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Default Split Dialog */}
      <Dialog open={showDefaultSplitDialog} onOpenChange={setShowDefaultSplitDialog}>
        <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
          <DialogHeader>
            <DialogTitle>Editar división por defecto</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-[#8A877D]">
              Esta división se aplica a todas las categorías que no tienen una regla específica.
            </p>
            {members.map((m) => (
              <div key={m.user_id}>
                <label className="text-xs text-[#8A877D] mb-1 block">
                  {m.usuarios?.nombre} (%)
                </label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={defaultSplits[m.user_id] ?? ''}
                  onChange={(e) => setDefaultSplits((prev) => ({ ...prev, [m.user_id]: e.target.value }))}
                  className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]"
                />
              </div>
            ))}
            {(() => {
              const total = Object.values(defaultSplits).reduce((s, v) => s + (parseFloat(v) || 0), 0);
              const isValid = total === 100;
              return (
                <>
                  <p className={`text-xs ${isValid ? 'text-[#1D9E75]' : 'text-[#E85D3A]'}`}>
                    Total: {total}% {isValid ? '✓' : '(debe sumar 100%)'}
                  </p>
                  <Button
                    onClick={() => {
                      if (!isValid) return;
                      const splits: Record<string, number> = {};
                      for (const [uid, val] of Object.entries(defaultSplits)) {
                        splits[uid] = parseFloat(val) || 0;
                      }
                      updateDefaultSplit.mutate(splits);
                      toast.success('División por defecto actualizada');
                      setShowDefaultSplitDialog(false);
                    }}
                    disabled={!isValid}
                    className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
                  >
                    Guardar
                  </Button>
                </>
              );
            })()}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
