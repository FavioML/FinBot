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

export function BudgetForm({ open, onOpenChange, budget, onSuccess, userCategorias, existingBudgets = [] }: BudgetFormProps) {
  const isEditing = !!budget;

  const [categoria, setCategoria] = useState<string>('');
  const [subcategoria, setSubcategoria] = useState<string>('');
  const [montoLimite, setMontoLimite] = useState<string>('');
  const [alertaPorcentaje, setAlertaPorcentaje] = useState<string>('80');

  // Merge canonical + user categories (deduplicated, case-insensitive)
  const allCategorias: CategoriaOption[] = (() => {
    const merged: CategoriaOption[] = CATEGORIAS.map(c => ({ nombre: c.nombre, emoji: c.emoji, subs: [...c.subs] }));
    if (userCategorias) {
      for (const uc of userCategorias) {
        const existing = merged.find(m => m.nombre.toLowerCase() === uc.nombre.toLowerCase());
        if (existing) {
          for (const sub of uc.subs) {
            // Case-insensitive dedup for subcategories
            if (!existing.subs.some(s => s.toLowerCase() === sub.toLowerCase())) {
              existing.subs.push(sub);
            }
          }
        } else {
          merged.push({ ...uc });
        }
      }
    }
    // Deduplicate subcategories within each category (keep first occurrence)
    for (const cat of merged) {
      const seen = new Map<string, string>();
      cat.subs = cat.subs.filter(s => {
        const lower = s.toLowerCase();
        if (seen.has(lower)) return false;
        seen.set(lower, s);
        return true;
      });
    }
    return merged;
  })();

  const selectedCat = allCategorias.find((c) => c.nombre === categoria)
    || allCategorias.find((c) => c.nombre.toLowerCase() === categoria.toLowerCase());
  const subcategorias = selectedCat?.subs ?? [];

  // Check if a budget already exists for selected category (prevent duplicates)
  const isDuplicate = !isEditing && categoria && existingBudgets.some(b =>
    b.categoria.toLowerCase() === categoria.toLowerCase() &&
    (!subcategoria || !b.subcategoria) &&
    (!b.subcategoria || b.subcategoria.toLowerCase() === (subcategoria || '').toLowerCase())
  );

  useEffect(() => {
    if (open) {
      if (budget) {
        setCategoria(budget.categoria);
        setSubcategoria(budget.subcategoria || '');
        setMontoLimite(budget.monto_limite.toString());
        setAlertaPorcentaje(budget.alerta_porcentaje.toString());
      } else {
        setCategoria('');
        setSubcategoria('');
        setMontoLimite('');
        setAlertaPorcentaje('80');
      }
    }
  }, [budget, open]);

  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!categoria || !montoLimite || saving) return;
    setSaving(true);

    try {
      const payload = {
        categoria,
        subcategoria: subcategoria || null,
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
              : 'Define un limite de gasto mensual por categoria.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Categoria */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#C8C6BC]">Categoria</label>
            <Select
              value={categoria || undefined}
              onValueChange={(val) => {
                if (val) {
                  setCategoria(val);
                  setSubcategoria('');
                }
              }}
            >
              <SelectTrigger className="w-full bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8]">
                <SelectValue placeholder="Selecciona una categoria" />
              </SelectTrigger>
              <SelectContent>
                {[...allCategorias].sort((a, b) => a.nombre.localeCompare(b.nombre)).map((cat) => (
                  <SelectItem key={cat.nombre} value={cat.nombre}>
                    {cat.emoji} {cat.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Subcategoria */}
          {categoria && subcategorias.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#C8C6BC]">
                Subcategoria <span className="text-[#8A877D]">(opcional)</span>
              </label>
              <Select
                value={subcategoria || undefined}
                onValueChange={(val) => setSubcategoria(val === '__none__' ? '' : (val || ''))}
              >
                <SelectTrigger className="w-full bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8]">
                  <SelectValue placeholder="Ninguna" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Ninguna</SelectItem>
                  {[...subcategorias].sort((a, b) => a.localeCompare(b)).map((sub) => (
                    <SelectItem key={sub} value={sub}>
                      {sub.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Monto limite */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#C8C6BC]">Monto limite (S/)</label>
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
              Ya existe un presupuesto para esta categoría. Usa una subcategoría específica o edita el existente.
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
              disabled={!categoria || !montoLimite || saving || !!isDuplicate}
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
              {budget?.categoria}
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
