'use client';

import { useState, useEffect, useCallback } from 'react';
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
import type { Transaccion } from '@/lib/types';

const METODOS_PAGO = ['Debito', 'Credito', 'Yape', 'Plin', 'Efectivo'];

interface TransactionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tipo: 'gasto' | 'ingreso';
  transaction?: Transaccion | null;
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

export function TransactionForm({ open, onOpenChange, tipo, transaction }: TransactionFormProps) {
  const isEdit = !!transaction;
  const [form, setForm] = useState<FormData>(getDefaultForm(tipo));
  const [customCategoria, setCustomCategoria] = useState('');
  const [customSubcategoria, setCustomSubcategoria] = useState('');
  const [usingCustomCategoria, setUsingCustomCategoria] = useState(false);
  const [usingCustomSubcategoria, setUsingCustomSubcategoria] = useState(false);

  const selectedCat = CATEGORIAS.find((c) => c.nombre === form.categoria);
  const subcategorias = selectedCat ? selectedCat.subs : [];

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      if (transaction) {
        const isPresetCat = CATEGORIAS.some((c) => c.nombre === transaction.categoria);
        const matchedCat = CATEGORIAS.find((c) => c.nombre === transaction.categoria);
        const isPresetSub = matchedCat ? matchedCat.subs.includes(transaction.subcategoria as never) : false;

        setForm({
          monto: String(transaction.monto),
          comercio: transaction.comercio || '',
          categoria: isPresetCat ? transaction.categoria : CUSTOM_OPTION,
          subcategoria: isPresetSub ? transaction.subcategoria : (transaction.subcategoria ? CUSTOM_OPTION : ''),
          fecha: transaction.fecha,
          moneda: transaction.moneda,
          metodo_pago: transaction.metodo_pago || 'Debito',
        });
        setUsingCustomCategoria(!isPresetCat);
        setCustomCategoria(isPresetCat ? '' : transaction.categoria);
        setUsingCustomSubcategoria(!isPresetSub && !!transaction.subcategoria);
        setCustomSubcategoria(isPresetSub ? '' : (transaction.subcategoria || ''));
      } else {
        setForm(getDefaultForm(tipo));
        setUsingCustomCategoria(false);
        setUsingCustomSubcategoria(false);
        setCustomCategoria('');
        setCustomSubcategoria('');
      }
    }
  }, [open, transaction, tipo]);

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

  const handleSubmit = () => {
    const finalCategoria = usingCustomCategoria ? customCategoria : form.categoria;
    const finalSubcategoria = usingCustomSubcategoria ? customSubcategoria : form.subcategoria;

    const data = {
      tipo,
      monto: parseFloat(form.monto) || 0,
      comercio: form.comercio,
      categoria: finalCategoria,
      subcategoria: finalSubcategoria,
      fecha: form.fecha,
      moneda: form.moneda,
      metodo_pago: form.metodo_pago,
    };

    if (isEdit) {
      console.log('[TransactionForm] Editar transaccion:', { id: transaction!.id, ...data });
    } else {
      console.log('[TransactionForm] Nueva transaccion:', data);
    }

    onOpenChange(false);
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
                  <SelectValue placeholder="Seleccionar" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIAS.map((cat) => (
                    <SelectItem key={cat.nombre} value={cat.nombre}>
                      {cat.emoji} {cat.nombre}
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
                  <SelectValue placeholder="Seleccionar" />
                </SelectTrigger>
                <SelectContent>
                  {subcategorias.map((sub) => (
                    <SelectItem key={sub} value={sub}>
                      {sub.replace(/_/g, ' ')}
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
            disabled={!isValid}
            className={isIngreso ? 'bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white' : ''}
          >
            {isEdit ? 'Guardar cambios' : 'Registrar'}
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
}

export function DeleteConfirmDialog({ open, onOpenChange, transaction }: DeleteConfirmDialogProps) {
  const handleConfirm = () => {
    if (transaction) {
      console.log('[DeleteConfirmDialog] Eliminar transaccion:', transaction.id);
    }
    onOpenChange(false);
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
          <Button variant="destructive" onClick={handleConfirm}>
            Eliminar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
