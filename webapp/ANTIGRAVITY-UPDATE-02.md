# ANTIGRAVITY-UPDATE-02 — Forms mobile-first refactor

Refactor de `transaction-form.tsx` (504 líneas) y `budget-form.tsx` (577 líneas) para que el **flujo más crítico** de la webapp (registrar un gasto, crear un presupuesto) se sienta tan cómodo en mobile como los fixes del sprint `feat/mobile-comfort` hicieron con el dashboard.

**Fuente:** continuación del sprint `feat/mobile-comfort`. Los 6 fixes previos (glass sólido, touch targets, FAB swap, hero balance, declutter) ya están en `demo` y `feat/mobile-comfort`. Este UPDATE-02 es el siguiente paso lógico.

**Rama de trabajo:** `feat/mobile-comfort` (NO crear rama nueva). Cherry-pick los commits resultantes a `demo` al final.

---

## Contexto — qué ya existe y hay que respetar

1. **Paleta Nocturnal intacta.** NO cambiar colores. Usar:
   - `#0E0E0C` background base
   - `#131311` surface tier 1 (equivalente a `var(--color-neto-bg2)`)
   - `#1A1A17` surface tier 2 (equivalente a `var(--color-neto-bg3)` aprox, también `--secondary`)
   - `#1C1C19` surface tier 3 (elevated)
   - `#F0EFE8` foreground primary
   - `#C8C6BC` foreground secondary
   - `#8A877D` muted
   - `#1D9E75` primary (verde Neto — solo CTAs y acentos)
   - `#D85A30` destructive
   - `#EF9F27` warning

2. **La clase `.glass-card`** en `globals.css` ya fue refactorizada a sólido (`#131311`). **Usar esa clase para wrappers de secciones** en vez de inline `bg-[rgba(255,255,255,0.03)]`.

3. **El token `--text-display: 2.75rem`** (44px) ya está definido en `@theme` en globals.css. **Usarlo para el monto hero** de los forms.

4. **La regla `@media (max-width: 768px) { a, button, [role=button]... { min-height: 44px } }`** ya está en `globals.css`. Los botones en mobile ya cumplen 44px automáticamente. **Revisar que los inputs también cumplan** (no están en la regla por defecto — añadir `input, textarea, select` al selector).

5. **`color-scheme: dark`** ya está en `:root`. Los date pickers nativos y otros controles usan UI oscura.

6. **NO tocar la lógica de negocio.** Todo lo que hace cálculos, API calls, validaciones, merge de categorías, custom options, edit mode, delete dialogs — se conserva intacto. Este refactor es **puramente visual + UX structure**, no lógico.

---

## Objetivo

Transformar los dos forms para que en mobile:

1. **El monto sea el elemento protagonista** del form, no uno más de la lista
2. **Touch targets ≥48px** en todos los inputs, selects y botones
3. **Controles especializados** en lugar de dropdowns genéricos donde tenga sentido:
   - Moneda PEN/USD → segmented toggle (2 pills)
   - Método de pago (6 opciones) → horizontal scrollable pills
4. **Dialog que respire** en mobile: padding real, CTA sticky al fondo, labels legibles
5. **Haptic feedback** en el submit (vibración corta)
6. **Consistencia visual** con el resto del sprint (sólidos, no glass)

Desktop:
- **Cambio mínimo.** El layout general se mantiene (grid 2-col en categorías, etc.). Las mejoras de contraste y tipografía se heredan, pero la estructura es la misma.

---

## Restricciones (qué NO tocar)

- ❌ NO cambiar los endpoints de API (`/api/transactions`, `/api/budgets`) ni los payloads
- ❌ NO renombrar props de los componentes — `TransactionFormProps`, `BudgetFormProps` se mantienen
- ❌ NO tocar `DeleteConfirmDialog` ni `DeleteBudgetDialog` más allá de visualmente consistentes
- ❌ NO cambiar la paleta Nocturnal
- ❌ NO añadir dependencias nuevas (sin nuevas libs, usar motion/react ya presente y shadcn/ui instalado)
- ❌ NO reescribir los archivos completos — usar edits quirúrgicos con Edit tool
- ❌ NO tocar las funciones internas de estado (`useState`, `useMemo`, `useCallback`, `handleChange`, `handleSubmit`)

---

## Fix 1 — Utility class global `.form-input` y expansión de touch rule

