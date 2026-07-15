// ═══════════════════════════════════════════════════════════════
// OVERRIDES DE SUSCRIPCIONES (dominio='suscripcion')
// Puro (sin React): recibe la detección raw + overrides del usuario → lista final.
// Aplica: ocultar (falso positivo), renombrar, marcar plan (solo referencia, NO
// toca el monto cobrado), y dividir un descriptor opaco ("APPLE.COM/BILL") en
// varias suscripciones reales por clusters de monto. Reutiliza el mismo primitivo
// de override de Fase 2. Los agregados (KPIs) se recalculan sobre la lista final.
// ═══════════════════════════════════════════════════════════════

import type { RecurringOverride } from '@/lib/types'
import type { SuscripcionDetectada, CatalogEntry, PagoDetalle } from '@/lib/subscriptions-catalog'
import { getCatalogById, amountClusters, median, recurringCluster } from '@/lib/subscriptions-catalog'
import { computeAggregates, type DeteccionResult } from '@/lib/hooks/use-subscriptions'

// Separador en clave_variante para un override de split: `${baseId}::amt<centroidePEN>`
const SPLIT_SEP = '::amt'

/** clave_variante de un override de división para un cluster de monto dado. */
export function splitKey(baseId: string, centroidPen: number): string {
  return `${baseId}${SPLIT_SEP}${Math.round(centroidPen)}`
}

function parseSplitAmt(clave: string): number | null {
  const idx = clave.indexOf(SPLIT_SEP)
  if (idx === -1) return null
  const n = Number(clave.slice(idx + SPLIT_SEP.length))
  return Number.isFinite(n) ? n : null
}

function splitBaseId(clave: string): string | null {
  const idx = clave.indexOf(SPLIT_SEP)
  return idx === -1 ? null : clave.slice(0, idx)
}

/** ¿Se puede dividir? Solo si hay ≥2 clusters de monto que abarcan ≥2 meses cada uno
 *  (dos cuotas recurrentes concurrentes bajo un mismo nombre), no cuota + recargo puntual. */
export function splittableClusters(pagos: PagoDetalle[]) {
  return amountClusters(pagos).filter((c) => c.months >= 2)
}

const EMPTY: DeteccionResult = {
  suscripciones: [],
  totalMensualPEN: 0,
  totalMensualUSD: 0,
  cantidad: 0,
  porTipo: {},
  ahorroPotencialFamiliar: 0,
}

export function applySubscriptionOverrides(
  result: DeteccionResult | undefined,
  overrides: RecurringOverride[]
): DeteccionResult {
  if (!result) return EMPTY

  const ov = overrides.filter((o) => o.dominio === 'suscripcion')
  // Overrides escalares (rename/plan/ocultar), keyed por clave_variante = sub.id
  const byKey = new Map<string, RecurringOverride>()
  // Overrides de división agrupados por sub base
  const splitByBase = new Map<string, RecurringOverride[]>()
  for (const o of ov) {
    const base = splitBaseId(o.clave_variante)
    if (base !== null) {
      const arr = splitByBase.get(base) || []
      arr.push(o)
      splitByBase.set(base, arr)
    } else {
      byKey.set(o.clave_variante, o)
    }
  }

  const out: SuscripcionDetectada[] = []
  for (const sub of result.suscripciones) {
    const scalar = byKey.get(sub.id)
    if (scalar?.oculto) continue

    const splits = splitByBase.get(sub.id)
    if (splits && splits.length > 0) {
      const { children, residual } = applySplit(sub, splits)
      out.push(...children)
      if (residual) out.push(residual)
      continue
    }

    out.push(applyScalar(sub, scalar))
  }

  out.sort((a, b) => b.monto_pen - a.monto_pen)
  return { suscripciones: out, ...computeAggregates(out) }
}

function applyScalar(sub: SuscripcionDetectada, o?: RecurringOverride): SuscripcionDetectada {
  if (!o) return sub
  const next: SuscripcionDetectada = { ...sub, es_override: true }
  if (o.label_canonico) next.nombre = o.label_canonico
  if (o.plan_nombre) {
    next.plan_actual = o.plan_nombre
    const plan = sub.planes_disponibles.find((p) => p.nombre === o.plan_nombre)
    // Solo referencia: fija el precio de plan para comparativa/ahorro; NO el monto cobrado.
    if (plan) next.precio_referencia = plan.precio
  }
  return next
}

