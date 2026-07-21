'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { DeudasSkeleton } from '@/components/dashboard/skeletons';
import { EmptyState } from '@/components/shared/empty-state';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { HeaderActions } from '@/components/dashboard/topbar';
import { useUser } from '@/lib/hooks/use-user';
import { useDebts, useDebtMutations, groupDebtsByContraparte, type Deuda } from '@/lib/hooks/use-debts';
import { useSplitExpenses, useSplitMutations, type GastoCompartido, type GastoParticipante } from '@/lib/hooks/use-split';

import { DebtSummary } from './_components/debt-summary';
import { DebtTabs, type Tab } from './_components/debt-tabs';
import { MasterList } from './_components/master-list';
import { DetailPanel } from './_components/detail-panel';
import { MobileDebtList } from './_components/mobile-debt-list';
import { SplitMasterList } from './_components/split/split-master-list';
import { SplitDetailPanel } from './_components/split/split-detail-panel';
import { SplitCard } from './_components/split/split-card';
import { NuevaDeudaDialog, AbonoDialog, EliminarDialog, EditarDeudaDialog, type NuevaDeudaPayload } from './_components/dialogs/debt-dialogs';
import { SplitCreateDialog, SplitEditDialog, SplitAbonoDialog, type SplitCreatePayload, type SplitEditPayload } from './_components/dialogs/split-dialogs';
import { resolveSelection, type Selection } from './_components/selection';
import { sortDebts } from './_lib/debt-helpers';
import type { DebtHandlers, SplitHandlers } from './_components/types';

const DESKTOP_MQ = '(min-width: 1024px)';

