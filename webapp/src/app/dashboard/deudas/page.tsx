'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Check, TrendingDown, TrendingUp, Coins, Pencil } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { UserMenu } from '@/components/dashboard/user-menu';
import { useUser } from '@/lib/hooks/use-user';
import { useDebts, useDebtMutations, type Deuda } from '@/lib/hooks/use-debts';
import { formatCurrency } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Tab = 'debo' | 'me_deben' | 'pagadas';

export default function DeudasPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const { data: allDebts = [], isLoading: debtsLoading } = useDebts(user?.id);
  const { create, update, pay, markPaid, remove } = useDebtMutations();

  const [tab, setTab] = useState<Tab>('debo');
  const [showForm, setShowForm] = useState(false);
  const [showPayForm, setShowPayForm] = useState<Deuda | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editDebt, setEditDebt] = useState<Deuda | null>(null);

  // Form state — nueva deuda
  const [tipo, setTipo] = useState<'debo' | 'me_deben'>('debo');
  const [contraparte, setContraparte] = useState('');
  const [monto, setMonto] = useState('');
  const [moneda, setMoneda] = useState<'PEN' | 'USD'>('PEN');
  const [descripcion, setDescripcion] = useState('');
  const [fechaVencimiento, setFechaVencimiento] = useState('');

  // Form state — abono
  const [montoAbono, setMontoAbono] = useState('');
  const [notaAbono, setNotaAbono] = useState('');

  const isLoading = userLoading || debtsLoading;

  const activas = allDebts.filter((d) => d.estado === 'activa');
  const pagadas = allDebts.filter((d) => d.estado === 'pagada');
  const debo = activas.filter((d) => d.tipo === 'debo');
  const meDeben = activas.filter((d) => d.tipo === 'me_deben');

  const deboPen = debo.filter(d => d.moneda !== 'USD').reduce((s, d) => s + Number(d.monto_pendiente), 0);
  const deboUsd = debo.filter(d => d.moneda === 'USD').reduce((s, d) => s + Number(d.monto_pendiente), 0);
  const meDebenPen = meDeben.filter(d => d.moneda !== 'USD').reduce((s, d) => s + Number(d.monto_pendiente), 0);
  const meDebenUsd = meDeben.filter(d => d.moneda === 'USD').reduce((s, d) => s + Number(d.monto_pendiente), 0);

  const fmtMulti = (pen: number, usd: number) => {
    const parts: string[] = [];
    if (pen > 0) parts.push('S/ ' + pen.toFixed(2));
    if (usd > 0) parts.push('$ ' + usd.toFixed(2));
    return parts.length > 0 ? parts.join(' + ') : 'S/ 0.00';
  };

  const tabList: { key: Tab; label: string; count: number }[] = [
    { key: 'debo', label: 'Lo que debo', count: debo.length },
    { key: 'me_deben', label: 'Me deben', count: meDeben.length },
    { key: 'pagadas', label: 'Saldadas', count: pagadas.length },
  ];

  const visibleDebts =
    tab === 'debo' ? debo : tab === 'me_deben' ? meDeben : pagadas;

  function openCreate(tipoInicial: 'debo' | 'me_deben' = 'debo') {
    setTipo(tipoInicial);
    setContraparte('');
    setMonto('');
    setMoneda('PEN');
    setDescripcion('');
    setFechaVencimiento('');
    setShowForm(true);
  }

  async function handleSave() {
    if (!contraparte.trim() || !monto) {
      toast.error('Completa el nombre y el monto');
      return;
    }
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
      toast.error('El monto debe ser mayor a 0');
      return;
    }
    try {
      await create.mutateAsync({
        tipo,
        contraparte,
        monto_original: montoNum,
        moneda,
        descripcion: descripcion || undefined,
        fecha_vencimiento: fechaVencimiento || undefined,
      } as Parameters<typeof create.mutateAsync>[0]);
      toast.success('Deuda registrada');
      setShowForm(false);
      setTab(tipo);
    } catch {
      toast.error('Error al registrar la deuda');
    }
  }

  async function handlePay() {
    if (!showPayForm) return;
    const montoNum = parseFloat(montoAbono);
    if (isNaN(montoNum) || montoNum <= 0) {
      toast.error('Ingresa un monto válido');
      return;
    }
    try {
      const result = await pay.mutateAsync({ id: showPayForm.id, monto: montoNum, nota: notaAbono || undefined });
      if (result.completada) {
        toast.success('¡Deuda saldada completamente!');
      } else {
        toast.success('Abono registrado');
      }
      setShowPayForm(null);
      setMontoAbono('');
      setNotaAbono('');
    } catch {
      toast.error('Error al registrar el abono');
    }
  }

  async function handleMarkPaid(debt: Deuda) {
    try {
      await markPaid.mutateAsync(debt.id);
      toast.success('Deuda marcada como saldada');
    } catch {
      toast.error('Error al actualizar');
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    try {
      await remove.mutateAsync(deleteId);
      toast.success('Deuda eliminada');
      setDeleteId(null);
    } catch {
      toast.error('Error al eliminar');
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[1, 2].map((i) => <Skeleton key={i} className="h-[180px] rounded-2xl" />)}
        </div>
      </div>
    );
  }

  if (!user) {
    return <EmptyState title="Inicia sesión" description="Conecta tu cuenta para ver tus deudas." />;
  }

  const sym = (d: Deuda) => d.moneda === 'USD' ? '$' : 'S/';

  return (
    <FadeIn>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#F0EFE8]">Deudas</h1>
            <p className="text-sm text-[#8A877D] mt-1">Lleva el control de lo que debes y te deben</p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => openCreate(tab === 'me_deben' ? 'me_deben' : 'debo')}
              className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-2"
            >
              <Plus className="h-4 w-4" />
              Nueva deuda
            </Button>
            <UserMenu />
          </div>
        </div>

        {/* Summary cards */}
        {(debo.length > 0 || meDeben.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="glass-card glass-card-glow p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-[rgba(216,90,48,0.12)] flex items-center justify-center shrink-0">
                <TrendingDown className="h-5 w-5 text-[#D85A30]" />
              </div>
              <div>
                <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-0.5">Lo que debes</p>
                <p className="text-xl font-bold text-[#D85A30]">{fmtMulti(deboPen, deboUsd)}</p>
                <p className="text-xs text-[#8A877D]">{debo.length} deuda{debo.length !== 1 ? 's' : ''} activa{debo.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="glass-card glass-card-glow p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-[rgba(29,158,117,0.12)] flex items-center justify-center shrink-0">
                <TrendingUp className="h-5 w-5 text-[#1D9E75]" />
              </div>
              <div>
                <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-0.5">Te deben</p>
                <p className="text-xl font-bold text-[#1D9E75]">{fmtMulti(meDebenPen, meDebenUsd)}</p>
                <p className="text-xs text-[#8A877D]">{meDeben.length} deuda{meDeben.length !== 1 ? 's' : ''} activa{meDeben.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-[rgba(255,255,255,0.03)] rounded-xl border border-[rgba(255,255,255,0.06)] w-fit">
          {tabList.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                tab === t.key
                  ? 'bg-[#1D9E75] text-white shadow'
                  : 'text-[#8A877D] hover:text-[#C8C6BC]'
              }`}
            >
              {t.label}
              {t.count > 0 && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  tab === t.key ? 'bg-white/20' : 'bg-[rgba(255,255,255,0.08)]'
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Debt cards */}
        <AnimatePresence mode="wait">
          {visibleDebts.length === 0 ? (
            <EmptyState
              key="empty"
              title={
                tab === 'debo'
                  ? 'Sin deudas pendientes'
                  : tab === 'me_deben'
                  ? 'Nadie te debe nada'
                  : 'Sin deudas saldadas'
              }
              description={
                tab === 'pagadas'
                  ? 'Las deudas saldadas aparecerán aquí.'
                  : 'Registra una deuda desde el botón "Nueva deuda" o desde WhatsApp: debo S/200 a Juan'
              }
              showWhatsApp={false}
            />
          ) : (
            <StaggerContainer key={tab} className="space-y-3">
              {visibleDebts.map((debt) => {
                const pagado = Number(debt.monto_original) - Number(debt.monto_pendiente);
                const pct = Number(debt.monto_original) > 0
                  ? Math.min(100, (pagado / Number(debt.monto_original)) * 100)
                  : 0;
                const esDebo = debt.tipo === 'debo';
                const isPagada = debt.estado === 'pagada';

                return (
                  <StaggerItem key={debt.id}>
                    <div className="glass-card glass-card-glow p-5 group">
                      <div className="flex items-start justify-between gap-3">
                        {/* Left: icon + info */}
                        <div className="flex items-start gap-3 min-w-0">
                          <div className={`mt-0.5 w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                            isPagada
                              ? 'bg-[rgba(255,255,255,0.05)]'
                              : esDebo
                              ? 'bg-[rgba(216,90,48,0.1)]'
                              : 'bg-[rgba(29,158,117,0.1)]'
                          }`}>
                            <Coins className={`h-4 w-4 ${
                              isPagada ? 'text-[#8A877D]' : esDebo ? 'text-[#D85A30]' : 'text-[#1D9E75]'
                            }`} />
                          </div>
                          <div className="min-w-0">
                            <p className={`font-semibold text-sm ${isPagada ? 'text-[#8A877D] line-through' : 'text-[#F0EFE8]'}`}>
                              {debt.contraparte}
                            </p>
                            {debt.descripcion && (
                              <p className="text-xs text-[#8A877D] truncate">{debt.descripcion}</p>
                            )}
                            {debt.fecha_vencimiento && !isPagada && (
                              <p className="text-xs text-[#EF9F27] mt-0.5">
                                Vence: {new Date(debt.fecha_vencimiento + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Right: amounts + actions */}
                        <div className="flex flex-col items-end gap-2 shrink-0">
                          <div className="text-right">
                            <p className={`text-base font-bold tabular-nums ${
                              isPagada ? 'text-[#8A877D]' : esDebo ? 'text-[#D85A30]' : 'text-[#1D9E75]'
                            }`}>
                              {sym(debt)} {Number(debt.monto_pendiente).toFixed(2)}
                            </p>
                            <p className="text-xs text-[#8A877D] tabular-nums">
                              de {sym(debt)} {Number(debt.monto_original).toFixed(2)}
                            </p>
                          </div>
                          {!isPagada && (
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => { setShowPayForm(debt); setMontoAbono(''); setNotaAbono(''); }}
                                className="px-2.5 py-1 rounded-lg text-xs font-medium bg-[rgba(29,158,117,0.12)] text-[#1D9E75] hover:bg-[rgba(29,158,117,0.2)] transition-colors"
                                title="Registrar abono"
                              >
                                Abonar
                              </button>
                              <button
                                onClick={() => setEditDebt(debt)}
                                className="p-1.5 rounded-lg text-[#8A877D] hover:text-[#EF9F27] hover:bg-[rgba(239,159,39,0.08)] transition-colors"
                                title="Editar"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleMarkPaid(debt)}
                                className="p-1.5 rounded-lg text-[#8A877D] hover:text-[#1D9E75] hover:bg-[rgba(29,158,117,0.08)] transition-colors"
                                title="Marcar como saldada"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => setDeleteId(debt.id)}
                                className="p-1.5 rounded-lg text-[#8A877D] hover:text-[#D85A30] hover:bg-[rgba(216,90,48,0.08)] transition-colors"
                                title="Eliminar"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                          {isPagada && (
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => setDeleteId(debt.id)}
                                className="p-1.5 rounded-lg text-[#8A877D] hover:text-[#D85A30] hover:bg-[rgba(216,90,48,0.08)] transition-colors"
                                title="Eliminar"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Progress bar (solo deudas activas con abonos parciales) */}
                      {!isPagada && pct > 0 && (
                        <div className="mt-3 space-y-1">
                          <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                            <motion.div
                              className={`h-full rounded-full ${esDebo ? 'bg-[#D85A30]' : 'bg-[#1D9E75]'}`}
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                            />
                          </div>
                          <p className="text-xs text-[#8A877D]">{pct.toFixed(0)}% pagado</p>
                        </div>
                      )}

                      {/* Abonos history */}
                      {debt.deuda_abonos && debt.deuda_abonos.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-[rgba(255,255,255,0.05)]">
                          <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-1.5">Historial de abonos</p>
                          <div className="space-y-1">
                            {debt.deuda_abonos.slice(0, 3).map((a) => (
                              <div key={a.id} className="flex justify-between text-xs">
                                <span className="text-[#8A877D]">
                                  {new Date(a.fecha + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}
                                  {a.nota && <span className="ml-1 text-[#6A6760]">· {a.nota}</span>}
                                </span>
                                <span className="text-[#C8C6BC] tabular-nums font-medium">
                                  {sym(debt)} {Number(a.monto).toFixed(2)}
                                </span>
                              </div>
                            ))}
                            {debt.deuda_abonos.length > 3 && (
                              <p className="text-[10px] text-[#6A6760]">+{debt.deuda_abonos.length - 3} más</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </StaggerItem>
                );
              })}
            </StaggerContainer>
          )}
        </AnimatePresence>

        {/* Dialog: nueva deuda */}
        <Dialog open={showForm} onOpenChange={setShowForm}>
          <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
            <DialogHeader>
              <DialogTitle>Nueva deuda</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {/* Tipo toggle */}
              <div>
                <label className="text-xs text-[#8A877D] mb-1.5 block">Tipo</label>
                <div className="flex gap-2">
                  {(['debo', 'me_deben'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTipo(t)}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                        tipo === t
                          ? t === 'debo'
                            ? 'bg-[rgba(216,90,48,0.15)] text-[#D85A30] ring-1 ring-[#D85A30]/40'
                            : 'bg-[rgba(29,158,117,0.15)] text-[#1D9E75] ring-1 ring-[#1D9E75]/40'
                          : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D] hover:text-[#C8C6BC]'
                      }`}
                    >
                      {t === 'debo' ? '📤 Yo debo' : '📥 Me deben'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Nombre */}
              <div>
                <label className="text-xs text-[#8A877D] mb-1.5 block">
                  {tipo === 'debo' ? 'Acreedor (a quién le debes)' : 'Deudor (quién te debe)'}
                </label>
                <input
                  type="text"
                  value={contraparte}
                  onChange={(e) => setContraparte(e.target.value)}
                  placeholder={tipo === 'debo' ? 'Ej: Juan, BCP, Mi hermana' : 'Ej: Pedro, Ana'}
                  className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                />
              </div>

              {/* Monto + Moneda */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-[#8A877D] mb-1.5 block">Monto</label>
                  <input
                    type="number"
                    value={monto}
                    onChange={(e) => setMonto(e.target.value)}
                    placeholder="200"
                    min="0.01"
                    step="0.01"
                    className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                  />
                </div>
                <div>
                  <label className="text-xs text-[#8A877D] mb-1.5 block">Moneda</label>
                  <select
                    value={moneda}
                    onChange={(e) => setMoneda(e.target.value as 'PEN' | 'USD')}
                    className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]"
                  >
                    <option value="PEN">S/ Soles</option>
                    <option value="USD">$ Dólares</option>
                  </select>
                </div>
              </div>

              {/* Descripción */}
              <div>
                <label className="text-xs text-[#8A877D] mb-1.5 block">Motivo (opcional)</label>
                <input
                  type="text"
                  value={descripcion}
                  onChange={(e) => setDescripcion(e.target.value)}
                  placeholder="Ej: la cancha, cena del viernes, préstamo personal"
                  className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                />
              </div>

              {/* Fecha de vencimiento */}
              <div>
                <label className="text-xs text-[#8A877D] mb-1.5 block">Fecha límite (opcional)</label>
                <input
                  type="date"
                  value={fechaVencimiento}
                  onChange={(e) => setFechaVencimiento(e.target.value)}
                  className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  onClick={handleSave}
                  className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
                  disabled={create.isPending}
                >
                  {create.isPending ? 'Guardando...' : 'Registrar deuda'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowForm(false)}
                  className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
                >
                  Cancelar
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Dialog: abono */}
        <Dialog open={!!showPayForm} onOpenChange={(open) => { if (!open) setShowPayForm(null); }}>
          <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
            <DialogHeader>
              <DialogTitle>
                Registrar abono · {showPayForm?.contraparte}
              </DialogTitle>
            </DialogHeader>
            {showPayForm && (
              <div className="space-y-4">
                <p className="text-sm text-[#8A877D]">
                  Pendiente: <span className="text-[#F0EFE8] font-medium">
                    {showPayForm.moneda === 'USD' ? '$' : 'S/'} {Number(showPayForm.monto_pendiente).toFixed(2)}
                  </span>
                </p>
                <div>
                  <label className="text-xs text-[#8A877D] mb-1.5 block">Monto del abono</label>
                  <input
                    type="number"
                    value={montoAbono}
                    onChange={(e) => setMontoAbono(e.target.value)}
                    placeholder={String(Number(showPayForm.monto_pendiente).toFixed(2))}
                    min="0.01"
                    step="0.01"
                    className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                  />
                </div>
                <div>
                  <label className="text-xs text-[#8A877D] mb-1.5 block">Nota (opcional)</label>
                  <input
                    type="text"
                    value={notaAbono}
                    onChange={(e) => setNotaAbono(e.target.value)}
                    placeholder="Ej: transferencia BCP"
                    className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handlePay}
                    className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
                    disabled={pay.isPending}
                  >
                    {pay.isPending ? 'Registrando...' : 'Registrar abono'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowPayForm(null)}
                    className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Dialog: confirmar eliminar */}
        <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
          <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
            <DialogHeader>
              <DialogTitle>Eliminar deuda</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-[#8A877D]">Esta acción no se puede deshacer.</p>
            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleDelete}
                className="flex-1 bg-[#D85A30] text-white hover:bg-[#D85A30]/90"
                disabled={remove.isPending}
              >
                {remove.isPending ? 'Eliminando...' : 'Eliminar'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setDeleteId(null)}
                className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
              >
                Cancelar
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        {/* Dialog: editar deuda */}
        <Dialog open={!!editDebt} onOpenChange={(open) => { if (!open) setEditDebt(null); }}>
          <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
            <DialogHeader>
              <DialogTitle>Editar deuda</DialogTitle>
            </DialogHeader>
            {editDebt && (
              <EditDebtForm
                debt={editDebt}
                onSave={async (fields) => {
                  try {
                    await update.mutateAsync({ id: editDebt.id, ...fields });
                    toast.success('Deuda actualizada');
                    setEditDebt(null);
                  } catch {
                    toast.error('Error al actualizar');
                  }
                }}
                onCancel={() => setEditDebt(null)}
                isPending={update.isPending}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>
    </FadeIn>
  );
}

function EditDebtForm({
  debt,
  onSave,
  onCancel,
  isPending,
}: {
  debt: Deuda;
  onSave: (fields: { contraparte?: string; descripcion?: string | null; fecha_vencimiento?: string | null }) => Promise<void>;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [contraparte, setContraparte] = useState(debt.contraparte);
  const [descripcion, setDescripcion] = useState(debt.descripcion || '');
  const [fechaVencimiento, setFechaVencimiento] = useState(debt.fecha_vencimiento || '');

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-[#8A877D] mb-1.5 block">
          {debt.tipo === 'debo' ? 'Acreedor' : 'Deudor'}
        </label>
        <input
          type="text"
          value={contraparte}
          onChange={(e) => setContraparte(e.target.value)}
          className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]"
        />
      </div>
      <div>
        <label className="text-xs text-[#8A877D] mb-1.5 block">Motivo</label>
        <input
          type="text"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          placeholder="Ej: la cancha, cena del viernes"
          className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
        />
      </div>
      <div>
        <label className="text-xs text-[#8A877D] mb-1.5 block">Fecha limite</label>
        <input
          type="date"
          value={fechaVencimiento}
          onChange={(e) => setFechaVencimiento(e.target.value)}
          className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]"
        />
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          onClick={() =>
            onSave({
              contraparte: contraparte.trim(),
              descripcion: descripcion.trim() || null,
              fecha_vencimiento: fechaVencimiento || null,
            })
          }
          className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
          disabled={isPending || !contraparte.trim()}
        >
          {isPending ? 'Guardando...' : 'Guardar cambios'}
        </Button>
        <Button
          variant="outline"
          onClick={onCancel}
          className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