function applySplit(
  sub: SuscripcionDetectada,
  splits: RecurringOverride[]
): { children: SuscripcionDetectada[]; residual: SuscripcionDetectada | null } {
  const clusters = amountClusters(sub.pagos_detalle)
  const used = new Set<PagoDetalle>()
  const children: SuscripcionDetectada[] = []

  for (const cl of clusters) {
    const match = splits.find((s) => {
      const amt = parseSplitAmt(s.clave_variante)
      if (amt === null || cl.centroidPen <= 0) return false
      return Math.abs(cl.centroidPen - amt) / Math.max(cl.centroidPen, amt) <= 0.12
    })
    if (!match?.catalog_id) continue
    const cat = getCatalogById(match.catalog_id)
    if (!cat) continue
    cl.pagos.forEach((p) => used.add(p))
    children.push(buildChildSub(sub, cat, cl.pagos, match.plan_nombre))
  }

  // Nada matcheó (ej. el override apunta a un centroide que ya no existe): base intacto.
  if (children.length === 0) return { children: [], residual: applyScalar(sub) }

  const rest = sub.pagos_detalle.filter((p) => !used.has(p))
  const residual = rest.length > 0 ? buildResidual(sub, rest) : null
  return { children, residual }
}

function buildChildSub(
  base: SuscripcionDetectada,
  cat: CatalogEntry,
  pagos: PagoDetalle[],
  planNombre?: string | null
): SuscripcionDetectada {
  const sorted = [...pagos].sort((a, b) => b.fecha.localeCompare(a.fecha))
  const moneda = (sorted[0].moneda === 'USD' ? 'USD' : 'PEN') as 'USD' | 'PEN'
  const meses = new Set(pagos.map((p) => p.fecha.substring(0, 7))).size
  const plan = planNombre ? cat.planes.find((p) => p.nombre === planNombre) : undefined
  return {
    id: `${base.id}::child:${cat.id}:${Math.round(median(pagos.map((p) => p.monto_pen)))}`,
    nombre: cat.nombre,
    tipo: cat.tipo,
    icono: cat.icono,
    fuente: 'catalogo',
    estado: meses >= 2 ? 'activa' : 'posible',
    moneda,
    monto_detectado: Math.round(median(pagos.map((p) => p.monto)) * 100) / 100,
    monto_pen: Math.round(median(pagos.map((p) => p.monto_pen)) * 100) / 100,
    precio_referencia: plan ? plan.precio : cat.precio_local_pen ?? cat.precio_mensual,
    tiene_plan_familiar: cat.tiene_plan_familiar,
    precio_familiar: cat.precio_familiar,
    meses_detectados: meses,
    ultimo_pago: sorted[0].fecha,
    categoria_neto: cat.categoria_neto,
    subcategoria_neto: cat.subcategoria_neto,
    planes_disponibles: cat.planes,
    // En una sub dividida todos los pagos del cluster SON la cuota recurrente.
    pagos_detalle: sorted.map((p) => ({ ...p, recurrente: true })),
    plan_actual: planNombre ?? null,
    es_override: true,
    split_parent_id: base.id,
  }
}

function buildResidual(base: SuscripcionDetectada, rest: PagoDetalle[]): SuscripcionDetectada {
  const sorted = [...rest].sort((a, b) => b.fecha.localeCompare(a.fecha))
  // Recalcular la cuota recurrente sobre lo que quedó (no heredar los flags del base,
  // que fueron computados sobre el descriptor completo antes de dividir).
  const { recurring } = recurringCluster(rest)
  const recSet = new Set(recurring)
  return {
    ...base,
    monto_detectado: Math.round(median(recurring.map((p) => p.monto)) * 100) / 100,
    monto_pen: Math.round(median(recurring.map((p) => p.monto_pen)) * 100) / 100,
    meses_detectados: new Set(rest.map((p) => p.fecha.substring(0, 7))).size,
    ultimo_pago: sorted[0].fecha,
    pagos_detalle: sorted.map((p) => ({ ...p, recurrente: recSet.has(p) })),
    es_override: true,
  }
}
