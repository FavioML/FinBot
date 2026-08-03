// ═══════════════════════════════════════════════════════════════
// DETECCIÓN DE PAGOS RECURRENTES — entity resolution + overrides
// Puro (sin React): recibe transacciones + overrides + hoy → clusters + sugerencias.
// Junta variantes con nombres distintos del mismo pago (Alquiler == "Juno Luya E.")
// por subcategoría + monto + cadencia, con fusión automática en alta confianza y
// sugerencias en confianza media. Los overrides del usuario mandan sobre la heurística.
// ═══════════════════════════════════════════════════════════════

import type { Transaccion, RecurringOverride } from '@/lib/types'
import { matchCatalogo } from '@/lib/subscriptions-catalog'
import { montoPen } from '@/lib/tx-monto'

export interface RecurringCluster {
  id: string // clave canónica (comercio normalizado raíz del cluster)
  label: string
  categoria: string
  subcategoria: string
  amountPen: number // cuota recurrente (mediana), NO la suma del mes
  monthsDetected: number
  dayOfMonth: number
  lastDate: string
  nextExpected: string
  daysUntil: number // a nextExpected; negativo = vencido
  status: 'active' | 'inactive'
  variantKeys: string[] // todos los comercios normalizados fusionados aquí
  variantLabels: string[]
  isManual: boolean // marcado recurrente a mano
}

export interface MergeSuggestion {
  aId: string
  bId: string
  aLabel: string
  bLabel: string
  reason: string
}

export interface RecurringResult {
  clusters: RecurringCluster[]
  suggestions: MergeSuggestion[]
}

// Umbral: vencido más que esto sin cobro = "mudo" (candidato a inactivo / sugerir unir)
const SILENT_DAYS = 40

const normKey = (s: string) => s.toLowerCase().trim()
const normSub = (s?: string | null) => (s || '').toLowerCase().trim()

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function within(a: number, b: number, pct: number): boolean {
  const ref = Math.max(a, b)
  return ref > 0 && Math.abs(a - b) / ref <= pct
}

function daysBetween(fromISO: string, toISO: string): number {
  const from = new Date(fromISO + 'T00:00:00')
  const to = new Date(toISO + 'T00:00:00')
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24))
}

interface Unit {
  key: string
  label: string
  categoria: string
  subcategoria: string
  amountPen: number
  months: Set<string>
  dayOfMonth: number
  lastDate: string
  isManual: boolean
}

function buildUnit(key: string, txs: Transaccion[], override: RecurringOverride | undefined, manual: boolean): Unit {
  const sorted = [...txs].sort((a, b) => b.fecha.localeCompare(a.fecha))
  const amounts = txs.map((t) => montoPen(t))
  const days = txs.map((t) => new Date(t.fecha + 'T00:00:00').getDate())
  return {
    key,
    label: override?.label_canonico || sorted[0].comercio || key,
    categoria: sorted[0].categoria || '',
    subcategoria: normSub(sorted[0].subcategoria),
    amountPen: median(amounts),
    months: new Set(txs.map((t) => t.fecha.substring(0, 7))),
    dayOfMonth: Math.round(days.reduce((s, d) => s + d, 0) / days.length),
    lastDate: sorted[0].fecha,
    isManual: manual,
  }
}

// Union-find
class DSU {
  parent: Record<string, string> = {}
  find(x: string): string {
    if (this.parent[x] === undefined) this.parent[x] = x
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[ra] = rb
  }
}

/**
 * @param transactions todas las transacciones del usuario
 * @param overrides overrides dominio='recurrente'
 * @param todayISO fecha de hoy YYYY-MM-DD (se pasa para mantener la función pura)
 */