**Archivo:** `webapp/src/app/globals.css`

**Problema:** Los dos forms tienen hardcoded `bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)]` en ~15 lugares. Eso es el glass viejo, inconsistente con las cards sólidas del resto de la app.

**Cambios:**

### 1.1 — Añadir utility `.form-input` después de `.glass-card-elevated`

Ubicar en `globals.css` después del bloque `.glass-card-elevated` (buscar ese selector) y antes de `/* Scrollbar styling */`. Añadir:

```css
/* Form input surface — consistent with solid card tiers.
 * Use on <input>, <select triggers>, and <textarea> in all dialogs.
 */
.form-input {
  background: #1A1A17;
  border: 1px solid rgba(240, 239, 232, 0.08);
  color: #F0EFE8;
  border-radius: 0.75rem;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.form-input::placeholder {
  color: #8A877D;
}
.form-input:hover {
  border-color: rgba(240, 239, 232, 0.14);
}
.form-input:focus,
.form-input:focus-visible {
  outline: none;
  border-color: #1D9E75;
  background: #1C1C19;
  box-shadow: 0 0 0 3px rgba(29, 158, 117, 0.15);
}
```

### 1.2 — Expandir el bloque de touch-target para incluir inputs

Buscar el bloque actual `@media (max-width: 768px) { ... }` en `globals.css`. Actualmente contiene selectores para `a`, `button`, `[role=button]`, etc.

Reemplazarlo COMPLETO con esto (agrega `input`, `select`, `textarea`):

```css
@media (max-width: 768px) {
  a:not(.touch-exempt),
  button:not(.touch-exempt),
  [role="button"]:not(.touch-exempt),
  [role="tab"]:not(.touch-exempt),
  [role="menuitem"]:not(.touch-exempt),
  [role="option"]:not(.touch-exempt),
  summary:not(.touch-exempt) {
    min-height: 44px;
  }
  input:not([type="checkbox"]):not([type="radio"]):not(.touch-exempt),
  select:not(.touch-exempt),
  textarea:not(.touch-exempt) {
    min-height: 48px;
    font-size: 16px; /* prevents iOS zoom on focus */
  }
}
```

Nota crítica: `font-size: 16px` en inputs es la regla mágica para que iOS Safari no haga zoom al focusear un input. Muchas webapps tienen ese bug. Lo arreglamos de raíz.

---

## Fix 2 — `transaction-form.tsx` refactor

**Archivo:** `webapp/src/components/dashboard/transaction-form.tsx`

**Objetivo:** El monto pasa a ser hero, moneda se vuelve toggle, método de pago se vuelve pill row, todo usa `.form-input`, labels más legibles.

### 2.1 — Añadir helpers al tope del archivo

Buscar la línea `const CUSTOM_OPTION = '__otra__';` y **después** de ella, añadir:

