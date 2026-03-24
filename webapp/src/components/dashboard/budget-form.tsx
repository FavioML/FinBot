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
import { Plus, Trash2 } from 'lucide-react';
import { CATEGORIAS, getCategoriaEmoji } from '@/lib/constants';
import { capitalizeDisplay } from '@/lib/format';
import type { Presupuesto } from '@/lib/types';

export interface CategoriaOption {
  nombre: string;
  emoji: string;
  subs: string[];
}

interface SubBudgetRow {
  subcategoria: string;
  customSub: string;
  monto: string;
}

interface BudgetFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: Presupuesto | null;
  onSuccess?: () => void;
  userCategorias?: CategoriaOption[];
  existingBudgets?: Presupuesto[];
  groupSubBudgets?: Presupuesto[];
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

export function BudgetForm({ open, onOpenChange, budget, onSuccess, userCategorias, existingBudgets = [], groupSubBudgets }: BudgetFormProps) {
  const isEditing = !!budget;

  const [categoria, setCategoria] = useState('');
  const [customCategoria, setCustomCategoria] = useState('');
  const [montoLimite, setMontoLimite] = useState('');
  const [alertaPorcentaje, setAlertaPorcentaje] = useState('80');
  const [saving, setSaving] = useState(false);

  // For editing single budget with subcategory
  const [subcategoria, setSubcategoria] = useState('');
  const [customSubcategoria, setCustomSubcategoria] = useState('');

  // For creating: multi-subcategory rows
  const [subRows, setSubRows] = useState<SubBudgetRow[]>([]);

  const allCategorias = mergeAndDedup(userCategorias);
  const isCustomCat = categoria === '__custom__';
  const effectiveCategoria = isCustomCat ? customCategoria.trim() : categoria;

  const selectedCat = allCategorias.find(c => c.nombre === categoria)
    || allCategorias.find(c => c.nombre.toLowerCase() === categoria.toLowerCase());
  const subcategorias = selectedCat?.subs ?? [];

  // For edit mode subcategory
  const isCustomSub = subcategoria === '__custom__';
  const effectiveSubcategoria = isCustomSub ? customSubcategoria.trim().toLowerCase() : (subcategoria === '__none__' || !subcategoria ? '' : subcategoria);

  // Check duplicates
  const catDuplicate = !isEditing && effectiveCategoria && existingBudgets.some(b =>
    b.categoria.toLowerCase() === effectiveCategoria.toLowerCase() && !b.subcategoria
  );

  useEffect(() => {
    if (open) {
      if (budget) {
        setCategoria(budget.categoria);
        setCustomCategoria('');
        setSubcategoria(budget.subcategoria || '');
        setCustomSubcategoria('');
        setMontoLimite(budget.monto_limite.toString());
        setAlertaPorcentaje(budget.alerta_porcentaje.toString());
        // Populate sub-budget rows from groupSubBudgets when editing a grouped budget
        if (groupSubBudgets && groupSubBudgets.length > 0) {
          setSubRows(groupSubBudgets.map(sb => ({
            subcategoria: sb.subcategoria || '',
            customSub: '',
            monto: sb.monto_limite.toString(),
          })));
        } else {
          setSubRows([]);
        }
      } else {
        setCategoria('');
        setCustomCategoria('');
        setSubcategoria('');
        setCustomSubcategoria('');
        setMontoLimite('');
        setAlertaPorcentaje('80');
        setSubRows([]);
      }
    }
  }, [budget, open, groupSubBudgets]);

  function addSubRow() {
    setSubRows(prev => [...prev, { subcategoria: '', customSub: '', monto: '' }]);
  }

  function updateSubRow(index: number, field: keyof SubBudgetRow, value: string) {
    setSubRows(prev => prev.map((row, i) => i === index ? { ...row, [field]: value } : row));
  }

  function removeSubRow(index: number) {
    setSubRows(prev => prev.filter((_, i) => i !== index));
  }

  function getEffectiveSub(row: SubBudgetRow): string {
    if (row.subcategoria === '__custom__') return row.customSub.trim().toLowerCase();
    return row.subcategoria;
  }

  // Get subs already used in rows (to prevent duplicate selection)
  function getUsedSubs(): Set<string> {
    const used = new Set<string>();
    for (const row of subRows) {
      const eff = getEffectiveSub(row);
      if (eff) used.add(eff.toLowerCase());
    }
    // Also check existing budgets for this category
    for (const b of existingBudgets) {
      if (b.categoria.toLowerCase() === effectiveCategoria.toLowerCase() && b.subcategoria) {
        used.add(b.subcategoria.toLowerCase());
      }
    }
    return used;
  }

  async function handleSubmit() {
    if (!effectiveCategoria || saving) return;
    setSaving(true);

    try {
      if (isEditing) {
        // Update main (total) budget
        const payload = {
          id: budget!.id,
          categoria: effectiveCategoria,
          subcategoria: effectiveSubcategoria || null,
          monto_limite: parseFloat(montoLimite) || 0,
          alerta_porcentaje: parseInt(alertaPorcentaje, 10) || 80,
        };
        console.log('[BudgetForm] Updating budget:', payload);
        const res = await fetch('/api/budgets', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.error('[BudgetForm] Update failed:', res.status, errData);
          return;
        }

        // Update/create/delete sub-budgets
        const existingSubs = groupSubBudgets || [];
        for (let i = 0; i < subRows.length; i++) {
          const row = subRows[i];
          const effSub = getEffectiveSub(row);
          if (!effSub || !row.monto) continue;

          const existingSub = existingSubs[i];
          if (existingSub) {
            // Update existing sub-budget
            const subPayload = {
              id: existingSub.id,
              categoria: effectiveCategoria,
              subcategoria: effSub,
              monto_limite: parseFloat(row.monto) || 0,
              alerta_porcentaje: parseInt(alertaPorcentaje, 10) || 80,
            };
            console.log('[BudgetForm] Updating sub-budget:', subPayload);
            const subRes = await fetch('/api/budgets', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(subPayload),
            });
            if (!subRes.ok) {
              const errData = await subRes.json().catch(() => ({}));
              console.error('[BudgetForm] Sub-budget update failed:', subRes.status, errData);
            }
          } else {
            // Create new sub-budget
            const subPayload = {
              categoria: effectiveCategoria,
              subcategoria: effSub,
              monto_limite: parseFloat(row.monto) || 0,
              alerta_porcentaje: parseInt(alertaPorcentaje, 10) || 80,
            };
            console.log('[BudgetForm] Creating new sub-budget:', subPayload);
            const subRes = await fetch('/api/budgets', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(subPayload),
            });
            if (!subRes.ok) {
              const errData = await subRes.json().catch(() => ({}));
              console.error('[BudgetForm] Sub-budget create failed:', subRes.status, errData);
            }
          }
        }

        // Delete sub-budgets that were removed
        for (let i = subRows.length; i < existingSubs.length; i++) {
          const toDelete = existingSubs[i];
          console.log('[BudgetForm] Deleting removed sub-budget:', toDelete.id);
          await fetch(`/api/budgets?id=${toDelete.id}`, { method: 'DELETE' });
        }
      } else {
        // Create: main category budget + sub-budgets
        const budgetsToCreate = [];

        // Main category budget (if monto provided and no duplicate)
        if (montoLimite && !catDuplicate) {
          budgetsToCreate.push({
            categoria: effectiveCategoria,
            subcategoria: null,
            monto_limite: parseFloat(montoLimite) || 0,
            alerta_porcentaje: parseInt(alertaPorcentaje, 10) || 80,
          });
        }

        // Sub-category budgets
        for (const row of subRows) {
          const effSub = getEffectiveSub(row);
          if (effSub && row.monto) {
            budgetsToCreate.push({
              categoria: effectiveCategoria,
              subcategoria: effSub,
              monto_limite: parseFloat(row.monto) || 0,
              alerta_porcentaje: parseInt(alertaPorcentaje, 10) || 80,
            });
          }
        }

        console.log('[BudgetForm] Creating budgets:', budgetsToCreate);

        // Create all budgets sequentially
        for (const payload of budgetsToCreate) {
          console.log('[BudgetForm] Creating:', payload);
          const res = await fetch('/api/budgets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            console.error('[BudgetForm] Create failed:', res.status, errData, 'Payload:', payload);
          }
        }
      }

      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      console.error('[BudgetForm] Unexpected error:', err);
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = effectiveCategoria && (montoLimite || subRows.some(r => r.monto && getEffectiveSub(r))) && !saving;

  // Helper to get capitalized display for a subcategory value in Select trigger
  function getSubDisplayText(value: string): string {
    if (!value || value === '__custom__' || value === '__none__') return '';
    return capitalizeDisplay(value);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[#F0EFE8]">
            {isEditing ? 'Editar presupuesto' : 'Nuevo presupuesto'}
          </DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            {isEditing
              ? 'Modifica los datos de tu presupuesto.'
              : 'Define límites de gasto por categoría y subcategorías.'}
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
                  setSubRows([]);
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

          {/* Edit mode: single subcategory (hidden when editing grouped budget with sub-rows) */}
          {isEditing && effectiveCategoria && subcategorias.length > 0 && !(groupSubBudgets && groupSubBudgets.length > 0) && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#C8C6BC]">Subcategoría</label>
              <Select
                value={subcategoria || undefined}
                onValueChange={(val) => {
                  setSubcategoria(val || '');
                  if (val !== '__custom__') setCustomSubcategoria('');
                }}
              >
                <SelectTrigger className="w-full bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8]">
                  <SelectValue>
                    {subcategoria && subcategoria !== '__custom__' && subcategoria !== '__none__'
                      ? capitalizeDisplay(subcategoria)
                      : subcategoria === '__none__'
                        ? 'Ninguna (categoría general)'
                        : 'Ninguna'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Ninguna (categoría general)</SelectItem>
                  {subcategorias.map((sub) => (
                    <SelectItem key={sub} value={sub}>{capitalizeDisplay(sub)}</SelectItem>
                  ))}
                  <SelectItem value="__custom__">
                    <span className="flex items-center gap-1.5"><Plus className="h-3.5 w-3.5" /> Nueva...</span>
                  </SelectItem>
                </SelectContent>
              </Select>
              {isCustomSub && (
                <Input placeholder="Nombre" value={customSubcategoria} onChange={(e) => setCustomSubcategoria(e.target.value)}
                  className="mt-1 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]" />
              )}
            </div>
          )}

          {/* Monto limite (category-level) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#C8C6BC]">
              Monto límite {!isEditing ? 'de la categoría' : ''} (S/)
            </label>
            <Input
              type="number" min="0" step="0.01" placeholder="500.00"
              value={montoLimite} onChange={(e) => setMontoLimite(e.target.value)}
              className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
            />
            {catDuplicate && !isEditing && (
              <p className="text-xs text-[#EF9F27]">Ya existe un presupuesto general para {effectiveCategoria}. Se omitirá este campo.</p>
            )}
          </div>

          {/* Sub-category budgets (create mode OR edit mode when category has subcategories) */}
          {((!isEditing && effectiveCategoria && subcategorias.length > 0) ||
            (isEditing && effectiveCategoria && (subcategorias.length > 0 || (groupSubBudgets && groupSubBudgets.length > 0)))) && (
            <div className="flex flex-col gap-3 pt-2 border-t border-[rgba(255,255,255,0.06)]">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-[#C8C6BC]">Presupuestos por subcategoría</label>
                <Button
                  variant="ghost" size="sm"
                  className="text-[#1D9E75] text-xs h-7 px-2"
                  onClick={addSubRow}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Agregar
                </Button>
              </div>

              {subRows.length === 0 && (
                <p className="text-xs text-[#8A877D]">Opcional: define límites por subcategoría dentro de {effectiveCategoria}.</p>
              )}

              {subRows.map((row, idx) => {
                const usedSubs = getUsedSubs();
                return (
                  <div key={idx} className="flex items-end gap-2">
                    <div className="flex-1">
                      {idx === 0 && <label className="text-[10px] text-[#8A877D] mb-1 block">Subcategoría</label>}
                      <Select
                        value={row.subcategoria || undefined}
                        onValueChange={(val) => {
                          updateSubRow(idx, 'subcategoria', val || '');
                          if (val !== '__custom__') updateSubRow(idx, 'customSub', '');
                        }}
                      >
                        <SelectTrigger className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] text-sm h-9">
                          <SelectValue>
                            {row.subcategoria && row.subcategoria !== '__custom__'
                              ? capitalizeDisplay(row.subcategoria)
                              : 'Seleccionar...'}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {subcategorias.filter(s => !usedSubs.has(s.toLowerCase()) || s === row.subcategoria).map((sub) => (
                            <SelectItem key={sub} value={sub}>{capitalizeDisplay(sub)}</SelectItem>
                          ))}
                          <SelectItem value="__custom__">
                            <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> Nueva...</span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {row.subcategoria === '__custom__' && (
                        <Input placeholder="Nombre" value={row.customSub}
                          onChange={(e) => updateSubRow(idx, 'customSub', e.target.value)}
                          className="mt-1 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] text-sm h-8" />
                      )}
                    </div>
                    <div className="w-28">
                      {idx === 0 && <label className="text-[10px] text-[#8A877D] mb-1 block">Límite S/</label>}
                      <Input
                        type="number" min="0" step="0.01" placeholder="0.00"
                        value={row.monto} onChange={(e) => updateSubRow(idx, 'monto', e.target.value)}
                        className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] text-sm h-9"
                      />
                    </div>
                    <Button variant="ghost" size="icon-xs" onClick={() => removeSubRow(idx)} className="shrink-0 mb-0.5">
                      <Trash2 className="h-3.5 w-3.5 text-[#8A877D]" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Alerta porcentaje */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#C8C6BC]">Alerta al (%)</label>
            <Input
              type="number" min="1" max="100" placeholder="80"
              value={alertaPorcentaje} onChange={(e) => setAlertaPorcentaje(e.target.value)}
              className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
            />
            <p className="text-xs text-[#8A877D]">Se aplica a todos los presupuestos creados.</p>
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" className="text-[#C8C6BC]" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
              onClick={handleSubmit}
              disabled={!canSubmit}
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
        const errData = await res.json().catch(() => ({}));
        console.error('[DeleteBudget] Failed:', res.status, errData);
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
          <DialogTitle className="text-[#F0EFE8]">¿Eliminar este presupuesto?</DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            Se eliminará el presupuesto de{' '}
            <span className="text-[#C8C6BC] font-medium">
              {budget?.categoria}{budget?.subcategoria ? ` → ${capitalizeDisplay(budget.subcategoria)}` : ''}
            </span>. Esta acción no se puede deshacer.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" className="text-[#C8C6BC]" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Eliminando...' : 'Eliminar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