export function detectRecurring(
  transactions: Transaccion[],
  overrides: RecurringOverride[],
  todayISO: string
): RecurringResult {
  const ovByKey = new Map<string, RecurringOverride>()
  for (const ov of overrides) {
    if (ov.dominio === 'recurrente') ovByKey.set(ov.clave_variante, ov)
  }

  // 1) Agrupar gastos por comercio normalizado (excluye suscripciones de catálogo)
  const byKey = new Map<string, Transaccion[]>()
  for (const tx of transactions) {
    if (tx.tipo !== 'gasto') continue
    const comercio = (tx.comercio || '').trim()
    if (!comercio) continue
    if (matchCatalogo(comercio)) continue
    const k = normKey(comercio)
    const list = byKey.get(k) || []
    list.push(tx)
    byKey.set(k, list)
  }

  // 2) Unidades incluidas (heurística por defecto; override manda)
  const units = new Map<string, Unit>()
  for (const [k, txs] of byKey) {
    const ov = ovByKey.get(k)
    if (ov?.oculto) continue
    const manual = ov?.es_recurrente_manual
    if (manual === false) continue

    const amounts = txs.map((t) => montoPen(t)).sort((a, b) => a - b)
    const med = median(amounts)
    const consistent = amounts.every((a) => med > 0 && Math.abs(a - med) / med < 0.2)
    const months = new Set(txs.map((t) => t.fecha.substring(0, 7)))
    const include = manual === true || (txs.length >= 2 && months.size >= 2 && consistent)
    if (!include) continue

    units.set(k, buildUnit(k, txs, ov, manual === true))
  }

  // 3) Clustering: auto-merge alta confianza + aliases explícitos
  const dsu = new DSU()
  for (const k of units.keys()) dsu.find(k)

  // "pin/separar": override cuyo id_canonico apunta a sí mismo → no auto-fusionar esa llave
  const pinnedSelf = new Set<string>()
  for (const ov of ovByKey.values()) {
    if (ov.id_canonico && ov.id_canonico === ov.clave_variante) pinnedSelf.add(ov.clave_variante)
  }

  const unitList = [...units.values()]
  for (let i = 0; i < unitList.length; i++) {
    for (let j = i + 1; j < unitList.length; j++) {
      const a = unitList[i]
      const b = unitList[j]
      if (pinnedSelf.has(a.key) || pinnedSelf.has(b.key)) continue
      if (isHighConfidence(a, b)) dsu.union(a.key, b.key)
    }
  }
  // aliases explícitos del usuario (id_canonico != clave_variante)
  for (const ov of ovByKey.values()) {
    if (ov.id_canonico && ov.id_canonico !== ov.clave_variante) {
      if (units.has(ov.clave_variante) && units.has(ov.id_canonico)) {
        dsu.union(ov.clave_variante, ov.id_canonico)
      }
    }
  }

  // 4) Materializar clusters
  const groups = new Map<string, Unit[]>()
  for (const u of unitList) {
    const root = dsu.find(u.key)
    const arr = groups.get(root) || []
    arr.push(u)
    groups.set(root, arr)
  }

  const clusters: RecurringCluster[] = []
  for (const members of groups.values()) {
    // raíz canónica = la unidad con más meses (desempate: más txs → key menor)
    const primary = [...members].sort(
      (a, b) => b.months.size - a.months.size || a.key.localeCompare(b.key)
    )[0]
    const allAmounts = members.map((m) => m.amountPen)
    const allMonths = new Set<string>()
    members.forEach((m) => m.months.forEach((mm) => allMonths.add(mm)))
    const lastDate = members.reduce((a, m) => (m.lastDate > a ? m.lastDate : a), '')
    // label canónico: override sobre cualquier miembro, si no el primary
    const labelOverride = members
      .map((m) => ovByKey.get(m.key)?.label_canonico)
      .find((l): l is string => !!l)

    const nextExpected = addMonth(lastDate, primary.dayOfMonth)
    const daysUntil = daysBetween(todayISO, nextExpected)

    clusters.push({
      id: primary.key,
      label: labelOverride || primary.label,
      categoria: primary.categoria,
      subcategoria: primary.subcategoria,
      amountPen: median(allAmounts),
      monthsDetected: allMonths.size,
      dayOfMonth: primary.dayOfMonth,
      lastDate,
      nextExpected,
      daysUntil,
      status: 'active',
      variantKeys: members.map((m) => m.key),
      variantLabels: members.map((m) => m.label),
      isManual: members.some((m) => m.isManual),
    })
  }

  // 5) Estado (mudo → inactivo o sugerir unir) + sugerencias de fusión
  const suggestions: MergeSuggestion[] = []
  const seenPair = new Set<string>()
  const pairKey = (a: string, b: string) => [a, b].sort().join('|')

  for (const c of clusters) {
    if (c.daysUntil < -SILENT_DAYS) {
      // Grupo mudo: ¿hay gemelo activo con misma subcat + monto? → sugerir unir, sin alarma
      const twin = clusters.find(
        (o) =>
          o.id !== c.id &&
          o.daysUntil >= -SILENT_DAYS &&
          o.subcategoria &&
          o.subcategoria === c.subcategoria &&
          within(o.amountPen, c.amountPen, 0.12)
      )
      if (twin && !pinnedSelf.has(c.id) && !pinnedSelf.has(twin.id)) {
        const pk = pairKey(c.id, twin.id)
        if (!seenPair.has(pk)) {
          seenPair.add(pk)
          suggestions.push({
            aId: c.id,
            bId: twin.id,
            aLabel: c.label,
            bLabel: twin.label,
            reason: 'Mismo monto y categoría; uno dejó de aparecer',
          })
        }
      } else {
        c.status = 'inactive' // muerto de verdad → gris, sin naranja
      }
    }
  }

  // Sugerencias entre clusters activos (confianza media: subcat + monto, día distinto)
  const active = clusters.filter((c) => c.status === 'active')
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]
      if (!a.subcategoria || a.subcategoria !== b.subcategoria) continue
      if (!within(a.amountPen, b.amountPen, 0.12)) continue
      if (Math.abs(a.dayOfMonth - b.dayOfMonth) <= 3) continue // sería alta confianza (ya fusionado)
      if (pinnedSelf.has(a.id) || pinnedSelf.has(b.id)) continue // usuario los mantuvo separados
      const pk = pairKey(a.id, b.id)
      if (seenPair.has(pk)) continue
      seenPair.add(pk)
      suggestions.push({
        aId: a.id,
        bId: b.id,
        aLabel: a.label,
        bLabel: b.label,
        reason: 'Mismo monto y categoría',
      })
    }
  }

  clusters.sort((a, b) => b.amountPen - a.amountPen)
  return { clusters, suggestions }
}

function isHighConfidence(a: Unit, b: Unit): boolean {
  if (!a.subcategoria || a.subcategoria !== b.subcategoria) return false
  if (!within(a.amountPen, b.amountPen, 0.1)) return false
  if (Math.abs(a.dayOfMonth - b.dayOfMonth) > 3) return false
  return true
}

function addMonth(dateISO: string, day: number): string {
  const d = new Date(dateISO + 'T00:00:00')
  const target = new Date(d)
  target.setMonth(target.getMonth() + 1)
  const lastDayOfMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(day, lastDayOfMonth))
  const y = target.getFullYear()
  const m = String(target.getMonth() + 1).padStart(2, '0')
  const dd = String(target.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