/** Detecta breakpoint desktop (lg) para decidir master-detail vs cards. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(DESKTOP_MQ).matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}

export default function DeudasPage() {
  const { data: user, isLoading: userLoading } = useUser();
  const { data: allDebts = [], isLoading: debtsLoading, isError: debtsError, refetch: refetchDebts } = useDebts(user?.id);
  const { create, update, pay, markPaid, remove, shareDebt } = useDebtMutations();
  const { data: splitExpenses = [], isError: splitError } = useSplitExpenses(user?.id);
  const splitMutations = useSplitMutations();

  const isDesktop = useIsDesktop();

  const [tab, setTab] = useState<Tab>('debo');
  const [showForm, setShowForm] = useState(false);
  const [createTipo, setCreateTipo] = useState<'debo' | 'me_deben'>('debo');
  const [payTarget, setPayTarget] = useState<Deuda | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Deuda | null>(null);
  const [editTarget, setEditTarget] = useState<Deuda | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  // Agrupar por persona: default ON en desktop, OFF en mobile.
  const [vistaAgrupada, setVistaAgrupada] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(DESKTOP_MQ).matches : false
  );

  // Split state
  const [showSplitForm, setShowSplitForm] = useState(false);
  const [editSplit, setEditSplit] = useState<GastoCompartido | null>(null);
  const [splitAbonoTarget, setSplitAbonoTarget] = useState<{ gastoId: string; participante: GastoParticipante } | null>(null);
  const [selectedSplitId, setSelectedSplitId] = useState<string | null>(null);

  const isLoading = userLoading || debtsLoading;

  const activas = allDebts.filter((d) => d.estado === 'activa');
  const pagadas = allDebts.filter((d) => d.estado === 'pagada');
  const debo = activas.filter((d) => d.tipo === 'debo');
  const meDeben = activas.filter((d) => d.tipo === 'me_deben');

  const deboPen = debo.filter((d) => d.moneda !== 'USD').reduce((s, d) => s + Number(d.monto_pendiente), 0);
  const deboUsd = debo.filter((d) => d.moneda === 'USD').reduce((s, d) => s + Number(d.monto_pendiente), 0);
  const meDebenPen = meDeben.filter((d) => d.moneda !== 'USD').reduce((s, d) => s + Number(d.monto_pendiente), 0);
  const meDebenUsd = meDeben.filter((d) => d.moneda === 'USD').reduce((s, d) => s + Number(d.monto_pendiente), 0);

  const tabList: { key: Tab; label: string; count: number }[] = [
    { key: 'debo', label: 'Lo que debo', count: debo.length },
    { key: 'me_deben', label: 'Me deben', count: meDeben.length },
    { key: 'pagadas', label: 'Saldadas', count: pagadas.length },
    { key: 'compartidos', label: 'Compartidos', count: splitExpenses.filter((s) => s.estado === 'activo').length },
  ];

  const rawDebts = tab === 'debo' ? debo : tab === 'me_deben' ? meDeben : pagadas;
  const mode: 'grouped' | 'flat' = vistaAgrupada && tab !== 'pagadas' ? 'grouped' : 'flat';
  const flatDebts = useMemo(() => (tab === 'pagadas' ? rawDebts : sortDebts(rawDebts)), [rawDebts, tab]);
  const groups = useMemo(() => (tab !== 'pagadas' ? groupDebtsByContraparte(rawDebts) : []), [rawDebts, tab]);

  // Selección efectiva (mantiene la previa si sigue válida, o cae a la primera).
  const effectiveSelection = useMemo(
    () => resolveSelection(selection, mode, groups, flatDebts),
    [selection, mode, groups, flatDebts]
  );

  const effectiveSplit = useMemo<GastoCompartido | null>(() => {
    if (splitExpenses.length === 0) return null;
    return splitExpenses.find((g) => g.id === selectedSplitId) ?? splitExpenses[0];
  }, [splitExpenses, selectedSplitId]);

  // ---- Handlers deuda ----
  function handleCreate(payload: NuevaDeudaPayload) {
    create
      .mutateAsync(payload as Parameters<typeof create.mutateAsync>[0])
      .then(() => {
        toast.success(payload.es_recurrente ? 'Compromiso recurrente registrado' : 'Deuda registrada');
        setShowForm(false);
        setTab(payload.tipo);
      })
      .catch(() => toast.error('Error al registrar la deuda'));
  }

  function handlePay(monto: number, nota: string) {
    if (!payTarget) return;
    pay
      .mutateAsync({ id: payTarget.id, monto, nota: nota || undefined })
      .then((result) => {
        const r = result as { completada?: boolean; recurrenteRenovada?: boolean };
        if (r.recurrenteRenovada) toast.success('Periodo cobrado · siguiente pago abierto');
        else if (r.completada) toast.success('¡Deuda saldada completamente!');
        else toast.success('Abono registrado');
        setPayTarget(null);
      })
      .catch(() => toast.error('Error al registrar el abono'));
  }

  async function handleMarkPaid(debt: Deuda) {
    try {
      await markPaid.mutateAsync(debt.id);
      toast.success('Deuda marcada como saldada');
    } catch {
      toast.error('Error al actualizar');
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    remove
      .mutateAsync(deleteTarget.id)
      .then(() => {
        toast.success('Deuda eliminada');
        setDeleteTarget(null);
      })
      .catch(() => toast.error('Error al eliminar'));
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

  const debtHandlers: DebtHandlers = {
    onAbonar: (debt) => setPayTarget(debt),
    onShare: handleShare,
    onEdit: (debt) => setEditTarget(debt),
    onMarkPaid: handleMarkPaid,
    onDelete: (debt) => setDeleteTarget(debt),
  };

  // ---- Handlers split ----
  function handleCreateSplit(payload: SplitCreatePayload) {
    splitMutations.create
      .mutateAsync(payload)
      .then(() => {
        toast.success('Gasto compartido creado');
        setShowSplitForm(false);
      })
      .catch(() => toast.error('Error al crear gasto compartido'));
  }

  function handleUpdateSplit(payload: SplitEditPayload) {
    splitMutations.update
      .mutateAsync(payload)
      .then(() => {
        toast.success('Gasto compartido actualizado');
        setEditSplit(null);
      })
      .catch(() => toast.error('Error al actualizar'));
  }

  function handleSplitAbono(monto: number) {
    if (!splitAbonoTarget) return;
    splitMutations.addPayment
      .mutateAsync({ gasto_id: splitAbonoTarget.gastoId, participante_id: splitAbonoTarget.participante.id, monto })
      .then(() => {
        toast.success('Abono registrado');
        setSplitAbonoTarget(null);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Error al registrar abono'));
  }

  async function handleDeleteSplit(id: string) {
    try {
      await splitMutations.remove.mutateAsync(id);
      toast.success('Gasto compartido eliminado');
    } catch {
      toast.error('Error al eliminar');
    }
  }

  async function handleToggleSplitPaid(gastoId: string, participante: GastoParticipante) {
    if (participante.pagado) {
      try {
        await splitMutations.markPaid.mutateAsync({ gasto_id: gastoId, participante_id: participante.id, pagado: false });
        toast.success('Marcado como pendiente');
      } catch {
        toast.error('Error al actualizar');
      }
    } else {
      setSplitAbonoTarget({ gastoId, participante });
    }
  }

  async function handleShareSplit(gastoId: string, participante: GastoParticipante) {
    try {
      if (participante.invite_code) {
        await navigator.clipboard.writeText(`${window.location.origin}/join/gasto/${participante.invite_code}`);
        toast.success('Link copiado al portapapeles');
        return;
      }
      const result = await splitMutations.shareSplit.mutateAsync({ gasto_id: gastoId, participante_id: participante.id });
      await navigator.clipboard.writeText(result.link);
      toast.success('Link generado y copiado');
    } catch {
      toast.error('Error al generar link');
    }
  }

  const splitHandlers: SplitHandlers = {
    onEdit: (gasto) => setEditSplit(gasto),
    onDelete: handleDeleteSplit,
    onTogglePaid: handleToggleSplitPaid,
    onShare: (gastoId, participante) => handleShareSplit(gastoId, participante),
  };

  if (isLoading) return <DeudasSkeleton />;

  if (!user) {
    return <EmptyState title="Inicia sesión" description="Conecta tu cuenta para ver tus deudas." />;
  }

  // Error de carga (fetch de deudas falló y no hay cache): error explícito en vez de un
  // "sin deudas pendientes" que parezca que el usuario perdió su data. Con cache, normal.
  if (debtsError && allDebts.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="glass-card w-full max-w-md space-y-4 p-8 text-center">
          <h2 className="text-xl font-bold text-[#F0EFE8]">No pudimos cargar tus deudas</h2>
          <p className="text-sm text-[#8A877D]">Revisa tu conexión e inténtalo de nuevo. Tu información está a salvo.</p>
          <button
            onClick={() => refetchDebts()}
            className="inline-flex items-center gap-2 rounded-lg bg-[#1D9E75] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1D9E75]/90"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const gridCls = 'grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] gap-4';
  const detailWrapCls = 'lg:sticky lg:top-2 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pr-1';

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
              onClick={() => { setCreateTipo(tab === 'me_deben' ? 'me_deben' : 'debo'); setShowForm(true); }}
              size="sm"
              className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Nueva deuda</span>
              <span className="sm:hidden">Nueva</span>
            </Button>
          </HeaderActions>
        </div>

        {/* Summary */}
        {(debo.length > 0 || meDeben.length > 0) && (
          <DebtSummary
            deboPen={deboPen}
            deboUsd={deboUsd}
            deboCount={debo.length}
            meDebenPen={meDebenPen}
            meDebenUsd={meDebenUsd}
            meDebenCount={meDeben.length}
          />
        )}

        {/* Tabs */}
        <DebtTabs
          tab={tab}
          onTabChange={setTab}
          tabList={tabList}
          showGroupToggle={tab !== 'pagadas' && tab !== 'compartidos'}
          vistaAgrupada={vistaAgrupada}
          onToggleAgrupada={() => setVistaAgrupada((v) => !v)}
        />

        {/* Content */}
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            {tab === 'compartidos' ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-[#8A877D]">Divide gastos y lleva la cuenta de quien pago</p>
                  <Button onClick={() => setShowSplitForm(true)} className="bg-[#EF9F27] text-white hover:bg-[#EF9F27]/90 gap-2 text-xs" size="sm">
                    <Plus className="h-3.5 w-3.5" />
                    Dividir gasto
                  </Button>
                </div>
                {splitError && splitExpenses.length === 0 ? (
                  <EmptyState
                    title="No pudimos cargar tus gastos compartidos"
                    description="Revisa tu conexion e intentalo de nuevo. Tu informacion esta a salvo."
                    showWhatsApp={false}
                  />
                ) : splitExpenses.length === 0 ? (
                  <EmptyState
                    title="Sin gastos compartidos"
                    description="Divide un gasto grupal desde el boton o desde WhatsApp: pague 300 la cena entre 4"
                    showWhatsApp={false}
                  />
                ) : isDesktop ? (
                  <div className={gridCls}>
                    <SplitMasterList gastos={splitExpenses} selectedId={effectiveSplit?.id ?? null} onSelect={setSelectedSplitId} />
                    <div className={detailWrapCls}>
                      <SplitDetailPanel gasto={effectiveSplit} handlers={splitHandlers} />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {splitExpenses.map((gasto) => (
                      <SplitCard key={gasto.id} gasto={gasto} handlers={splitHandlers} />
                    ))}
                  </div>
                )}
              </div>
            ) : rawDebts.length === 0 ? (
              <EmptyState
                title={tab === 'debo' ? 'Sin deudas pendientes' : tab === 'me_deben' ? 'Nadie te debe nada' : 'Sin deudas saldadas'}
                description={
                  tab === 'pagadas'
                    ? 'Las deudas saldadas aparecerán aquí.'
                    : 'Registra una deuda desde el botón "Nueva deuda" o desde WhatsApp: debo S/200 a Juan'
                }
                showWhatsApp={false}
              />
            ) : isDesktop ? (
              <div className={gridCls}>
                <MasterList
                  mode={mode}
                  groups={groups}
                  debts={flatDebts}
                  tab={tab as 'debo' | 'me_deben' | 'pagadas'}
                  selection={effectiveSelection}
                  onSelect={setSelection}
                />
                <div className={detailWrapCls}>
                  <DetailPanel selection={effectiveSelection} groups={groups} debts={flatDebts} tab={tab as 'debo' | 'me_deben' | 'pagadas'} handlers={debtHandlers} />
                </div>
              </div>
            ) : (
              <MobileDebtList mode={mode} groups={groups} debts={flatDebts} tab={tab as 'debo' | 'me_deben' | 'pagadas'} handlers={debtHandlers} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Dialogs */}
      <NuevaDeudaDialog open={showForm} onOpenChange={setShowForm} initialTipo={createTipo} onSubmit={handleCreate} isPending={create.isPending} />
      <AbonoDialog debt={payTarget} onClose={() => setPayTarget(null)} onSubmit={handlePay} isPending={pay.isPending} />
      <EliminarDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={handleDelete} isPending={remove.isPending} />
      <EditarDeudaDialog
        debt={editTarget}
        onClose={() => setEditTarget(null)}
        onSave={(fields) => {
          if (!editTarget) return;
          update
            .mutateAsync({ id: editTarget.id, ...fields })
            .then(() => { toast.success('Deuda actualizada'); setEditTarget(null); })
            .catch(() => toast.error('Error al actualizar'));
        }}
        isPending={update.isPending}
      />
      <SplitCreateDialog open={showSplitForm} onOpenChange={setShowSplitForm} onSubmit={handleCreateSplit} isPending={splitMutations.create.isPending} />
      <SplitEditDialog gasto={editSplit} onClose={() => setEditSplit(null)} onSubmit={handleUpdateSplit} isPending={splitMutations.update.isPending} />
      <SplitAbonoDialog target={splitAbonoTarget} onClose={() => setSplitAbonoTarget(null)} onSubmit={handleSplitAbono} isPending={splitMutations.addPayment.isPending} />
    </FadeIn>
  );
}
