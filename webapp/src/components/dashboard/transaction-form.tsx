'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CATEGORIAS } from '@/lib/constants';
import { capitalizeDisplay } from '@/lib/format';
import { hoyPeru } from '@/lib/dates';
import type { Transaccion } from '@/lib/types';

const METODOS_PAGO = ['Debito', 'Credito', 'Yape', 'Plin', 'Transferencia', 'Efectivo'];
const BANCOS = ['BCP', 'BBVA', 'Interbank', 'Scotiabank', 'Falabella', 'Ripley', 'BanBif', 'Mibanco'];
const METODOS_CON_BANCO = ['Debito', 'Credito', 'Transferencia'];

interface CatOption {
  nombre: string;
  emoji: string;
  subs: string[];
}

interface TransactionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tipo: 'gasto' | 'ingreso';
  transaction?: Transaccion | null;
  onSuccess?: () => void;
  userCategorias?: CatOption[];
}

interface FormData {
  monto: string;
  comercio: string;
  categoria: string;
  subcategoria: string;
  fecha: string;
  moneda: string;
  metodo_pago: string;
  banco: string;
}

function getDefaultForm(tipo: 'gasto' | 'ingreso'): FormData {
  const today = hoyPeru();
  return {
    monto: '',
    comercio: '',
    categoria: '',
    subcategoria: '',
    fecha: today,
    moneda: 'PEN',
    metodo_pago: 'Debito',
    banco: '',
  };
}

const CUSTOM_OPTION = '__otra__';

/* Segmented toggle for Moneda (PEN / USD).
 * Replaces the <Select> dropdown that felt heavy for a 2-option control.
 */
