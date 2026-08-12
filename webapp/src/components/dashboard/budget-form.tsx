'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { haptic } from '@/lib/haptics';
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
import { Plus, Trash2, Check } from 'lucide-react';
import { CATEGORIAS, getCategoriaEmoji } from '@/lib/constants';
import { capitalizeDisplay } from '@/lib/format';
import type { Presupuesto } from '@/lib/types';
import { track, EVENTS } from '@/lib/analytics';

export interface CategoriaOption {
  nombre: string;
  emoji: string;
  subs: string[];
}

interface SubBudgetRow {
  /** id of the existing sub-budget row, undefined for newly added rows */
  id?: string;
  /**
   * Clave estable de React, distinta del `id` de la DB: una fila recién agregada no tiene
   * `id` todavía y aun así hay que poder identificarla entre renders.
   *
   * Con `key={idx}` (lo que había, hallazgo F10) borrar la fila del medio hacía que React
   * reusara el DOM de la borrada para la siguiente: el `<Select>` no controlado por completo
   * se quedaba con el valor anterior, así que el usuario borraba "Taxi" y veía cómo el monto
   * de "Taxi" aparecía pegado a "Delivery". Es un bug de plata: el límite terminaba en la
   * subcategoría equivocada.
   */
  key: string;
  subcategoria: string;
  customSub: string;
  monto: string;
}

let contadorFilas = 0;
const nuevaClaveFila = () => 'sub-' + (contadorFilas++);

interface BudgetFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: Presupuesto | null;
  onSuccess?: () => void;
  userCategorias?: CategoriaOption[];
  existingBudgets?: Presupuesto[];
  groupSubBudgets?: Presupuesto[];
  /** Average monthly spending per category (for suggestions) */
  spendingAvgByCategory?: Map<string, number>;
  /** Month/year to create budgets for (defaults to current month) */
  mes?: number;
  anio?: number;
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

