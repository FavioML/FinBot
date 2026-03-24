'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { CATEGORIAS, getCategoriaEmoji } from '@/lib/constants';
import type { Presupuesto } from '@/lib/types';

export interface CategoriaOption {
  nombre: string;
  emoji: string;
  subs: string[];
}

interface BudgetFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: Presupuesto | null;
  onSuccess?: () => void;
  userCategorias?: CategoriaOption[];
  existingBudgets?: Presupuesto[];
}

function mergeAndDedup(userCategorias?: CategoriaOption[]): CategoriaOption[] {
  const merged: CategoriaOption[] = CATEGORIAS.map(c => ({
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
            existing.subs.push(sub.toLowerCase());
          }
        }
      } else {
        merged.push({
          nombre: uc.nombre,
          emoji: uc.emoji,
          subs: [...new Set(uc.subs.map(s => s.toLowerCase()))],
        });
      }
    }
  }

  // Final dedup: all subs lowercase, unique
  for (const cat of merged) {
    const seen = new Set<string>();
    cat.subs = cat.subs.filter(s => {
      const lower = s.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
    cat.subs.sort((a, b) => a.localeCompare(b));
  }

  return merged.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function BudgetForm({ open, onOpenChange, budget, onSuccess, userCategorias, existingBudgets = [] }: BudgetFormProps) {
  const isEditing = !!budget;

  const [categoria, setCategoria] = useState('');
  const [customCategoria, setCustomCategoria] = useState('');
  const [subcategoria, setSubcategoria] = useState('');
  const [customSubcategoria, setCustomSubcategoria] = useState('');
  const [montoLimite, setMontoLimite] = useState('');
  const [alertaPorcentaje, setAlertaPorcentaje] = useState('80');
  const [saving, setSaving] = useState(false);

  const allCategorias = mergeAndDedup(userCategorias);
  const isCustomCat = categoria === '__custom__';
  const effectiveCategoria = isCustomCat ? customCategoria.trim() : categoria;

  const selectedCat = allCategorias.find(c => c.nombre === categoria)
    || allCategorias.find(c => c.nombre.toLowerCase() === categoria.toLowerCase());
  const subcategorias = selectedCat?.subs ?? [];

  const isCustomSub = subcategoria === '__custom__';
  const effectiveSubcategoria = isCustomSub ? customSubcategoria.trim().toLowerCase() : (subcategoria === '__none__' ? '' : subcategoria);

  // Check duplicate: same category (and no subcategoria, or same subcategoria)
  const isDuplicate = !isEditing && effectiveCategoria && existingBudgets.some(b => {
    const catMatch = b.categoria.toLowerCase() === effectiveCategoria.toLowerCase();
    if (!catMatch) return false;
    // If user is setting a subcategory budget, check that specific sub
    if (effectiveSubcategoria) {
      return (b.subcategoria || '').toLowerCase() === effectiveSubcategoria.toLowerCase();
    }
    // If user is setting a general category budget, check if one exists without sub
    return !b.subcategoria;
  });

  useEffect(() => {
    if (open) {
      if (budget) {
        setCategoria(budget.categoria);
        setCustomCategoria('');
        setSubcategoria(budget.subcategoria || '');
        setCustomSubcategoria('');
        setMontoLimite(budget.monto_limite.toString());
        setAlertaPorcentaje(budget.alerta_porcentaje.toString());
      } else {
        setCategoria('');
        setCustomCategoria('');
        setSubcategoria('');
        setCustomSubcategoria('');
        setMontoLimite('');
        setAlertaPorcentaje('80');
      }
    }
  }, [budget, open]);

  async function handleSubmit() {
    if (!effectiveCategoria || !montoLimite || saving) return;
    setSaving(true);

    try {
      const payload = {
        categoria: effectiveCategoria,
        subcategoria: effectiveSubcategoria || null,
        monto_limite: parseFloat(montoLimite) || 0,
        alerta_porcentaje: parseInt(alertaPorcentaje, 10) || 80,
      };

      const res = isEditing
        ? await fetch('/api/budgets', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: budget!.id, ...payload }),
          })
        : await fetch('/api/budgets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

      if (!res.ok) {
        const err = await res.json();
        console.error('Error guardando presupuesto:', err);
        return;
      }

      onOpenChange(false);
      onSuccess?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[#F0EFE8]">
            {isEditing ? 'Editar presupuesto' : 'Nuevo presupuesto'}
          </DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            {isEditing
              ? 'Modifica los datos de tu presupuesto.'
              : 'Define un límite de gasto mensual por categoría o subcategoría.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Categoria */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#C8C6BC]">Categoría</label>
            <Select
              value={categoria || undefined}
              onValueChange={(val) => {
                if (val) {
                  setCategoria(val);
                  setSubcategoria('');
                  setCustomSubcategoria('');
                  if (val !== '__custom__') setCustomCategoria('');
                }
              }}
            >
              <SelectTrigger className="w-full bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8]">
                <SelectValue placeholder="Selecciona una categoría" />
              </SelectTrigger>
              <SelectContent>
                {allCategorias.map((cat) => (
                  <SelectItem key={cat.nombre} value={cat.nombre}>
                    {cat.emoji} {cat.nombre}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">
                  <span className="flex items-center gap-1.5">
                    <Plus className="h-3.5 w-3.5" /> Nueva categoría...
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {isCustomCat && (
              <Input
                placeholder="Nombre de la categoría"
                value={customCategoria}
                onChange={(e) => setCustomCategoria(e.target.value)}
                className="mt-1 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
                autoFocus
              />
            )}
          </div>

          {/* Subcategoria */}
          {(effectiveCategoria && !isCustomCat && subcategorias.length > 0) && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#C8C6BC]">
                Subcategoría <span className="text-[#8A877D]">(opcional)</span>
              </label>
              <Select
                value={subcategoria || undefined}
                onValueChange={(val) => {
                  setSubcategoria(val || '');
                  if (val !== '__custom__') setCustomSubcategoria('');
                }}
              >
                <SelectTrigger className="w-full bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8]">
                  <SelectValue placeholder="Ninguna (categoría general)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Ninguna (categoría general)</SelectItem>
                  {subcategorias.map((sub) => (
                    <SelectItem key={sub} value={sub}>
                      {capitalize(sub.replace(/_/g, ' '))}
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">
                    <span className="flex items-center gap-1.5">
                      <Plus className="h-3.5 w-3.5" /> Nueva subcategoría...
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              {isCustomSub && (
                <Input
                  placeholder="Nombre de la subcategoría"
                  value={customSubcategoria}
                  onChange={(e) => setCustomSubcategoria(e.target.value)}
                  className="mt-1 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
                  autoFocus
                />
              )}
            </div>
          )}

          {/* Monto limite */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#C8C6BC]">Monto límite (S/)</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="500.00"
              value={montoLimite}
              onChange={(e) => setMontoLimite(e.target.value)}
              className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
            />
          </div>

          {/* Alerta porcentaje */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#C8C6BC]">Alerta al (%)</label>
            <Input
              type="number"
              min="1"
              max="100"
              placeholder="80"
              value={alertaPorcentaje}
              onChange={(e) => setAlertaPorcentaje(e.target.value)}
              className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
            />
            <p className="text-xs text-[#8A877D]">
              Recibirás una alerta cuando tu gasto supere este porcentaje.
            </p>
          </div>

          {/* Duplicate warning */}
          {isDuplicate && (
            <p className="text-xs text-[#EF9F27]">
              Ya existe un presupuesto para {effectiveCategoria}{effectiveSubcategoria ? ` → ${effectiveSubcategoria}` : ''}. Edita el existente.
            </p>
          )}

          {/* Buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              className="text-[#C8C6BC]"
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button
              className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
              onClick={handleSubmit}
              disabled={!effectiveCategoria || !montoLimite || saving || !!isDuplicate}
            >
              {saving ? 'Guardando...' : isEditing ? 'Guardar cambios' : 'Crear presupuesto'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* Delete confirmation dialog */
interface DeleteBudgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget: Presupuesto | null;
  onSuccess?: () => void;
}

export function DeleteBudgetDialog({ open, onOpenChange, budget, onSuccess }: DeleteBudgetDialogProps) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!budget || deleting) return;
    setDeleting(true);

    try {
      const res = await fetch(`/api/budgets?id=${budget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        console.error('Error eliminando presupuesto:', err);
        return;
      }
      onOpenChange(false);
      onSuccess?.();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[#F0EFE8]">
            ¿Eliminar este presupuesto?
          </DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            Se eliminará el presupuesto de{' '}
            <span className="text-[#C8C6BC] font-medium">
              {budget?.categoria}{budget?.subcategoria ? ` → ${budget.subcategoria}` : ''}
            </span>
            . Esta acción no se puede deshacer.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            className="text-[#C8C6BC]"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? 'Eliminando...' : 'Eliminar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
