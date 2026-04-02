'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Plus, CreditCard, Copy, Check, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { useSpaceDetail, useAddExpense, useSettle } from '@/lib/hooks/use-shared-spaces';
import { formatCurrency } from '@/lib/utils';

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

  const [showExpenseDialog, setShowExpenseDialog] = useState(false);
  const [showSettleDialog, setShowSettleDialog] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  // Expense form state
  const [expAmount, setExpAmount] = useState('');
  const [expDescription, setExpDescription] = useState('');
  const [expCategory, setExpCategory] = useState('');

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
                const totalPct = members.reduce((s, m) => s + (m.split_percentage || 0), 0);
                const myMember = members.find((m) => m.user_id === currentUserId);
                const myPct = myMember && totalPct > 0 ? (myMember.split_percentage || 0) / totalPct : 1 / members.length;
                const myShare = Number(exp.amount) * myPct;

                return (
                  <div key={exp.id} className="glass-card p-3.5 flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#F0EFE8] truncate">{exp.description || 'Sin descripción'}</p>
                      <p className="text-xs text-[#8A877D] mt-0.5">
                        {paidByMe ? 'Pagaste tú' : `Pagó ${exp.usuarios?.nombre}`}
                        {exp.category ? ` · ${exp.category}` : ''}
                        {' · '}{new Date(exp.created_at).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}
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
            <button
              onClick={copyInviteCode}
              className="flex items-center gap-1.5 text-xs text-[#1D9E75] hover:underline"
            >
              {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedCode ? 'Copiado' : `Código: ${space.invite_code}`}
            </button>
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
              <Input
                placeholder="ej: Comida, servicios"
                value={expCategory}
                onChange={(e) => setExpCategory(e.target.value)}
                className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]"
              />
            </div>
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
    </div>
  );
}