```tsx
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
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
      {options.map((m) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className={`shrink-0 px-4 py-2.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
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
```

La clase `touch-exempt` en el MonedaToggle es necesaria porque con la regla global de `min-height: 44px`, las 2 pills del toggle dentro del container estrecho se verían mal si cada una fuerza 44px. El container total ya cumple el target (~48px).

### 2.2 — Reemplazar `inputClasses` y `selectTriggerClasses`

Buscar las líneas (aprox 267-268):
```tsx
const inputClasses = 'bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]';
const selectTriggerClasses = 'w-full bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#C8C6BC]';
```

Reemplazar con:
```tsx
const inputClasses = 'form-input placeholder:text-[#8A877D]';
const selectTriggerClasses = 'form-input w-full text-[#C8C6BC]';
```

### 2.3 — Reemplazar el bloque `return` con versión mobile-first

El bloque actual (líneas 270-452 aproximadamente) va a ser reemplazado. El nuevo JSX mantiene la MISMA estructura lógica (mismos campos, misma validación, mismos handlers) pero reorganiza la presentación.

Buscar el bloque `return (` que empieza con `<Dialog open={open}` y termina con el cierre `</Dialog>` antes del `// --- Delete confirmation dialog ---`. Reemplazar ese bloque entero con:

```tsx
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card-elevated border-0 sm:max-w-md max-h-[92vh] overflow-y-auto p-0 gap-0">
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <DialogHeader>
            <DialogTitle className="text-[#F0EFE8] text-xl font-semibold">
              {title}
            </DialogTitle>
            <DialogDescription className="text-[#8A877D] text-sm">
              {isEdit ? 'Modifica los datos de la transaccion.' : 'Registra una nueva transaccion manualmente.'}
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Hero monto — the protagonist */}
        <div className="px-5 pb-4">
          <label className="block text-xs font-medium uppercase tracking-wider text-[#8A877D] mb-2">
            Monto ({form.moneda})
          </label>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2 flex-1 min-w-0">
              <span className="text-[28px] font-bold text-[#8A877D] leading-none">S/</span>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={form.monto}
                onChange={(e) => handleChange('monto', e.target.value)}
                inputMode="decimal"
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[40px] font-bold tracking-tight leading-none text-[#F0EFE8] placeholder:text-[#2A2A28] focus:outline-none focus:ring-0"
                style={{ color: isIngreso ? '#1D9E75' : '#F0EFE8' }}
              />
            </div>
            <MonedaToggle value={form.moneda} onChange={(v) => handleChange('moneda', v)} />
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
    </Dialog>
  );
```

Notar:
- El monto está en un `<input>` nativo (no el `<Input>` de shadcn) porque necesita ser transparente, sin border, con text-[40px]. El hero.
- Cuando `isIngreso === true`, el monto se pinta verde `#1D9E75`; si es gasto, queda crema. Eso refuerza visualmente el contexto.
- El `inputMode="decimal"` abre el teclado numérico decimal en iOS y Android al tocar.
- El footer es `sticky bottom-0` con el mismo bg que el dialog — queda siempre visible al hacer scroll.
- Haptic feedback en el submit (14ms — un poco más notorio que el del FAB, es una acción "commit").
- Los labels pasaron de `text-xs` a `text-sm` (14px) con `font-medium text-[#C8C6BC]`. Legibles.
- El dialog completo mantiene el layout 1-col en mobile y 2-col para categorías en desktop (`grid-cols-1 sm:grid-cols-2`).

### 2.4 — `DeleteConfirmDialog` al final del archivo (líneas 464-504)

Cambios mínimos (consistencia visual):

Buscar:
```tsx
<DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-sm">
```
Reemplazar con:
```tsx
<DialogContent className="glass-card-elevated border-0 sm:max-w-sm p-5">
```

Buscar el `<DialogFooter>` y reemplazar los botones:
```tsx
<DialogFooter>
  <DialogClose render={<Button variant="outline" className="text-[#C8C6BC]" />}>
    Cancelar
  </DialogClose>
  <Button variant="destructive" onClick={handleConfirm} disabled={deleting}>
    {deleting ? 'Eliminando...' : 'Eliminar'}
  </Button>
</DialogFooter>
```
Por:
```tsx
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
```

El haptic del delete es 20ms (más fuerte que el guardado) — señal subconsciente de "acción irreversible".

---

## Fix 3 — `budget-form.tsx` refactor

**Archivo:** `webapp/src/components/dashboard/budget-form.tsx`

**Objetivo:** Mismo tratamiento que transaction-form. El monto límite pasa a ser el hero. Los sub-presupuestos como rows siguen funcionando pero con inputs `.form-input`. Dialog con footer sticky.

### 3.1 — Reemplazar todos los inputs inline `bg-[rgba(255,255,255,0.03)]`

Buscar y reemplazar **con `replace_all: false`** uno por uno (son ~8 ocurrencias) — usar la misma lógica que en transaction-form.

Búsqueda 1:
```tsx
className="w-full bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8]"
```
Reemplazo:
```tsx
className="form-input w-full"
```

Búsqueda 2 (input de custom categoría, línea ~391):
```tsx
className="mt-1 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
```
Reemplazo:
```tsx
className="form-input mt-1 placeholder:text-[#8A877D]"
```

Búsqueda 3 (monto límite input, línea ~407):
```tsx
className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
```
Reemplazo:
```tsx
className="form-input placeholder:text-[#8A877D]"
```

Búsqueda 4 (sub-budget select trigger, ~459):
```tsx
className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] text-sm h-9"
```
Reemplazo:
```tsx
className="form-input text-sm"
```

Búsqueda 5 (sub-budget custom input, ~478):
```tsx
className="mt-1 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] text-sm h-8"
```
Reemplazo:
```tsx
className="form-input mt-1 text-sm"
```

Búsqueda 6 (sub-budget monto, ~486):
```tsx
className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] text-sm h-9"
```
Reemplazo:
```tsx
className="form-input text-sm"
```

Búsqueda 7 (alerta porcentaje, ~504):
```tsx
className="bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
```
Reemplazo:
```tsx
className="form-input placeholder:text-[#8A877D]"
```

### 3.2 — DialogContent wrapper

Buscar:
```tsx
<DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-lg max-h-[85vh] overflow-y-auto glass-card-depth">
```
Reemplazar con:
```tsx
<DialogContent className="glass-card-elevated border-0 sm:max-w-lg max-h-[92vh] overflow-y-auto p-0 gap-0">
```

### 3.3 — Estructura del contenido del dialog

El contenido actual está envuelto en un `<div className="flex flex-col gap-4">`. Necesita el padding y el footer sticky.

Buscar el bloque:
```tsx
<DialogHeader>
  <DialogTitle className="text-[#F0EFE8]">
    {isEditing ? 'Editar presupuesto' : 'Nuevo presupuesto'}
  </DialogTitle>
  <DialogDescription className="text-[#8A877D]">
    ...
  </DialogDescription>
</DialogHeader>

<div className="flex flex-col gap-4">
```

Reemplazar con:
```tsx
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
```

Cerrar el div extra al final. Buscar el cierre (antes de `</DialogContent>`):
```tsx
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
```

Reemplazar con:
```tsx
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
              if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
                navigator.vibrate(14);
              }
              handleSubmit();
            }}
            disabled={!canSubmit}
          >
            {saving ? 'Guardando...' : isEditing ? 'Guardar cambios' : 'Crear'}
          </Button>
        </div>
      </DialogContent>
```

### 3.4 — Labels de `text-xs` a `text-sm`

Hay varios labels con `text-xs font-medium text-[#C8C6BC]`. Cambiar a `text-sm font-medium text-[#C8C6BC]`:

- Línea ~352 (Categoría)
- Línea ~401 (Monto límite)
- Línea ~432 (Presupuestos por subcategoría)
- Línea ~500 (Alerta al %)

NO tocar los `text-[10px]` de los labels internos de cada sub-row (líneas ~451 y ~482) — ahí el espacio es apretado y 12px es aceptable en el micro-layout.

### 3.5 — DeleteBudgetDialog (fondo del archivo, líneas 536-577)

Mismos cambios que en transaction-form DeleteConfirmDialog:

Buscar:
```tsx
<DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.06)] sm:max-w-md glass-card-depth">
```
Reemplazar con:
```tsx
<DialogContent className="glass-card-elevated border-0 sm:max-w-md p-5">
```

Buscar los botones del delete:
```tsx
<div className="flex justify-end gap-2 pt-2">
  <Button variant="outline" className="text-[#C8C6BC]" onClick={() => onOpenChange(false)}>Cancelar</Button>
  <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
    {deleting ? 'Eliminando...' : 'Eliminar'}
  </Button>
</div>
```
Reemplazar con:
```tsx
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
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(20);
      }
      handleDelete();
    }}
    disabled={deleting}
  >
    {deleting ? 'Eliminando...' : 'Eliminar'}
  </Button>
</div>
```

---

## Fix 4 — Verificar que el `Input` component de shadcn herede `.form-input`

**Archivo:** `webapp/src/components/ui/input.tsx`

**Problema potencial:** shadcn's `<Input>` base class puede sobrescribir nuestros estilos `.form-input`. Verificar.

**Acción:** Abrir el archivo y verificar si el `className` del Input base incluye cosas como `bg-transparent` o similares que conflictan. Si es así, los estilos de `.form-input` deberían ganar porque se pasan por `className` del lado del consumidor.

Si hay conflicto visible, la solución es poner los estilos de `form-input` inline con mayor especificidad, pero **primero hacer build + testear** antes de tocar `input.tsx`. Probable que no haga falta tocar nada.

---

## Criterios de aceptación

Después de aplicar los 4 fixes, el build debe pasar y las siguientes verificaciones visuales (en mobile 390×844):

### transaction-form (abrir desde el FAB + gasto en /dashboard)

- [ ] El título "Nuevo gasto" / "Nuevo ingreso" se lee claro (20px semibold)
- [ ] El campo **Monto** domina visualmente con el número a 40px bold
- [ ] El `S/` prefix es ~28px muted al lado del número
- [ ] El toggle PEN/USD aparece a la derecha del input del monto
- [ ] Cuando se selecciona PEN el pill es verde, USD pasa a muted (y viceversa)
- [ ] El campo Comercio es un input con bg `#1A1A17` y border sutil
- [ ] Categoría y Subcategoría son 1-col en mobile, 2-col en desktop (breakpoint sm)
- [ ] El dropdown de Categoría abre con tamaño cómodo (min-height 48px en cada SelectItem)
- [ ] El campo Fecha muestra un date picker nativo (que en dark mode es oscuro gracias a `color-scheme: dark`)
- [ ] Método de pago se muestra como una fila horizontal de 6 pills (Debito, Credito, Yape, Plin, Transferencia, Efectivo)
- [ ] Al seleccionar Debito/Credito/Transferencia, aparece el dropdown de Banco debajo
- [ ] El footer (Cancelar | Registrar) está sticky al fondo con border-top sutil
- [ ] Los dos botones tienen altura 48px y ocupan `flex-1` (mismo ancho cada uno)
- [ ] Al hacer tap en Registrar, se siente vibración (Android Chrome / in-app WA browser)
- [ ] Al hacer tap, el botón hace scale 0.98 brevemente
- [ ] El teclado numérico se abre (no el teclado normal) al tocar el Monto en iOS
- [ ] Al focusear el Monto en iOS, la página NO hace zoom (font-size 16px+)
- [ ] El form sigue funcionando en edit mode: abre con datos precargados, todos los campos
- [ ] El form de ingreso muestra el monto en verde `#1D9E75`, el form de gasto en crema `#F0EFE8`

### budget-form (abrir desde Presupuestos → + Nuevo)

- [ ] El título "Nuevo presupuesto" / "Editar presupuesto" se lee claro
- [ ] Todos los inputs usan `.form-input` (bg sólido `#1A1A17`, border sutil, radius 12px)
- [ ] Labels de secciones principales son `text-sm` (no más `text-xs`)
- [ ] El bloque de sub-presupuestos por subcategoría sigue funcionando: add / remove rows
- [ ] El footer es sticky con los 2 botones a altura 48px
- [ ] Haptic feedback al Guardar

### DeleteConfirmDialog (transaction) y DeleteBudgetDialog

- [ ] Se ven consistentes con el resto (glass-card-elevated)
- [ ] Los botones Cancelar + Eliminar son anchos completos (flex-1) en mobile, auto en desktop
- [ ] Haptic 20ms al confirmar eliminación

### Desktop (≥ 768px)

- [ ] El layout general de los dos forms se ve muy similar a antes
- [ ] Categoría + Subcategoría siguen en grid 2-col
- [ ] El footer no es sticky en desktop (o si lo es, no molesta — con `sm:max-w-md` el dialog no scrollea tanto)
- [ ] Los botones del footer NO son `flex-1` en desktop — deberían ser `sm:flex-initial` (ancho auto) para no verse deformados

**Si algún criterio desktop falla:** añadir variant `sm:flex-initial` al `className` de los botones del footer y probar.

---

## Testing flow

1. **Build check:**
   ```bash
   cd webapp && npm run build
   ```
   Debe terminar sin errores. Si falla, reportar el error exacto y detener hasta que se resuelva.

2. **Test local opcional:**
   ```bash
   cd webapp && npm run dev
   ```
   Abrir `http://localhost:3000/dashboard` en Chrome DevTools con mobile emulation iPhone 14.

3. **Commits — uno por fix para poder revertir:**
   ```bash
   git add webapp/src/app/globals.css
   git commit -m "style(forms): add .form-input utility + expand touch-target rule"

   git add webapp/src/components/dashboard/transaction-form.tsx
   git commit -m "style(forms): transaction-form mobile-first refactor with hero monto"

   git add webapp/src/components/dashboard/budget-form.tsx
   git commit -m "style(forms): budget-form mobile-first refactor with solid inputs"
   ```

4. **Rama:** hacer los commits directamente sobre `feat/mobile-comfort`. Al terminar, informar a Claude para que haga el cherry-pick a `demo` y el push.

---

## Qué reportar al terminar

- Commits exactos creados (SHAs)
- Build status (pass / fail + error)
- Screenshots (si es posible) del transaction-form y budget-form abiertos en mobile viewport
- Cualquier decisión de diseño que hayas tomado por tu cuenta que se desvíe de este spec
- Cualquier criterio de aceptación que NO se cumple y por qué