function MonedaToggle({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-xl bg-[#131311] border border-[rgba(240,239,232,0.08)] p-1">
      {['PEN', 'USD'].map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => onChange(code)}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors touch-exempt ${
            value === code
              ? 'bg-[#1D9E75] text-white shadow-sm shadow-[#1D9E75]/20'
              : 'text-[#8A877D] hover:text-[#C8C6BC]'
          }`}
        >
          {code}
        </button>
      ))}
    </div>
  );
}

/* Horizontal pill row for Método de pago.
 * Replaces the <Select> dropdown with a scrollable chip row —
 * faster to pick, more discoverable, more mobile-native.
 */
function MetodoPagoPills({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((m) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className={`shrink-0 px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
              active
                ? 'bg-[#1D9E75] text-white shadow-sm shadow-[#1D9E75]/20'
                : 'bg-[#1A1A17] text-[#C8C6BC] border border-[rgba(240,239,232,0.08)] hover:border-[rgba(240,239,232,0.14)]'
            }`}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

export function TransactionForm({ open, onOpenChange, tipo, transaction, onSuccess, userCategorias }: TransactionFormProps) {
  const isEdit = !!transaction;
  const [form, setForm] = useState<FormData>(getDefaultForm(tipo));
  const [customCategoria, setCustomCategoria] = useState('');
  const [customSubcategoria, setCustomSubcategoria] = useState('');
  const [usingCustomCategoria, setUsingCustomCategoria] = useState(false);
  const [usingCustomSubcategoria, setUsingCustomSubcategoria] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Normalize for accent-insensitive matching (Alimentación vs Alimentacion)
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Merge canonical + user categories (deduped, with all subs)
  const allCategorias = useMemo(() => {
    const merged: CatOption[] = CATEGORIAS.map(c => ({
      nombre: c.nombre,
      emoji: c.emoji,
      subs: [...c.subs],
    }));
    if (userCategorias) {
      for (const uc of userCategorias) {
        const existing = merged.find(m => norm(m.nombre) === norm(uc.nombre));
        if (existing) {
          for (const sub of uc.subs) {
            if (!existing.subs.some(s => s.toLowerCase() === sub.toLowerCase())) {
              existing.subs.push(sub);
            }
          }
        } else {
          merged.push({ nombre: uc.nombre, emoji: uc.emoji, subs: [...uc.subs] });
        }
      }
    }
    // Also add the transaction's own cat/sub if not already present
    if (transaction) {
      const txCat = merged.find(m => norm(m.nombre) === norm(transaction.categoria));
      if (!txCat) {
        merged.push({ nombre: transaction.categoria, emoji: '📁', subs: transaction.subcategoria ? [transaction.subcategoria] : [] });
      } else if (transaction.subcategoria && !txCat.subs.some(s => s.toLowerCase() === transaction.subcategoria!.toLowerCase())) {
        txCat.subs.push(transaction.subcategoria);
      }
    }
    // Dedup subs and sort
    for (const cat of merged) {
      const seen = new Set<string>();
      cat.subs = cat.subs.filter(s => {
        const lower = s.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      }).sort((a, b) => a.localeCompare(b));
    }
    return merged.sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [userCategorias, transaction]);

  const selectedCat = allCategorias.find((c) => c.nombre === form.categoria)
    || allCategorias.find((c) => norm(c.nombre) === norm(form.categoria));
  const subcategorias = selectedCat ? selectedCat.subs : [];

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      if (transaction) {
        // Check if category exists in merged list
        const matchedCat = allCategorias.find(c => c.nombre.toLowerCase() === transaction.categoria.toLowerCase());
        const isKnownCat = !!matchedCat;
        const catValue = matchedCat ? matchedCat.nombre : CUSTOM_OPTION;

        // Check if subcategory exists in the matched category's subs
        const isKnownSub = matchedCat && transaction.subcategoria
          ? matchedCat.subs.some(s => s.toLowerCase() === transaction.subcategoria!.toLowerCase())
          : false;
        const subValue = isKnownSub
          ? matchedCat!.subs.find(s => s.toLowerCase() === transaction.subcategoria!.toLowerCase()) || ''
          : (transaction.subcategoria ? CUSTOM_OPTION : '');

        setForm({
          monto: String(transaction.monto),
          comercio: transaction.comercio || '',
          categoria: catValue,
          subcategoria: subValue,
          fecha: transaction.fecha,
          moneda: transaction.moneda,
          metodo_pago: transaction.metodo_pago || 'Debito',
          banco: transaction.banco || '',
        });
        setUsingCustomCategoria(!isKnownCat);
        setCustomCategoria(isKnownCat ? '' : transaction.categoria);
        setUsingCustomSubcategoria(!isKnownSub && !!transaction.subcategoria);
        setCustomSubcategoria(isKnownSub ? '' : (transaction.subcategoria || ''));
      } else {
        setForm(getDefaultForm(tipo));
        setUsingCustomCategoria(false);
        setUsingCustomSubcategoria(false);
        setCustomCategoria('');
        setCustomSubcategoria('');
      }
    }
  }, [open, transaction, tipo, allCategorias]);

  const handleChange = useCallback((field: keyof FormData, value: string) => {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      // Reset subcategoria when categoria changes
      if (field === 'categoria') {
        next.subcategoria = '';
        if (value === CUSTOM_OPTION) {
          setUsingCustomCategoria(true);
          setCustomCategoria('');
        } else {
          setUsingCustomCategoria(false);
          setCustomCategoria('');
        }
        setUsingCustomSubcategoria(false);
        setCustomSubcategoria('');
      }
      // Clear banco when switching to a method that doesn't need it
      if (field === 'metodo_pago' && !METODOS_CON_BANCO.includes(value)) {
        next.banco = '';
      }
      if (field === 'subcategoria') {
        if (value === CUSTOM_OPTION) {
          setUsingCustomSubcategoria(true);
          setCustomSubcategoria('');
        } else {
          setUsingCustomSubcategoria(false);
          setCustomSubcategoria('');
        }
      }
      return next;
    });
  }, []);

  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (saving) return;
    setSaving(true);

    const finalCategoria = usingCustomCategoria ? customCategoria : form.categoria;
    const finalSubcategoria = usingCustomSubcategoria ? customSubcategoria : form.subcategoria;

    const data = {
      tipo,
      monto: parseFloat(form.monto) || 0,
      comercio: form.comercio,
      categoria: finalCategoria,
      subcategoria: finalSubcategoria || null,
      fecha: form.fecha,
      moneda: form.moneda,
      metodo_pago: form.metodo_pago,
      banco: METODOS_CON_BANCO.includes(form.metodo_pago) ? form.banco || null : null,
    };

    try {
      if (isEdit) {
        const res = await fetch('/api/transactions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: transaction!.id, ...data }),
        });
        if (!res.ok) {
          toast.error('No se pudo actualizar la transacción');
          return;
        }
        toast.success('Transacción actualizada');
      } else {
        const res = await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          toast.error('No se pudo registrar la transacción');
          return;
        }
        toast.success('Transacción registrada');
      }
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  const finalCatValid = usingCustomCategoria ? customCategoria.trim().length > 0 : (form.categoria && form.categoria !== CUSTOM_OPTION);
  const isValid = form.monto && parseFloat(form.monto) > 0 && finalCatValid && form.fecha;

  const isIngreso = tipo === 'ingreso';
  const title = isEdit
    ? `Editar ${isIngreso ? 'ingreso' : 'gasto'}`
    : `Nuevo ${isIngreso ? 'ingreso' : 'gasto'}`;

  const inputClasses = 'form-input placeholder:text-[#8A877D]';
  const selectTriggerClasses = 'form-input w-full text-[#C8C6BC]';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="glass-card-elevated border-0 max-h-[92vh] overflow-y-auto overflow-x-hidden p-0 gap-0"
        style={{
          width: 'min(calc(100vw - 2rem), 28rem)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 min-w-0">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-xl font-semibold">
              {title}
            </DialogTitle>
            <DialogDescription className="text-[#8A877D] text-sm">
              {isEdit ? 'Modifica los datos de la transaccion.' : 'Registra una nueva transaccion manualmente.'}
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Hero monto — the protagonist. MonedaToggle lives in the label row
            so the number has the full dialog width and never overflows.
            `size={1}` on the input drops the intrinsic min-content from 20ch
            (browser default) to 1ch, letting flex shrink it correctly. */}
        <div className="px-5 pb-4 min-w-0">
          <div className="flex items-center justify-between mb-2 gap-3 min-w-0">
            <label className="text-xs font-medium uppercase tracking-wider text-[#8A877D] truncate">
              Monto ({form.moneda})
            </label>
            <MonedaToggle value={form.moneda} onChange={(v) => handleChange('moneda', v)} />
          </div>
          <div className="flex items-baseline gap-2 min-w-0 w-full">
            <span className="text-[28px] font-bold text-[#8A877D] leading-none shrink-0">
              {form.moneda === 'USD' ? '$' : 'S/'}
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              size={1}
              placeholder="0.00"
              value={form.monto}
              onChange={(e) => handleChange('monto', e.target.value)}
              inputMode="decimal"
              className="min-w-0 bg-transparent border-0 outline-none text-[40px] font-bold tracking-tight leading-none text-[#F0EFE8] placeholder:text-[#2A2A28] focus:outline-none focus-visible:outline-none focus:ring-0"
              style={{
                color: isIngreso ? '#1D9E75' : '#F0EFE8',
                width: '100%',
                minWidth: 0,
                maxWidth: '100%',
                flex: '1 1 0%',
              }}
            />
          </div>
        </div>

        {/* Fields */}
        <div className="px-5 pb-4 space-y-4">
          {/* Comercio */}
          <div>
            <label className="text-sm font-medium text-[#C8C6BC] mb-1.5 block">Comercio</label>
            <Input
              placeholder="Nombre del comercio"
              value={form.comercio}
              onChange={(e) => handleChange('comercio', e.target.value)}
              className={inputClasses}
            />
          </div>

          {/* Categoria + Subcategoria (grid 2-col desktop, stacked mobile) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-[#C8C6BC] mb-1.5 block">Categoría</label>
              <Select value={form.categoria} onValueChange={(v) => handleChange('categoria', v as string)}>
                <SelectTrigger className={selectTriggerClasses}>
                  <SelectValue placeholder="Seleccionar">
                    {usingCustomCategoria
                      ? (customCategoria ? capitalizeDisplay(customCategoria) : 'Nueva...')
                      : form.categoria
                        ? capitalizeDisplay(form.categoria)
                        : 'Seleccionar'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {allCategorias.map((cat) => (
                    <SelectItem key={cat.nombre} value={cat.nombre}>
                      {cat.emoji} {capitalizeDisplay(cat.nombre)}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_OPTION}>✏️ Otra...</SelectItem>
                </SelectContent>
              </Select>
              {usingCustomCategoria && (
                <Input
                  placeholder="Nombre de la categoría"
                  value={customCategoria}
                  onChange={(e) => setCustomCategoria(e.target.value)}
                  className={`${inputClasses} mt-2`}
                  autoFocus
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-[#C8C6BC] mb-1.5 block">Subcategoría</label>
              <Select
                value={form.subcategoria}
                onValueChange={(v) => handleChange('subcategoria', v as string)}
                disabled={subcategorias.length === 0 && !usingCustomCategoria}
              >
                <SelectTrigger className={selectTriggerClasses}>
                  <SelectValue placeholder="Seleccionar">
                    {usingCustomSubcategoria
                      ? (customSubcategoria ? capitalizeDisplay(customSubcategoria) : 'Nueva...')
                      : form.subcategoria && form.subcategoria !== CUSTOM_OPTION
                        ? capitalizeDisplay(form.subcategoria)
                        : 'Seleccionar'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {subcategorias.map((sub) => (
                    <SelectItem key={sub} value={sub}>
                      {capitalizeDisplay(sub)}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_OPTION}>✏️ Otra...</SelectItem>
                </SelectContent>
              </Select>
              {usingCustomSubcategoria && (
                <Input
                  placeholder="Nombre de la subcategoría"
                  value={customSubcategoria}
                  onChange={(e) => setCustomSubcategoria(e.target.value)}
                  className={`${inputClasses} mt-2`}
                  autoFocus
                />
              )}
            </div>
          </div>

          {/* Fecha */}
          <div>
            <label className="text-sm font-medium text-[#C8C6BC] mb-1.5 block">Fecha</label>
            <Input
              type="date"
              value={form.fecha}
              onChange={(e) => handleChange('fecha', e.target.value)}
              className={inputClasses}
            />
          </div>

          {/* Metodo pago — pills horizontal */}
          <div>
            <label className="text-sm font-medium text-[#C8C6BC] mb-1.5 block">Método de pago</label>
            <MetodoPagoPills
              value={form.metodo_pago}
              onChange={(v) => handleChange('metodo_pago', v)}
              options={METODOS_PAGO}
            />
          </div>

          {/* Banco (only if metodo needs it) */}
          {METODOS_CON_BANCO.includes(form.metodo_pago) && (
            <div>
              <label className="text-sm font-medium text-[#C8C6BC] mb-1.5 block">Banco</label>
              <Select value={form.banco} onValueChange={(v) => handleChange('banco', v as string)}>
                <SelectTrigger className={selectTriggerClasses}>
                  <SelectValue placeholder="Seleccionar" />
                </SelectTrigger>
                <SelectContent>
                  {BANCOS.map((b) => (
                    <SelectItem key={b} value={b}>{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Sticky footer */}
        <div className="sticky bottom-0 left-0 right-0 bg-[#131311] border-t border-[rgba(240,239,232,0.06)] px-5 py-4 flex gap-3">
          {isEdit && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDelete(true)}
              disabled={saving}
              className="h-12 px-3 text-[#D85A30] border-[rgba(216,90,48,0.3)] hover:bg-[rgba(216,90,48,0.08)] hover:text-[#D85A30]"
              aria-label="Eliminar transacción"
            >
              <Trash2 className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Eliminar</span>
            </Button>
          )}
          <DialogClose render={
            <Button variant="outline" className="flex-1 h-12 text-[#C8C6BC] border-[rgba(240,239,232,0.14)] hover:bg-[#1C1C19]" />
          }>
            Cancelar
          </DialogClose>
          <Button
            onClick={() => {
              if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
                navigator.vibrate(14);
              }
              handleSubmit();
            }}
            disabled={!isValid || saving}
            className="flex-1 h-12 bg-[#1D9E75] hover:bg-[#1D9E75]/90 active:scale-[0.98] transition-transform text-white font-semibold disabled:opacity-50"
          >
            {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Registrar'}
          </Button>
        </div>
      </DialogContent>

      {/* Inline delete confirmation reusing the existing dialog */}
      <DeleteConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        transaction={transaction ?? null}
        onSuccess={() => {
          onOpenChange(false);
          onSuccess?.();
        }}
      />
    </Dialog>
  );
}

// --- Delete confirmation dialog ---

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: Transaccion | null;
  onSuccess?: () => void;
}

export function DeleteConfirmDialog({ open, onOpenChange, transaction, onSuccess }: DeleteConfirmDialogProps) {
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async () => {
    if (!transaction || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/transactions?id=${transaction.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('No se pudo eliminar la transacción');
        return;
      }
      toast.success('Transacción eliminada');
      onOpenChange(false);
      onSuccess?.();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card-elevated border-0 sm:max-w-sm p-5">
        <DialogHeader>
          <DialogTitle className="text-[#F0EFE8]">Eliminar transaccion</DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            Esta accion no se puede deshacer. Se eliminara permanentemente esta transaccion de tu historial.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-3 sm:gap-2">
          <DialogClose render={
            <Button variant="outline" className="flex-1 sm:flex-initial h-12 sm:h-10 text-[#C8C6BC] border-[rgba(240,239,232,0.14)]" />
          }>
            Cancelar
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
                navigator.vibrate(20);
              }
              handleConfirm();
            }}
            disabled={deleting}
            className="flex-1 sm:flex-initial h-12 sm:h-10 active:scale-[0.98] transition-transform"
          >
            {deleting ? 'Eliminando...' : 'Eliminar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
