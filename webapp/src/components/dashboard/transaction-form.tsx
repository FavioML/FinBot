'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
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
import type { Transaccion } from '@/lib/types';

const METODOS_PAGO = ['Debito', 'Credito', 'Yape', 'Plin', 'Efectivo'];

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
}

function getDefaultForm(tipo: 'gasto' | 'ingreso'): FormData {
  const today = new Date().toISOString().split('T')[0];
  return {
    monto: '',
    comercio: '',
    categoria: '',
    subcategoria: '',
    fecha: today,
    moneda: 'PEN',
    metodo_pago: 'Debito',
  };
}

const CUSTOM_OPTION = '__otra__';

export function TransactionForm({ open, onOpenChange, tipo, transaction, onSuccess, userCategorias }: TransactionFormProps) {
  const isEdit = !!transaction;
  const [form, setForm] = useState<FormData>(getDefaultForm(tipo));
  const [customCategoria, setCustomCategoria] = useState('');
  const [customSubcategoria, setCustomSubcategoria] = useState('');
  const [usingCustomCategoria, setUsingCustomCategoria] = useState(false);
  const [usingCustomSubcategoria, setUsingCustomSubcategoria] = useState(false);

  // Merge canonical + user categories (deduped, with all subs)
  const allCategorias = useMemo(() => {
    const merged: CatOption[] = CATEGORIAS.map(c => ({
      nombre: c.nombre,
      emoji: c.emoji,
      subs: [...c.subs],
    }));
    if (userCategorias) {
      for (const uc of userCategorias) {
        const existing = merged.find(m => m.nombre.toLowerCase() === uc.nombre.toLowerCase());
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
      const txCat = merged.find(m => m.nombre.toLowerCase() === transaction.categoria.toLowerCase());
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
    || allCategorias.find((c) => c.nombre.toLowerCase() === form.categoria.toLowerCase());
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
    };

    try {
      if (isEdit) {
        const res = await fetch('/api/transactions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: transaction!.id, ...data }),
        });
        if (!res.ok) {
          console.error('[TransactionForm] Update failed:', res.status, await res.json().catch(() => ({})));
          return;
        }
      } else {
        const res = await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          console.error('[TransactionForm] Create failed:', res.status, await res.json().catch(() => ({})));
          return;
        }
      }
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      console.error('[TransactionForm] Error:', err);
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

  const inputClasses = 'bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]';
  const selectTriggerClasses = 'w-full bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#C8C6BC]';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[#F0EFE8]">{title}</DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            {isEdit ? 'Modifica los datos de la transaccion.' : 'Registra una nueva transaccion manualmente.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Monto + Moneda */}
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="text-xs text-[#8A877D] mb-1 block">Monto</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={form.monto}
                onChange={(e) => handleChange('monto', e.target.value)}
                className={inputClasses}
              />
            </div>
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Moneda</label>
              <Select value={form.moneda} onValueChange={(v) => handleChange('moneda', v as string)}>
                <SelectTrigger className={selectTriggerClasses}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PEN">PEN</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Comercio */}
          <div>
            <label className="text-xs text-[#8A877D] mb-1 block">Comercio</label>
            <Input
              placeholder="Nombre del comercio"
              value={form.comercio}
              onChange={(e) => handleChange('comercio', e.target.value)}
              className={inputClasses}
            />
          </div>

          {/* Categoria + Subcategoria */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Categoría</label>
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
                  className={`${inputClasses} mt-1.5`}
                  autoFocus
                />
              )}
            </div>
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Subcategoría</label>
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
                  className={`${inputClasses} mt-1.5`}
                  autoFocus
                />
              )}
            </div>
          </div>

          {/* Fecha + Metodo pago */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Fecha</label>
              <Input
                type="date"
                value={form.fecha}
                onChange={(e) => handleChange('fecha', e.target.value)}
                className={inputClasses}
              />
            </div>
            <div>
              <label className="text-xs text-[#8A877D] mb-1 block">Metodo de pago</label>
              <Select value={form.metodo_pago} onValueChange={(v) => handleChange('metodo_pago', v as string)}>
                <SelectTrigger className={selectTriggerClasses}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METODOS_PAGO.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" className="text-[#C8C6BC]" />}>
            Cancelar
          </DialogClose>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || saving}
            className={isIngreso ? 'bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white' : ''}
          >
            {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Registrar'}
          </Button>
        </DialogFooter>
      </DialogContent>
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
        console.error('[DeleteConfirmDialog] Failed:', res.status);
        return;
      }
      onOpenChange(false);
      onSuccess?.();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-[#F0EFE8]">Eliminar transaccion</DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            Esta accion no se puede deshacer. Se eliminara permanentemente esta transaccion de tu historial.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" className="text-[#C8C6BC]" />}>
            Cancelar
          </DialogClose>
          <Button variant="destructive" onClick={handleConfirm} disabled={deleting}>
            {deleting ? 'Eliminando...' : 'Eliminar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