export function BudgetForm({ open, onOpenChange, budget, onSuccess, userCategorias, existingBudgets = [], groupSubBudgets, spendingAvgByCategory, mes, anio }: BudgetFormProps) {
  const isEditing = !!budget;

  const [categoria, setCategoria] = useState('');
  const [customCategoria, setCustomCategoria] = useState('');
  const [montoLimite, setMontoLimite] = useState('');
  const [alertaPorcentaje, setAlertaPorcentaje] = useState('80');
  const [saving, setSaving] = useState(false);
  // Recurrence scope: apply this budget to the following months too (default),
  // or only the selected month. "Following months" is the natural recurring case.
  const [aplicarAdelante, setAplicarAdelante] = useState(true);

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
      setAplicarAdelante(true);
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
            id: sb.id,
            // Las filas que vienen de la DB usan su propio id como clave: es estable entre
            // renders y sobrevive a que se borre una fila vecina.
            key: 'db-' + sb.id,
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
    setSubRows(prev => [...prev, { key: nuevaClaveFila(), subcategoria: '', customSub: '', monto: '' }]);
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

        // Update/create/delete sub-budgets — matched by row id, NEVER by position.
        // Positional matching corrupted rows when a middle/first sub was removed:
        // it renamed a surviving record onto an existing subcategoria and hit the
        // unique index (usuario_id, categoria, subcategoria, mes, anio) → 400.
        const existingSubs = groupSubBudgets || [];

        for (const row of subRows) {
          const effSub = getEffectiveSub(row);
          if (!effSub || !row.monto) continue;

          if (row.id) {
            // Update the existing sub-budget by its own id
            const subPayload = {
              id: row.id,
              categoria: effectiveCategoria,
              subcategoria: effSub,
              monto_limite: parseFloat(row.monto) || 0,
              alerta_porcentaje: parseInt(alertaPorcentaje, 10) || 80,
            };
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
            // Newly added row → create
            const subPayload = {
              categoria: effectiveCategoria,
              subcategoria: effSub,
              monto_limite: parseFloat(row.monto) || 0,
              alerta_porcentaje: parseInt(alertaPorcentaje, 10) || 80,
              ...(mes && anio ? { mes, anio } : {}),
            };
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

        // Delete existing sub-budgets whose id is no longer present in the rows
        const keptIds = new Set(subRows.map(r => r.id).filter(Boolean));
        for (const existingSub of existingSubs) {
          if (!keptIds.has(existingSub.id)) {
            await fetch(`/api/budgets?id=${existingSub.id}`, { method: 'DELETE' });
          }
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
            ...(mes && anio ? { mes, anio } : {}),
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
              ...(mes && anio ? { mes, anio } : {}),
            });
          }
        }

        // Create all budgets sequentially
        for (const payload of budgetsToCreate) {
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

      // Recurrence: mirror this category from the current month onto the following
      // materialized months. Best-effort — the month just saved is already correct.
      if (aplicarAdelante && mes && anio && effectiveCategoria) {
        await fetch('/api/budgets/apply-forward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ categoria: effectiveCategoria, mes, anio }),
        }).catch(() => {});
      }

      toast.success(isEditing ? 'Presupuesto actualizado' : 'Presupuesto creado');
      if (!isEditing) track(EVENTS.BUDGET_CREATED);
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      toast.error('Error al guardar el presupuesto');
    } finally {
      setSaving(false);
    }
  }

  // Sum of the sub-budget rows (only rows with a subcategory and a positive amount).
  const subsTotal = subRows.reduce((acc, r) => {
    const m = parseFloat(r.monto);
    return getEffectiveSub(r) && !isNaN(m) && m > 0 ? acc + m : acc;
  }, 0);
  const subsTotalRounded = Math.round(subsTotal * 100) / 100;

  // The "monto límite" is the category total only when creating, or when editing
  // the category (total) row — not when editing an individual sub-budget.
  const limitIsCategoryTotal = !isEditing || !effectiveSubcategoria;
  const montoLimiteNum = parseFloat(montoLimite);
  const limitBelowSubs =
    limitIsCategoryTotal &&
    subsTotal > 0 &&
    montoLimite.trim() !== '' &&
    !isNaN(montoLimiteNum) &&
    montoLimiteNum < subsTotalRounded;

  const canSubmit =
    effectiveCategoria &&
    (montoLimite || subRows.some(r => r.monto && getEffectiveSub(r))) &&
    !limitBelowSubs &&
    !saving;

  // Helper to get capitalized display for a subcategory value in Select trigger
  function getSubDisplayText(value: string): string {
    if (!value || value === '__custom__' || value === '__none__') return '';
    return capitalizeDisplay(value);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card-elevated border-0 sm:max-w-lg max-h-[92vh] overflow-y-auto p-0 gap-0">
        <div className="px-5 pt-5 pb-3">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-xl font-semibold">
              {isEditing ? 'Editar presupuesto' : 'Nuevo presupuesto'}
            </DialogTitle>
            <DialogDescription className="text-[#8A877D] text-sm">
              {isEditing
                ? 'Modifica los datos de tu presupuesto.'
                : 'Define límites de gasto por categoría y subcategorías.'}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-5 pb-4 flex flex-col gap-4">
          {/* Categoria */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#C8C6BC]">Categoría</label>
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
              <SelectTrigger className="form-input w-full">
                <SelectValue placeholder="Selecciona una categoría">
                  {isCustomCat
                    ? (customCategoria ? `✨ ${capitalizeDisplay(customCategoria)}` : 'Nueva categoría...')
                    : categoria
                      ? `${getCategoriaEmoji(categoria)} ${categoria}`
                      : 'Selecciona una categoría'}
                </SelectValue>
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
                className="form-input mt-1 placeholder:text-[#8A877D]"
                autoFocus
              />
            )}
          </div>

          {/* Single subcategory select removed — subcategories are managed via the multi-row section below */}

          {/* Monto limite (category-level) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#C8C6BC]">
              Monto límite {!isEditing ? 'de la categoría' : ''} (S/)
            </label>
            <Input
              type="number" min="0" step="0.01" placeholder="500.00"
              value={montoLimite} onChange={(e) => setMontoLimite(e.target.value)}
              className="form-input placeholder:text-[#8A877D]"
            />
            {!isEditing && spendingAvgByCategory && effectiveCategoria && (() => {
              const avg = spendingAvgByCategory.get(effectiveCategoria.toLowerCase());
              if (!avg || avg <= 0) return null;
              const suggested = Math.ceil(avg / 10) * 10; // Round up to nearest 10
              return (
                <button
                  type="button"
                  className="text-xs text-[#1D9E75] hover:underline text-left"
                  onClick={() => setMontoLimite(String(suggested))}
                >
                  Sugerido: S/{suggested} (promedio mensual: S/{Math.round(avg)})
                </button>
              );
            })()}
            {catDuplicate && !isEditing && (
              <p className="text-xs text-[#EF9F27]">Ya existe un presupuesto general para {effectiveCategoria}. Se omitirá este campo.</p>
            )}
            {limitBelowSubs && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#EF9F27]">
                <span>El límite es menor que la suma de subcategorías (S/{subsTotalRounded.toFixed(2)}).</span>
                <button
                  type="button"
                  className="text-[#1D9E75] hover:underline font-medium"
                  onClick={() => setMontoLimite(String(subsTotalRounded))}
                >
                  Igualar a S/{subsTotalRounded.toFixed(2)}
                </button>
              </div>
            )}
          </div>

          {/* Sub-category budgets — always show when a category is selected */}
          {effectiveCategoria && (
            <div className="flex flex-col gap-3 pt-2 border-t border-[rgba(255,255,255,0.06)]">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#C8C6BC]">Presupuestos por subcategoría</label>
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
                  <div key={row.key} className="flex items-end gap-2">
                    <div className="flex-1">
                      {idx === 0 && <label className="text-[10px] text-[#8A877D] mb-1 block">Subcategoría</label>}
                      <Select
                        value={row.subcategoria || undefined}
                        onValueChange={(val) => {
                          updateSubRow(idx, 'subcategoria', val || '');
                          if (val !== '__custom__') updateSubRow(idx, 'customSub', '');
                        }}
                      >
                        <SelectTrigger className="form-input text-sm">
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
                          className="form-input mt-1 text-sm" />
                      )}
                    </div>
                    <div className="w-28">
                      {idx === 0 && <label className="text-[10px] text-[#8A877D] mb-1 block">Límite S/</label>}
                      <Input
                        type="number" min="0" step="0.01" placeholder="0.00"
                        value={row.monto} onChange={(e) => updateSubRow(idx, 'monto', e.target.value)}
                        className="form-input text-sm"
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
            <label className="text-sm font-medium text-[#C8C6BC]">Alerta al (%)</label>
            <Input
              type="number" min="1" max="100" placeholder="80"
              value={alertaPorcentaje} onChange={(e) => setAlertaPorcentaje(e.target.value)}
              className="form-input placeholder:text-[#8A877D]"
            />
            <p className="text-xs text-[#8A877D]">Se aplica a todos los presupuestos creados.</p>
          </div>

          {/* Vigencia — recurrence scope */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#C8C6BC]">Vigencia</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAplicarAdelante(true)}
                className={`flex-1 h-9 rounded-lg text-xs font-medium border transition-colors ${
                  aplicarAdelante
                    ? 'bg-[#1D9E75]/15 text-[#1D9E75] border-[#1D9E75]/40'
                    : 'text-[#8A877D] border-[rgba(240,239,232,0.14)] hover:bg-[#1C1C19]'
                }`}
              >
                Este mes y los siguientes
              </button>
              <button
                type="button"
                onClick={() => setAplicarAdelante(false)}
                className={`flex-1 h-9 rounded-lg text-xs font-medium border transition-colors ${
                  !aplicarAdelante
                    ? 'bg-[#1D9E75]/15 text-[#1D9E75] border-[#1D9E75]/40'
                    : 'text-[#8A877D] border-[rgba(240,239,232,0.14)] hover:bg-[#1C1C19]'
                }`}
              >
                Solo este mes
              </button>
            </div>
            <p className="text-xs text-[#8A877D]">
              {aplicarAdelante
                ? 'Se aplicará a los próximos meses hasta que lo cambies o elimines.'
                : 'Solo afecta el mes seleccionado.'}
            </p>
          </div>

        </div>

        {/* Sticky footer */}
        <div className="sticky bottom-0 left-0 right-0 bg-[#131311] border-t border-[rgba(240,239,232,0.06)] px-5 py-4 flex gap-3">
          <Button
            variant="outline"
            className="flex-1 h-12 text-[#C8C6BC] border-[rgba(240,239,232,0.14)] hover:bg-[#1C1C19]"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            className="flex-1 h-12 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 active:scale-[0.98] transition-transform font-semibold disabled:opacity-50"
            onClick={() => {
              haptic('tap');
              handleSubmit();
            }}
            disabled={!canSubmit}
          >
            {saving ? 'Guardando...' : isEditing ? 'Guardar cambios' : 'Crear'}
          </Button>
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
  const [alsoForward, setAlsoForward] = useState(true);

  useEffect(() => {
    if (open) setAlsoForward(true);
  }, [open]);

  async function handleDelete() {
    if (!budget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/budgets?id=${budget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('No se pudo eliminar el presupuesto');
        return;
      }
      // Propagate the removal to the following months so the budget stops going
      // forward (it can be re-created later to reactivate it).
      if (alsoForward && budget.mes && budget.anio) {
        await fetch('/api/budgets/apply-forward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ categoria: budget.categoria, mes: budget.mes, anio: budget.anio }),
        }).catch(() => {});
      }
      toast.success('Presupuesto eliminado');
      onOpenChange(false);
      onSuccess?.();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card-elevated border-0 sm:max-w-md p-5">
        <DialogHeader>
          <DialogTitle className="text-[#F0EFE8]">¿Eliminar este presupuesto?</DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            Se eliminará el presupuesto de{' '}
            <span className="text-[#C8C6BC] font-medium">
              {budget?.categoria}{budget?.subcategoria ? ` → ${capitalizeDisplay(budget.subcategoria)}` : ''}
            </span>. Esta acción no se puede deshacer.
          </DialogDescription>
        </DialogHeader>
        <button
          type="button"
          onClick={() => setAlsoForward(v => !v)}
          className="flex items-center gap-2.5 text-left py-1"
          aria-pressed={alsoForward}
        >
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
              alsoForward
                ? 'bg-[#1D9E75] border-[#1D9E75]'
                : 'border-[rgba(240,239,232,0.24)]'
            }`}
          >
            {alsoForward && <Check className="h-3.5 w-3.5 text-white" />}
          </span>
          <span className="text-sm text-[#C8C6BC]">También en los meses siguientes</span>
        </button>
        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="outline"
            className="flex-1 sm:flex-initial h-12 sm:h-10 text-[#C8C6BC] border-[rgba(240,239,232,0.14)]"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            variant="destructive"
            className="flex-1 sm:flex-initial h-12 sm:h-10 active:scale-[0.98] transition-transform"
            onClick={() => {
              haptic('warning');
              handleDelete();
            }}
            disabled={deleting}
          >
            {deleting ? 'Eliminando...' : 'Eliminar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
