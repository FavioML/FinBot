'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Check, TrendingDown, TrendingUp, Coins, Pencil, Users, AlertTriangle, Clock, Edit2, Calendar, Share2, Link2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { DeudasSkeleton } from '@/components/dashboard/skeletons';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { useUser } from '@/lib/hooks/use-user';
import { useDebts, useDebtMutations, groupDebtsByContraparte, type Deuda, type DebtGroup, type Frecuencia } from '@/lib/hooks/use-debts';
import { Repeat, Infinity as InfinityIcon } from 'lucide-react';
import { useSplitExpenses, useSplitMutations, type GastoCompartido, type GastoParticipante } from '@/lib/hooks/use-split';
import { formatCurrency } from '@/lib/utils';
import { HeaderActions } from '@/components/dashboard/topbar';

export const dynamic = 'force-dynamic';

type Tab = 'debo' | 'me_deben' | 'pagadas' | 'compartidos';

export default function DeudasPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const { data: allDebts = [], isLoading: debtsLoading } = useDebts(user?.id);
  const { create, update, pay, markPaid, remove, shareDebt } = useDebtMutations();
  const { data: splitExpenses = [] } = useSplitExpenses(user?.id);
  const splitMutations = useSplitMutations();

  const [tab, setTab] = useState<Tab>('debo');
  const [showForm, setShowForm] = useState(false);
  const [showSplitForm, setShowSplitForm] = useState(false);
  const [splitDesc, setSplitDesc] = useState('');
  const [splitMonto, setSplitMonto] = useState('');
  const [splitNumPersonas, setSplitNumPersonas] = useState('2');
  const [splitNames, setSplitNames] = useState<string[]>([]);
  const [splitFechaLimite, setSplitFechaLimite] = useState('');
  // Edit split state
  const [editSplit, setEditSplit] = useState<GastoCompartido | null>(null);
  const [editSplitDesc, setEditSplitDesc] = useState('');
  const [editSplitFecha, setEditSplitFecha] = useState('');
  const [editSplitNotas, setEditSplitNotas] = useState('');
  const [editSplitNames, setEditSplitNames] = useState<{ id: string; nombre: string }[]>([]);
  // Split abono state
  const [splitAbonoTarget, setSplitAbonoTarget] = useState<{ gastoId: string; participante: GastoParticipante } | null>(null);
  const [splitAbonoMonto, setSplitAbonoMonto] = useState('');

  const [showPayForm, setShowPayForm] = useState<Deuda | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editDebt, setEditDebt] = useState<Deuda | null>(null);
  const [vistaAgrupada, setVistaAgrupada] = useState(false);

  // Form state — nueva deuda
  const [tipo, setTipo] = useState<'debo' | 'me_deben'>('debo');
  const [contraparte, setContraparte] = useState('');
  const [monto, setMonto] = useState('');
  const [moneda, setMoneda] = useState<'PEN' | 'USD'>('PEN');
  const [descripcion, setDescripcion] = useState('');
  const [fechaVencimiento, setFechaVencimiento] = useState('');
  const [esRecurrente, setEsRecurrente] = useState(false);
  const [frecuencia, setFrecuencia] = useState<Frecuencia>('mensual');
  const [fechaFin, setFechaFin] = useState('');

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
    { key: 'compartidos', label: 'Compartidos', count: splitExpenses.filter(s => s.estado === 'activo').length },
  ];

  // Vencimiento badge helper
  function getVencimientoBadge(debt: Deuda): { label: string; color: string; bgColor: string; priority: number } | null {
    if (!debt.fecha_vencimiento || debt.estado === 'pagada') return null;
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const venc = new Date(debt.fecha_vencimiento + 'T12:00:00');
    venc.setHours(0, 0, 0, 0);
    const diffDays = Math.round((venc.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return { label: `Vencida hace ${Math.abs(diffDays)}d`, color: '#D85A30', bgColor: 'rgba(216,90,48,0.12)', priority: 0 };
    if (diffDays === 0) return { label: 'Vence hoy', color: '#D85A30', bgColor: 'rgba(216,90,48,0.12)', priority: 1 };
    if (diffDays <= 3) return { label: `Vence en ${diffDays}d`, color: '#EF9F27', bgColor: 'rgba(239,159,39,0.12)', priority: 2 };
    if (diffDays <= 7) return { label: `Vence en ${diffDays}d`, color: '#8A877D', bgColor: 'rgba(138,135,125,0.1)', priority: 3 };
    return null;
  }

  // Sort by vencimiento (urgent first), then by monto_pendiente
  function sortDebts(debts: Deuda[]): Deuda[] {
    return [...debts].sort((a, b) => {
      const badgeA = getVencimientoBadge(a);
      const badgeB = getVencimientoBadge(b);
      const prioA = badgeA ? badgeA.priority : 99;
      const prioB = badgeB ? badgeB.priority : 99;
      if (prioA !== prioB) return prioA - prioB;
      return Number(b.monto_pendiente) - Number(a.monto_pendiente);
    });
  }

  const rawDebts = tab === 'debo' ? debo : tab === 'me_deben' ? meDeben : pagadas;
  const visibleDebts = tab === 'pagadas' ? rawDebts : sortDebts(rawDebts);
  const groupedDebts = tab !== 'pagadas' ? groupDebtsByContraparte(rawDebts) : [];

  function openCreate(tipoInicial: 'debo' | 'me_deben' = 'debo') {
    setTipo(tipoInicial);
    setContraparte('');
    setMonto('');
    setMoneda('PEN');
    setDescripcion('');
    setFechaVencimiento('');
    setEsRecurrente(false);
    setFrecuencia('mensual');
    setFechaFin('');
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
    if (esRecurrente && fechaFin && fechaVencimiento && fechaFin < fechaVencimiento) {
      toast.error('La fecha límite debe ser posterior al primer pago');
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
        es_recurrente: esRecurrente,
        frecuencia: esRecurrente ? frecuencia : null,
        fecha_fin: esRecurrente ? (fechaFin || null) : null,
      } as Parameters<typeof create.mutateAsync>[0]);
      toast.success(esRecurrente ? 'Compromiso recurrente registrado' : 'Deuda registrada');
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
      const result = await pay.mutateAsync({ id: showPayForm.id, monto: montoNum, nota: notaAbono || undefined }) as { completada?: boolean; recurrenteRenovada?: boolean };
      if (result.recurrenteRenovada) {
        toast.success('Periodo cobrado · siguiente pago abierto');
      } else if (result.completada) {
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

  async function handleShare(debt: Deuda) {
    try {
      const result = await shareDebt.mutateAsync(debt.id);
      await navigator.clipboard.writeText(result.link);
      toast.success('Link copiado al portapapeles');
    } catch {
      toast.error('Error al generar el link');
    }
  }

  async function handleCreateSplit() {
    if (!splitDesc.trim() || !splitMonto) {
      toast.error('Completa descripcion y monto');
      return;
    }
    const total = parseFloat(splitMonto);
    const num = parseInt(splitNumPersonas) || 2;
    if (isNaN(total) || total <= 0 || num < 2) {
      toast.error('Monto y numero de personas invalidos');
      return;
    }
    const perPerson = Math.round((total / num) * 100) / 100;
    const names = splitNames.filter(n => n.trim());
    const participantes = Array.from({ length: num - 1 }, (_, i) => ({
      nombre: names[i] || `Persona ${i + 1}`,
      monto_debe: perPerson,
    }));

    try {
      await splitMutations.create.mutateAsync({
        descripcion: splitDesc.trim(),
        monto_total: total,
        fecha_limite: splitFechaLimite || undefined,
        participantes,
      });
      toast.success('Gasto compartido creado');
      setShowSplitForm(false);
      setSplitDesc('');
      setSplitMonto('');
      setSplitNumPersonas('2');
      setSplitNames([]);
      setSplitFechaLimite('');
    } catch {
      toast.error('Error al crear gasto compartido');
    }
  }

  async function handleTogglePaid(gastoId: string, participanteId: string, currentPagado: boolean) {
    try {
      await splitMutations.markPaid.mutateAsync({ gasto_id: gastoId, participante_id: participanteId, pagado: !currentPagado });
      toast.success(currentPagado ? 'Marcado como pendiente' : 'Marcado como pagado');
    } catch {
      toast.error('Error al actualizar');
    }
  }

  async function handleShareSplit(gastoId: string, participanteId: string, existingCode: string | null) {
    try {
      if (existingCode) {
        const baseUrl = window.location.origin;
        await navigator.clipboard.writeText(`${baseUrl}/join/gasto/${existingCode}`);
        toast.success('Link copiado al portapapeles');
        return;
      }
      const result = await splitMutations.shareSplit.mutateAsync({ gasto_id: gastoId, participante_id: participanteId });
      await navigator.clipboard.writeText(result.link);
      toast.success('Link generado y copiado');
    } catch {
      toast.error('Error al generar link');
    }
  }

  async function handleSplitAbono() {
    if (!splitAbonoTarget) return;
    const monto = parseFloat(splitAbonoMonto);
    if (!monto || monto <= 0) { toast.error('Monto invalido'); return; }
    try {
      await splitMutations.addPayment.mutateAsync({
        gasto_id: splitAbonoTarget.gastoId,
        participante_id: splitAbonoTarget.participante.id,
        monto,
      });
      toast.success('Abono registrado');
      setSplitAbonoTarget(null);
      setSplitAbonoMonto('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al registrar abono');
    }
  }

  async function handleDeleteSplit(id: string) {
    try {
      await splitMutations.remove.mutateAsync(id);
      toast.success('Gasto compartido eliminado');
    } catch {
      toast.error('Error al eliminar');
    }
  }

  function openEditSplit(gasto: GastoCompartido) {
    setEditSplit(gasto);
    setEditSplitDesc(gasto.descripcion);
    setEditSplitFecha(gasto.fecha_limite || '');
    setEditSplitNotas(gasto.notas || '');
    setEditSplitNames((gasto.gasto_participantes || []).map(p => ({ id: p.id, nombre: p.nombre })));
  }

  async function handleUpdateSplit() {
    if (!editSplit || !editSplitDesc.trim()) {
      toast.error('La descripcion no puede estar vacia');
      return;
    }
    try {
      await splitMutations.update.mutateAsync({
        id: editSplit.id,
        descripcion: editSplitDesc.trim(),
        fecha_limite: editSplitFecha || null,
        notas: editSplitNotas || null,
        participantes: editSplitNames,
      });
      toast.success('Gasto compartido actualizado');
      setEditSplit(null);
    } catch {
      toast.error('Error al actualizar');
    }
  }

  if (isLoading) {
    return (
      <DeudasSkeleton />
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
          <HeaderActions>
            <Button
              onClick={() => openCreate(tab === 'me_deben' ? 'me_deben' : 'debo')}
              size="sm"
              className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Nueva deuda</span>
              <span className="sm:hidden">Nueva</span>
            </Button>
          </HeaderActions>
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

        {/* Tabs + grouped toggle */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="overflow-x-auto max-w-full -mx-1 px-1">
          <div className="flex gap-1 p-1 bg-[rgba(255,255,255,0.03)] rounded-xl border border-[rgba(255,255,255,0.06)] w-max min-w-0">
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
          </div>
          {tab !== 'pagadas' && (
            <button
              onClick={() => setVistaAgrupada(!vistaAgrupada)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                vistaAgrupada
                  ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75] ring-1 ring-[#1D9E75]/30'
                  : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D] hover:text-[#C8C6BC]'
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Agrupar por persona
            </button>
          )}
        </div>

        {/* Debt cards / Split section */}
        <AnimatePresence mode="wait">
          {tab === 'compartidos' ? (
            <motion.div
              key="compartidos"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-4"
            >
              {/* Header + create button */}
              <div className="flex items-center justify-between">
                <p className="text-sm text-[#8A877D]">Divide gastos y lleva la cuenta de quien pago</p>
                <Button
                  onClick={() => { setShowSplitForm(true); setSplitDesc(''); setSplitMonto(''); setSplitNumPersonas('2'); setSplitNames([]); }}
                  className="bg-[#EF9F27] text-white hover:bg-[#EF9F27]/90 gap-2 text-xs"
                  size="sm"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Dividir gasto
                </Button>
              </div>

              {/* Split expenses list */}
              {splitExpenses.length === 0 ? (
                <EmptyState
                  title="Sin gastos compartidos"
                  description="Divide un gasto grupal desde el boton o desde WhatsApp: pague 300 la cena entre 4"
                  showWhatsApp={false}
                />
              ) : (
                <div className="space-y-3">
                  {splitExpenses.map((gasto) => {
                    const parts = gasto.gasto_participantes || [];
                    const pagados = parts.filter(p => p.pagado).length;
                    const total = parts.length;
                    const allPaid = pagados === total && total > 0;

                    return (
                      <div key={gasto.id} className={`glass-card glass-card-glow p-5 group ${allPaid ? 'opacity-60' : ''}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-sm text-[#F0EFE8]">{gasto.descripcion}</p>
                              {allPaid && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[rgba(29,158,117,0.12)] text-[#1D9E75]">Liquidado</span>
                              )}
                            </div>
                            <p className="text-xs text-[#8A877D] mt-0.5">
                              {new Date(gasto.fecha + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}
                              {' · '}{pagados}/{total} pagados
                            </p>
                            {gasto.fecha_limite && (
                              <p className="text-xs text-[#EF9F27] flex items-center gap-1 mt-0.5">
                                <Calendar className="h-3 w-3" />
                                Vence: {new Date(gasto.fecha_limite + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}
                              </p>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-base font-bold text-[#EF9F27] tabular-nums">
                              {gasto.moneda === 'USD' ? '$' : 'S/'} {Number(gasto.monto_total).toFixed(2)}
                            </p>
                            <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-all mt-1">
                              <button
                                onClick={() => openEditSplit(gasto)}
                                className="p-1 rounded text-[#8A877D] hover:text-[#EF9F27]"
                                title="Editar"
                              >
                                <Edit2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteSplit(gasto.id)}
                                className="p-1 rounded text-[#8A877D] hover:text-[#D85A30]"
                                title="Eliminar"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Participants */}
                        <div className="mt-3 space-y-1.5">
                          {parts.map((p) => {
                            const montoPagado = Number(p.monto_pagado || 0);
                            const montoDebe = Number(p.monto_debe);
                            const pendiente = montoDebe - montoPagado;
                            const pctPagado = montoDebe > 0 ? Math.min(100, (montoPagado / montoDebe) * 100) : 0;
                            const sym = gasto.moneda === 'USD' ? '$' : 'S/';

                            return (
                              <div key={p.id} className="py-1.5 border-t border-[rgba(255,255,255,0.04)] first:border-0">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <button
                                      onClick={() => {
                                        if (p.pagado) {
                                          handleTogglePaid(gasto.id, p.id, true);
                                        } else {
                                          setSplitAbonoTarget({ gastoId: gasto.id, participante: p });
                                          setSplitAbonoMonto(pendiente.toFixed(2));
                                        }
                                      }}
                                      className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                                        p.pagado
                                          ? 'bg-[#1D9E75] border-[#1D9E75]'
                                          : 'border-[rgba(255,255,255,0.15)] hover:border-[#1D9E75]'
                                      }`}
                                    >
                                      {p.pagado && <Check className="h-3 w-3 text-white" />}
                                    </button>
                                    <div className="min-w-0">
                                      <span className={`text-xs ${p.pagado ? 'text-[#8A877D] line-through' : 'text-[#C8C6BC]'}`}>
                                        {p.nombre}
                                      </span>
                                      {montoPagado > 0 && !p.pagado && (
                                        <div className="flex items-center gap-1.5 mt-0.5">
                                          <div className="w-16 h-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                                            <div className="h-full rounded-full bg-[#1D9E75]" style={{ width: `${pctPagado}%` }} />
                                          </div>
                                          <span className="text-[10px] text-[#8A877D]">
                                            {sym} {montoPagado.toFixed(2)} de {sym} {montoDebe.toFixed(2)}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {!p.pagado && (
                                      <button
                                        onClick={() => handleShareSplit(gasto.id, p.id, p.invite_code)}
                                        className="p-1 rounded transition-colors hover:bg-[rgba(255,255,255,0.04)]"
                                        title={p.invite_code ? 'Copiar link de cobro' : 'Generar link de cobro'}
                                      >
                                        {p.invite_code
                                          ? <Link2 className="h-3 w-3 text-[#1D9E75]" />
                                          : <Share2 className="h-3 w-3 text-[#8A877D]" />
                                        }
                                      </button>
                                    )}
                                    <span className={`text-xs font-medium tabular-nums ${p.pagado ? 'text-[#8A877D]' : 'text-[#EF9F27]'}`}>
                                      {sym} {montoDebe.toFixed(2)}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Split edit dialog */}
              <Dialog open={!!editSplit} onOpenChange={(open) => { if (!open) setEditSplit(null); }}>
                <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
                  <DialogHeader>
                    <DialogTitle>Editar gasto compartido</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-[#8A877D] mb-1.5 block">Descripcion</label>
                      <input
                        type="text"
                        value={editSplitDesc}
                        onChange={(e) => setEditSplitDesc(e.target.value)}
                        className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#EF9F27]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#8A877D] mb-1.5 block">Fecha limite de cobro (opcional)</label>
                      <input
                        type="date"
                        value={editSplitFecha}
                        onChange={(e) => setEditSplitFecha(e.target.value)}
                        className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#EF9F27]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#8A877D] mb-1.5 block">Participantes</label>
                      <div className="space-y-2">
                        {editSplitNames.map((p, i) => (
                          <div key={p.id} className="flex items-center gap-2">
                            <span className="text-xs text-[#8A877D] w-20 shrink-0">Persona {i + 1}</span>
                            <input
                              type="text"
                              value={p.nombre}
                              onChange={(e) => {
                                const updated = [...editSplitNames];
                                updated[i] = { ...updated[i], nombre: e.target.value };
                                setEditSplitNames(updated);
                              }}
                              className="flex-1 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-1.5 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#EF9F27]"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-[#8A877D] mb-1.5 block">Notas (opcional)</label>
                      <input
                        type="text"
                        value={editSplitNotas}
                        onChange={(e) => setEditSplitNotas(e.target.value)}
                        placeholder="Ej: Cena de cumpleanos"
                        className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#EF9F27]"
                      />
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button
                        onClick={handleUpdateSplit}
                        className="flex-1 bg-[#EF9F27] text-white hover:bg-[#EF9F27]/90"
                        disabled={splitMutations.update.isPending}
                      >
                        {splitMutations.update.isPending ? 'Guardando...' : 'Guardar cambios'}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setEditSplit(null)}
                        className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Split create dialog */}
              <Dialog open={showSplitForm} onOpenChange={setShowSplitForm}>
                <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
                  <DialogHeader>
                    <DialogTitle>Dividir gasto</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-[#8A877D] mb-1.5 block">Descripcion</label>
                      <input
                        type="text"
                        value={splitDesc}
                        onChange={(e) => setSplitDesc(e.target.value)}
                        placeholder="Ej: Cena del viernes, Uber, etc."
                        className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-[#8A877D] mb-1.5 block">Monto total (S/)</label>
                        <input
                          type="number"
                          value={splitMonto}
                          onChange={(e) => setSplitMonto(e.target.value)}
                          placeholder="300"
                          className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-[#8A877D] mb-1.5 block">Personas (incluido tu)</label>
                        <input
                          type="number"
                          value={splitNumPersonas}
                          onChange={(e) => {
                            setSplitNumPersonas(e.target.value);
                            const n = parseInt(e.target.value) || 2;
                            setSplitNames(prev => {
                              const newNames = [...prev];
                              while (newNames.length < n - 1) newNames.push('');
                              return newNames.slice(0, n - 1);
                            });
                          }}
                          min="2"
                          max="20"
                          className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                        />
                      </div>
                    </div>

                    {/* Per person amount preview */}
                    {splitMonto && splitNumPersonas && (
                      <p className="text-xs text-[#8A877D] bg-[rgba(239,159,39,0.06)] rounded-lg px-3 py-2">
                        Cada persona: <span className="text-[#EF9F27] font-medium">
                          S/ {(parseFloat(splitMonto) / (parseInt(splitNumPersonas) || 2)).toFixed(2)}
                        </span>
                      </p>
                    )}

                    {/* Fecha limite */}
                    <div>
                      <label className="text-xs text-[#8A877D] mb-1.5 block">Fecha limite de cobro (opcional)</label>
                      <input
                        type="date"
                        value={splitFechaLimite}
                        onChange={(e) => setSplitFechaLimite(e.target.value)}
                        className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#EF9F27]"
                      />
                    </div>

                    {/* Participant names */}
                    {Array.from({ length: Math.max(0, (parseInt(splitNumPersonas) || 2) - 1) }, (_, i) => (
                      <div key={i}>
                        <label className="text-xs text-[#8A877D] mb-1 block">Persona {i + 1}</label>
                        <input
                          type="text"
                          value={splitNames[i] || ''}
                          onChange={(e) => {
                            const newNames = [...splitNames];
                            newNames[i] = e.target.value;
                            setSplitNames(newNames);
                          }}
                          placeholder={`Nombre persona ${i + 1}`}
                          className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]"
                        />
                      </div>
                    ))}

                    <div className="flex gap-2 pt-1">
                      <Button
                        onClick={handleCreateSplit}
                        className="flex-1 bg-[#EF9F27] text-white hover:bg-[#EF9F27]/90"
                        disabled={splitMutations.create.isPending}
                      >
                        {splitMutations.create.isPending ? 'Creando...' : 'Crear gasto compartido'}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setShowSplitForm(false)}
                        className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Split abono dialog */}
              <Dialog open={!!splitAbonoTarget} onOpenChange={(open) => { if (!open) { setSplitAbonoTarget(null); setSplitAbonoMonto(''); } }}>
                <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-xs">
                  <DialogHeader>
                    <DialogTitle>Registrar pago</DialogTitle>
                  </DialogHeader>
                  {splitAbonoTarget && (() => {
                    const p = splitAbonoTarget.participante;
                    const pendiente = Number(p.monto_debe) - Number(p.monto_pagado || 0);
                    return (
                      <div className="space-y-4">
                        <p className="text-xs text-[#8A877D]">
                          {p.nombre} — pendiente: <span className="text-[#EF9F27]">S/ {pendiente.toFixed(2)}</span>
                        </p>
                        <div>
                          <label className="text-xs text-[#8A877D] mb-1.5 block">Monto del abono</label>
                          <input
                            type="number"
                            step="0.01"
                            value={splitAbonoMonto}
                            onChange={(e) => setSplitAbonoMonto(e.target.value)}
                            placeholder={pendiente.toFixed(2)}
                            className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#EF9F27]"
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            onClick={handleSplitAbono}
                            className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
                            disabled={splitMutations.addPayment.isPending}
                          >
                            {splitMutations.addPayment.isPending ? 'Registrando...' : 'Registrar abono'}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => { setSplitAbonoTarget(null); setSplitAbonoMonto(''); }}
                            className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]"
                          >
                            Cancelar
                          </Button>
                        </div>
                      </div>
                    );
                  })()}
                </DialogContent>
              </Dialog>
            </motion.div>
          ) : visibleDebts.length === 0 ? (
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
          ) : vistaAgrupada && tab !== 'pagadas' ? (
            /* Grouped view by contraparte */
            <StaggerContainer key={`${tab}-grouped`} className="space-y-4">
              {groupedDebts.map((group) => (
                <StaggerItem key={group.contraparte}>
                  <div className="glass-card glass-card-glow p-5">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-[rgba(29,158,117,0.1)] flex items-center justify-center">
                          <Users className="h-4 w-4 text-[#1D9E75]" />
                        </div>
                        <div>
                          <p className="font-semibold text-sm text-[#F0EFE8]">{group.contraparte}</p>
                          <p className="text-[10px] text-[#8A877D]">{group.debts.length} deuda{group.debts.length !== 1 ? 's' : ''}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        {group.pen > 0 && (
                          <p className={`text-sm font-bold tabular-nums ${tab === 'debo' ? 'text-[#D85A30]' : 'text-[#1D9E75]'}`}>
                            S/ {group.pen.toFixed(2)}
                          </p>
                        )}
                        {group.usd > 0 && (
                          <p className={`text-sm font-bold tabular-nums ${tab === 'debo' ? 'text-[#D85A30]' : 'text-[#1D9E75]'}`}>
                            $ {group.usd.toFixed(2)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="space-y-2 pl-10">
                      {group.debts.map((debt) => {
                        const badge = getVencimientoBadge(debt);
                        return (
                          <div key={debt.id} className="flex items-center justify-between text-xs py-1.5 border-t border-[rgba(255,255,255,0.04)] first:border-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[#8A877D] truncate">{debt.descripcion || 'Sin motivo'}</span>
                              {badge && (
                                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: badge.bgColor, color: badge.color }}>
                                  {badge.label}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[#C8C6BC] font-medium tabular-nums">
                                {debt.moneda === 'USD' ? '$' : 'S/'} {Number(debt.monto_pendiente).toFixed(2)}
                              </span>
                              <button
                                onClick={() => { setShowPayForm(debt); setMontoAbono(''); setNotaAbono(''); }}
                                className="px-2 py-0.5 rounded text-[10px] font-medium bg-[rgba(29,158,117,0.12)] text-[#1D9E75] hover:bg-[rgba(29,158,117,0.2)] transition-colors"
                              >
                                Abonar
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
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
                            <p className={`font-semibold text-sm ${isPagada ? 'text-[#8A877D] line-through' : 'text-[#F0EFE8]'} flex items-center gap-1.5 flex-wrap`}>
                              {debt.contraparte}
                              {debt.es_recurrente && debt.frecuencia && (
                                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-[rgba(29,158,117,0.12)] text-[#1D9E75] font-medium">
                                  <Repeat className="h-3 w-3" />
                                  {debt.frecuencia === 'semanal' ? 'Semanal'
                                    : debt.frecuencia === 'quincenal' ? 'Quincenal'
                                    : debt.frecuencia === 'mensual' ? 'Mensual'
                                    : 'Anual'}
                                </span>
                              )}
                            </p>
                            {debt.descripcion && (
                              <p className="text-xs text-[#8A877D] truncate">{debt.descripcion}</p>
                            )}
                            {debt.es_recurrente && !isPagada && (
                              <p className="text-[10px] text-[#8A877D] mt-0.5">
                                {debt.fecha_fin
                                  ? `Hasta ${new Date(debt.fecha_fin + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' })}`
                                  : 'Indefinido'}
                                {(debt.periodos_pagados || 0) > 0 && ` · ${debt.periodos_pagados} periodo${(debt.periodos_pagados || 0) !== 1 ? 's' : ''} cobrado${(debt.periodos_pagados || 0) !== 1 ? 's' : ''}`}
                              </p>
                            )}
                            {debt.fecha_vencimiento && !isPagada && (() => {
                              const badge = getVencimientoBadge(debt);
                              return badge ? (
                                <span
                                  className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full mt-1"
                                  style={{ backgroundColor: badge.bgColor, color: badge.color }}
                                >
                                  {badge.priority <= 1 ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                                  {badge.label}
                                </span>
                              ) : (
                                <p className="text-xs text-[#8A877D] mt-0.5">
                                  Vence: {new Date(debt.fecha_vencimiento + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' })}
                                </p>
                              );
                            })()}
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
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
                              <button
                                onClick={() => { setShowPayForm(debt); setMontoAbono(''); setNotaAbono(''); }}
                                className="px-2.5 py-1 rounded-lg text-xs font-medium bg-[rgba(29,158,117,0.12)] text-[#1D9E75] hover:bg-[rgba(29,158,117,0.2)] transition-colors"
                                title="Registrar abono"
                              >
                                Abonar
                              </button>
                              {debt.tipo === 'me_deben' && (
                                <button
                                  onClick={() => handleShare(debt)}
                                  className={`p-1.5 rounded-lg transition-colors ${
                                    debt.invite_code
                                      ? 'text-[#1D9E75] hover:bg-[rgba(29,158,117,0.08)]'
                                      : 'text-[#8A877D] hover:text-[#1D9E75] hover:bg-[rgba(29,158,117,0.08)]'
                                  }`}
                                  title={debt.invite_code ? 'Copiar link de cobro' : 'Generar link de cobro'}
                                >
                                  {debt.invite_code ? <Link2 className="h-3.5 w-3.5" /> : <Share2 className="h-3.5 w-3.5" />}
                                </button>
                              )}
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
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
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

              {/* Fecha del próximo pago (renombrado cuando es recurrente) */}
              <div>
                <label className="text-xs text-[#8A877D] mb-1.5 block">
                  {esRecurrente ? 'Próximo pago' : 'Fecha límite (opcional)'}
                </label>
                <input
                  type="date"
                  value={fechaVencimiento}
                  onChange={(e) => setFechaVencimiento(e.target.value)}
                  className="w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]"
                />
              </div>

              {/* Toggle recurrente */}
              <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-3 space-y-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={esRecurrente}
                    onChange={(e) => setEsRecurrente(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-[#1D9E75]"
                  />
                  <span className="flex-1">
                    <span className="text-sm text-[#F0EFE8] font-medium flex items-center gap-1.5">
                      <Repeat className="h-3.5 w-3.5 text-[#1D9E75]" />
                      Compromiso recurrente
                    </span>
                    <span className="text-xs text-[#8A877D] block mt-0.5">
                      {tipo === 'debo'
                        ? 'Pagas un monto fijo cada periodo (ej: alquiler).'
                        : 'Te pagan un monto fijo cada periodo (ej: mensualidad).'}
                    </span>
                  </span>
                </label>

                {esRecurrente && (
                  <div className="pl-6 space-y-3">
                    <div>
                      <label className="text-xs text-[#8A877D] mb-1.5 block">Frecuencia</label>
                      <div className="grid grid-cols-4 gap-1.5">
                        {(['semanal', 'quincenal', 'mensual', 'anual'] as const).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setFrecuencia(f)}
                            className={`py-1.5 rounded-md text-xs font-medium transition-all ${
                              frecuencia === f
                                ? 'bg-[#1D9E75] text-white'
                                : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D] hover:text-[#C8C6BC]'
                            }`}
                          >
                            {f === 'semanal' ? 'Semanal' : f === 'quincenal' ? 'Quincenal' : f === 'mensual' ? 'Mensual' : 'Anual'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-[#8A877D] mb-1.5 block flex items-center justify-between">
                        <span>Hasta</span>
                        {!fechaFin && (
                          <span className="text-[10px] text-[#1D9E75] flex items-center gap-1">
                            <InfinityIcon className="h-3 w-3" /> indefinido
                          </span>
                        )}
                      </label>
                      <div className="flex gap-1.5">
                        <input
                          type="date"
                          value={fechaFin}
                          onChange={(e) => setFechaFin(e.target.value)}
                          className="flex-1 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] outline-none focus:border-[#1D9E75]"
                        />
                        {fechaFin && (
                          <button
                            type="button"
                            onClick={() => setFechaFin('')}
                            className="px-2 rounded-lg text-xs text-[#8A877D] hover:text-[#C8C6BC] bg-[rgba(255,255,255,0.04)]"
                          >
                            Limpiar
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  onClick={handleSave}
                  className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
                  disabled={create.isPending}
                >
                  {create.isPending ? 'Guardando...' : esRecurrente ? 'Crear compromiso' : 'Registrar deuda'}
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
                {/* Quick % buttons */}
                <div>
                  <label className="text-xs text-[#8A877D] mb-1.5 block">Abono rápido</label>
                  <div className="grid grid-cols-4 gap-2">
                    {[25, 50, 75, 100].map((pct) => {
                      const val = (Number(showPayForm.monto_pendiente) * pct / 100);
                      return (
                        <button
                          key={pct}
                          onClick={() => setMontoAbono(val.toFixed(2))}
                          className={`py-2 rounded-lg text-xs font-medium transition-all ${
                            montoAbono === val.toFixed(2)
                              ? 'bg-[rgba(29,158,117,0.2)] text-[#1D9E75] ring-1 ring-[#1D9E75]/40'
                              : 'bg-[rgba(255,255,255,0.04)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.08)]'
                          }`}
                        >
                          <span className="block text-sm font-bold">{pct}%</span>
                          <span className="block text-[10px] text-[#8A877D] tabular-nums">
                            {showPayForm.moneda === 'USD' ? '$' : 'S/'} {val.toFixed(2)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#8A877D] mb-1.5 block">Monto personalizado</label>
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
