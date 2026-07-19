'use client';

import { useMemo, useState } from 'react';
import { Repeat, Calendar, Plus, Link2, Pencil, EyeOff, RotateCcw, Unlink, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { formatCurrency } from '@/lib/utils';
import { matchCatalogo } from '@/lib/subscriptions-catalog';
import type { Transaccion } from '@/lib/types';
import { detectRecurring, type RecurringCluster } from '@/lib/recurring-detection';
import { useRecurringOverrides } from '@/lib/hooks/use-recurring-overrides';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

interface RecurringPaymentsProps {
  transactions: Transaccion[];
}

const OVERDUE_ALARM_DAYS = 40; // vencido menos que esto = alarma; más = "sin cobro reciente"

function statusLine(c: RecurringCluster): { text: string; color: string } {
  if (c.status === 'inactive') {
    return { text: 'Inactivo — sin cobro reciente', color: '#8A877D' };
  }
  const d = c.daysUntil;
  if (d < -OVERDUE_ALARM_DAYS) return { text: 'Sin cobro reciente', color: '#8A877D' };
  if (d < 0) return { text: `Esperado hace ${Math.abs(d)} dias`, color: '#EF9F27' };
  if (d === 0) return { text: 'Hoy', color: '#EF9F27' };
  return {
    text: `En ${d} dias (~dia ${c.dayOfMonth})`,
    color: d <= 5 ? '#EF9F27' : '#8A877D',
  };
}

export function RecurringPayments({ transactions }: RecurringPaymentsProps) {
  const { overrides, upsert, remove } = useRecurringOverrides('recurrente');
  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const { clusters, suggestions } = useMemo(
    () => detectRecurring(transactions, overrides, todayISO),
    [transactions, overrides, todayISO]
  );

  // Comercios candidatos para "marcar recurrente" a mano (no detectados, no en cluster)
  const addCandidates = useMemo(() => {
    const inClusters = new Set(clusters.flatMap((c) => c.variantKeys));
    const byKey = new Map<string, { label: string; count: number }>();
    for (const t of transactions) {
      if (t.tipo !== 'gasto') continue;
      const comercio = (t.comercio || '').trim();
      if (!comercio || matchCatalogo(comercio)) continue;
      const k = comercio.toLowerCase();
      if (inClusters.has(k)) continue;
      const prev = byKey.get(k);
      byKey.set(k, { label: comercio, count: (prev?.count ?? 0) + 1 });
    }
    return [...byKey.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .filter((c) => c.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [transactions, clusters]);

  // Estado del sheet (se resetea en el handler de apertura → setState en evento, sin efectos)
  const [sheetCluster, setSheetCluster] = useState<RecurringCluster | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showMerge, setShowMerge] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const openSheet = (c: RecurringCluster) => {
    setRenameValue(c.label);
    setShowMerge(false);
    setSheetCluster(c);
  };

  if (clusters.length === 0 && suggestions.length === 0) return null;

  const activeClusters = clusters.filter((c) => c.status === 'active');
  const totalMonthly = activeClusters.reduce((s, c) => s + c.amountPen, 0);
  const visible = clusters.slice(0, 6);
  const others = sheetCluster ? clusters.filter((c) => c.id !== sheetCluster.id) : [];
  const sheetHasOverride =
    !!sheetCluster && sheetCluster.variantKeys.some((k) => overrides.some((o) => o.clave_variante === k));

  // ── Acciones ──
  const runToast = (p: Promise<unknown>, msg: string) =>
    p.then(() => toast.success(msg)).catch(() => toast.error('No se pudo guardar'));

  const doMerge = (fromId: string, toId: string) => {
    runToast(upsert.mutateAsync({ clave_variante: fromId, id_canonico: toId }), 'Unido');
  };
  const doRename = (c: RecurringCluster) => {
    const label = renameValue.trim();
    if (!label || label === c.label) return;
    runToast(upsert.mutateAsync({ clave_variante: c.id, label_canonico: label }), 'Renombrado');
    setSheetCluster(null);
  };
  const doHide = (c: RecurringCluster) => {
    runToast(
      Promise.all(c.variantKeys.map((k) => upsert.mutateAsync({ clave_variante: k, oculto: true }))),
      'Oculto'
    );
    setSheetCluster(null);
  };
  const doSeparate = (c: RecurringCluster) => {
    runToast(
      Promise.all(c.variantKeys.map((k) => upsert.mutateAsync({ clave_variante: k, id_canonico: k }))),
      'Separado'
    );
    setSheetCluster(null);
  };
  const doReset = (c: RecurringCluster) => {
    runToast(Promise.all(c.variantKeys.map((k) => remove.mutateAsync(k))), 'Restablecido');
    setSheetCluster(null);
  };
  const doMarkRecurring = (key: string, label: string) => {
    runToast(upsert.mutateAsync({ clave_variante: key, es_recurrente_manual: true }), `${label} marcado como recurrente`);
    setAddOpen(false);
  };
  const doIgnoreSuggestion = (aId: string, bId: string) => {
    runToast(
      Promise.all([
        upsert.mutateAsync({ clave_variante: aId, id_canonico: aId }),
        upsert.mutateAsync({ clave_variante: bId, id_canonico: bId }),
      ]),
      'Se mantendrán separados'
    );
  };

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.35 }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-[#8A877D]" />
          <h3 className="text-sm font-medium md:text-base md:font-semibold text-[#C8C6BC]">Pagos recurrentes</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#8A877D]">~{formatCurrency(totalMonthly)}/mes</span>
          <button
            onClick={() => setAddOpen(true)}
            aria-label="Marcar un pago como recurrente"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(255,255,255,0.06)] text-[#C8C6BC] hover:bg-[rgba(29,158,117,0.15)] hover:text-[#1D9E75] transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Sugerencias de fusión */}
      {suggestions.length > 0 && (
        <div className="mb-3 space-y-2">
          {suggestions.slice(0, 3).map((s) => (
            <div
              key={`${s.aId}|${s.bId}`}
              className="rounded-lg bg-[rgba(29,158,117,0.06)] border border-[rgba(29,158,117,0.15)] px-3 py-2"
            >
              <p className="text-xs text-[#C8C6BC]">
                ¿<span className="font-medium">{s.aLabel}</span> y{' '}
                <span className="font-medium">{s.bLabel}</span> son el mismo pago?
              </p>
              <p className="text-[10px] text-[#8A877D] mt-0.5">{s.reason}</p>
              <div className="mt-1.5 flex gap-2">
                <button
                  onClick={() => doMerge(s.aId, s.bId)}
                  className="inline-flex items-center gap-1 rounded-md bg-[rgba(29,158,117,0.15)] px-2 py-1 text-[11px] font-medium text-[#1D9E75] hover:bg-[rgba(29,158,117,0.25)] transition-colors"
                >
                  <Link2 className="h-3 w-3" /> Unir
                </button>
                <button
                  onClick={() => doIgnoreSuggestion(s.aId, s.bId)}
                  className="rounded-md px-2 py-1 text-[11px] text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                >
                  No, son distintos
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filas de clusters */}
      <div className="space-y-2">
        {visible.map((c) => {
          const st = statusLine(c);
          return (
            <button
              key={c.id}
              onClick={() => openSheet(c)}
              className="w-full flex items-center justify-between rounded-lg px-3 py-2 -mx-1 hover:bg-[rgba(255,255,255,0.03)] transition-colors text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-[#F0EFE8] truncate">{c.label}</p>
                  {c.variantKeys.length > 1 && (
                    <span className="shrink-0 rounded bg-[rgba(29,158,117,0.12)] px-1.5 py-0.5 text-[9px] text-[#1D9E75]">
                      {c.variantKeys.length} nombres
                    </span>
                  )}
                  <span className="shrink-0 rounded bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 text-[9px] text-[#8A877D]">
                    {c.monthsDetected} meses
                  </span>
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <Calendar className="h-2.5 w-2.5 text-[#8A877D]" />
                  <span className="text-[10px]" style={{ color: st.color }}>
                    {st.text}
                  </span>
                </div>
              </div>
              <span
                className="text-sm font-medium tabular-nums shrink-0 ml-3"
                style={{ color: c.status === 'inactive' ? '#8A877D' : '#D85A30' }}
              >
                {formatCurrency(c.amountPen)}
              </span>
            </button>
          );
        })}
      </div>

      {clusters.length > visible.length && (
        <p className="mt-3 text-center text-[11px] text-[#8A877D]">
          y {clusters.length - visible.length} más
        </p>
      )}

      {/* Sheet de edición de cluster */}
      <Sheet open={!!sheetCluster} onOpenChange={(o) => !o && setSheetCluster(null)}>
        <SheetContent side="bottom" className="glass-card-elevated max-h-[80vh] overflow-y-auto">
          {sheetCluster && (
            <>
              <SheetHeader>
                <SheetTitle>{sheetCluster.label}</SheetTitle>
                <SheetDescription>
                  {formatCurrency(sheetCluster.amountPen)}/mes · {sheetCluster.monthsDetected} meses
                  {sheetCluster.variantKeys.length > 1 ? ` · ${sheetCluster.variantKeys.length} nombres unidos` : ''}
                </SheetDescription>
              </SheetHeader>

              <div className="px-4 pb-4 space-y-4">
                {/* Renombrar */}
                <div>
                  <label className="text-[11px] text-[#8A877D] flex items-center gap-1.5 mb-1.5">
                    <Pencil className="h-3 w-3" /> Nombre
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="form-input flex-1 text-sm"
                      placeholder="Nombre del pago"
                    />
                    <button
                      onClick={() => doRename(sheetCluster)}
                      disabled={!renameValue.trim() || renameValue.trim() === sheetCluster.label}
                      className="inline-flex items-center gap-1 rounded-lg bg-[rgba(29,158,117,0.15)] px-3 text-sm font-medium text-[#1D9E75] disabled:opacity-40 hover:bg-[rgba(29,158,117,0.25)] transition-colors"
                    >
                      <Check className="h-3.5 w-3.5" /> Guardar
                    </button>
                  </div>
                </div>

                {/* Unir con… */}
                {others.length > 0 && (
                  <div>
                    <button
                      onClick={() => setShowMerge((v) => !v)}
                      className="w-full flex items-center gap-1.5 text-[11px] text-[#8A877D] mb-1.5"
                    >
                      <Link2 className="h-3 w-3" /> Unir con otro pago
                    </button>
                    {showMerge && (
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {others.map((o) => (
                          <button
                            key={o.id}
                            onClick={() => {
                              doMerge(sheetCluster.id, o.id);
                              setSheetCluster(null);
                            }}
                            className="w-full flex items-center justify-between rounded-lg px-3 py-2 bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(255,255,255,0.05)] transition-colors text-left"
                          >
                            <span className="text-sm text-[#F0EFE8] truncate">{o.label}</span>
                            <span className="text-xs text-[#8A877D] shrink-0 ml-2">{formatCurrency(o.amountPen)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Acciones */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {sheetCluster.variantKeys.length > 1 && (
                    <button
                      onClick={() => doSeparate(sheetCluster)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[rgba(255,255,255,0.04)] px-3 py-2 text-xs text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.07)] transition-colors"
                    >
                      <Unlink className="h-3.5 w-3.5" /> Separar
                    </button>
                  )}
                  <button
                    onClick={() => doHide(sheetCluster)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[rgba(255,255,255,0.04)] px-3 py-2 text-xs text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.07)] transition-colors"
                  >
                    <EyeOff className="h-3.5 w-3.5" /> Ocultar
                  </button>
                  {sheetHasOverride && (
                    <button
                      onClick={() => doReset(sheetCluster)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[rgba(255,255,255,0.04)] px-3 py-2 text-xs text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Restablecer
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Sheet de marcar recurrente a mano */}
      <Sheet open={addOpen} onOpenChange={setAddOpen}>
        <SheetContent side="bottom" className="glass-card-elevated max-h-[70vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Marcar un pago como recurrente</SheetTitle>
            <SheetDescription>Elige un comercio que se repite pero no detectamos solo.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4 space-y-1">
            {addCandidates.length === 0 && (
              <p className="text-xs text-[#8A877D] py-4 text-center">No hay comercios sugeridos.</p>
            )}
            {addCandidates.map((cand) => (
              <button
                key={cand.key}
                onClick={() => doMarkRecurring(cand.key, cand.label)}
                className="w-full flex items-center justify-between rounded-lg px-3 py-2 hover:bg-[rgba(255,255,255,0.04)] transition-colors text-left"
              >
                <div className="min-w-0">
                  <p className="text-sm text-[#F0EFE8] truncate">{cand.label}</p>
                  <p className="text-[10px] text-[#8A877D]">{cand.count} veces</p>
                </div>
                <Plus className="h-4 w-4 text-[#1D9E75] shrink-0 ml-2" />
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </motion.div>
  );
}
