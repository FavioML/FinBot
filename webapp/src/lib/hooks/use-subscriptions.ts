'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Transaccion } from '@/lib/types';
import type { SuscripcionDetectada, TipoSuscripcion, CatalogEntry } from '@/lib/subscriptions-catalog';
import {
  TIPO_LABELS,
  TC_APROXIMADO,
  matchCatalogo,
  recurringCluster,
  median,
} from '@/lib/subscriptions-catalog';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_TRANSACTIONS } from '@/lib/demo/mock-data';

// Normaliza la subcategoria de la DB a una key válida de TIPO_LABELS (para el
// ramo por-patrón sin match de catálogo). Ej: "Software" -> "software".
function normalizeSubcategoriaKey(raw: string | null | undefined): string {
  if (!raw) return 'otros'
  const norm = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
  if (!norm || norm === 'sin_categoria' || norm === 'null') return 'otros'
  return TIPO_LABELS[norm] ? norm : 'otros'
}

interface PagoRaw {
  monto: number
  montoPen: number
  fecha: string
  moneda: string
}

export interface DeteccionResult {
  suscripciones: SuscripcionDetectada[]
  totalMensualPEN: number
  totalMensualUSD: number
  cantidad: number
  porTipo: Record<string, { cantidad: number; totalPEN: number; items: string[] }>
  ahorroPotencialFamiliar: number
}

// Agregados derivados de la lista de suscripciones. Se recalcula tras aplicar los
// overrides del usuario (ocultar/dividir cambian la lista) — ver subscription-overrides.ts.
export function computeAggregates(
  suscripciones: SuscripcionDetectada[]
): Omit<DeteccionResult, 'suscripciones'> {
  let totalPEN = 0
  let totalUSD = 0
  for (const sub of suscripciones) {
    if (sub.moneda === 'USD') totalUSD += sub.monto_detectado
    else totalPEN += sub.monto_detectado
  }

  const porTipo: Record<string, { cantidad: number; totalPEN: number; items: string[] }> = {}
  for (const sub of suscripciones) {
    if (!porTipo[sub.tipo]) porTipo[sub.tipo] = { cantidad: 0, totalPEN: 0, items: [] }
    porTipo[sub.tipo].cantidad += 1
    porTipo[sub.tipo].totalPEN += sub.monto_pen
    porTipo[sub.tipo].items.push(sub.nombre)
  }

  // Ahorro potencial si migra a plan familiar y comparte con 1 persona
  let ahorro = 0
  for (const sub of suscripciones) {
    if (sub.tiene_plan_familiar && sub.precio_familiar && sub.precio_referencia) {
      const costoCompartido = sub.precio_familiar / 2
      if (costoCompartido < sub.monto_detectado) {
        const diff = sub.monto_detectado - costoCompartido
        ahorro += sub.moneda === 'USD' ? diff * TC_APROXIMADO : diff
      }
    }
  }

  return {
    totalMensualPEN: Math.round((totalPEN + totalUSD * TC_APROXIMADO) * 100) / 100,
    totalMensualUSD: Math.round(totalUSD * 100) / 100,
    cantidad: suscripciones.length,
    porTipo,
    ahorroPotencialFamiliar: Math.round(ahorro * 100) / 100,
  }
}

export function buildSuscripciones(txs: Transaccion[]): SuscripcionDetectada[] {
  // Agrupar por catalog id (para juntar grafías del mismo servicio) o por string.
  const groups: Record<string, {
    catalogMatch: CatalogEntry | null
    nombre: string
    subcategoria: string
    pagos: PagoRaw[]
    moneda: 'USD' | 'PEN'
  }> = {}

  for (const tx of txs) {
    if (tx.tipo !== 'gasto') continue
    const nombre = (tx.comercio || 'Sin comercio').trim()
    if (!nombre) continue
    const match = matchCatalogo(nombre)
    const groupKey = match ? `catalog:${match.id}` : `comercio:${nombre.toLowerCase()}`
    const subKey = normalizeSubcategoriaKey(tx.subcategoria)

    if (!groups[groupKey]) {
      groups[groupKey] = {
        catalogMatch: match,
        nombre: match ? match.nombre : nombre,
        subcategoria: match ? match.tipo : subKey,
        pagos: [],
        moneda: (tx.moneda || 'PEN') as 'USD' | 'PEN',
      }
    } else if (!match && groups[groupKey].subcategoria === 'otros' && subKey !== 'otros') {
      groups[groupKey].subcategoria = subKey
    }
    groups[groupKey].pagos.push({
      monto: tx.monto,
      montoPen: tx.monto_pen || tx.monto,
      fecha: tx.fecha,
      moneda: tx.moneda || 'PEN',
    })
  }

  const suscripciones: SuscripcionDetectada[] = []

  for (const [key, data] of Object.entries(groups)) {
    if (data.pagos.length === 0) continue
    const { catalogMatch: match } = data

    const mesesConPago = new Set(data.pagos.map((p) => p.fecha.substring(0, 7)))
    const sortedPagos = [...data.pagos].sort((a, b) => b.fecha.localeCompare(a.fecha))
    const ultimoPago = sortedPagos[0]
    const moneda = data.moneda

    // Cuota recurrente = cluster de pagos que más meses abarca (no la suma del mes).
    const { recurring } = recurringCluster(data.pagos)
    const recSet = new Set(recurring)
    const cuotaMonto = median(recurring.map((p) => p.monto))
    const cuotaMontoPen = median(recurring.map((p) => p.montoPen))

    if (!match) {
      // Rama por patrón (sin catálogo): exige recurrencia real (2+ meses) y monto
      // estable, igual que el motor del backend. La query ya filtra categoría
      // 'Suscripciones', así que aquí solo confirmamos que es recurrente.
      if (mesesConPago.size < 2) continue
      const montos = data.pagos.map((p) => p.monto)
      const avg = montos.reduce((a, b) => a + b, 0) / montos.length
      const varianza = montos.reduce((s, m) => s + Math.pow(m - avg, 2), 0) / montos.length
      const coefVar = avg > 0 ? Math.sqrt(varianza) / avg : 1
      if (coefVar >= 0.3 || avg <= 2) continue
    }

    const estado: 'activa' | 'posible' = mesesConPago.size >= 2 ? 'activa' : 'posible'
    const subcatLabel = TIPO_LABELS[data.subcategoria] ? data.subcategoria : 'otros'
    const precioRef = match ? (match.precio_local_pen ?? match.precio_mensual) : null

    suscripciones.push({
      id: match ? match.id : key,
      nombre: data.nombre,
      tipo: (match ? match.tipo : subcatLabel) as TipoSuscripcion,
      icono: match ? match.icono : (TIPO_LABELS[subcatLabel]?.emoji || '🔄'),
      fuente: match ? 'catalogo' : 'patron',
      estado,
      moneda,
      monto_detectado: Math.round(cuotaMonto * 100) / 100,
      monto_pen: Math.round(cuotaMontoPen * 100) / 100,
      precio_referencia: precioRef,
      tiene_plan_familiar: match ? match.tiene_plan_familiar : false,
      precio_familiar: match ? match.precio_familiar : null,
      meses_detectados: mesesConPago.size,
      ultimo_pago: ultimoPago.fecha,
      categoria_neto: match ? match.categoria_neto : 'Suscripciones',
      subcategoria_neto: match ? match.subcategoria_neto : data.subcategoria,
      planes_disponibles: match ? match.planes : [],
      pagos_detalle: sortedPagos.map((p) => ({
        monto: p.monto,
        monto_pen: p.montoPen,
        moneda: p.moneda,
        fecha: p.fecha,
        recurrente: recSet.has(p),
      })),
    })
  }

  suscripciones.sort((a, b) => b.monto_pen - a.monto_pen)
  return suscripciones
}

function detectarSuscripcionesFromTxs(txs: Transaccion[]): DeteccionResult {
  const suscripciones = buildSuscripciones(txs)
  return { suscripciones, ...computeAggregates(suscripciones) }
}

export function useSubscriptions(usuarioId?: string) {
  return useQuery({
    queryKey: ['subscriptions', usuarioId],
    queryFn: async (): Promise<DeteccionResult> => {
      if (IS_DEMO) {
        const demoSubs = DEMO_TRANSACTIONS.filter(
          (t) => t.tipo === 'gasto' && t.categoria === 'Suscripciones'
        )
        return detectarSuscripcionesFromTxs(demoSubs)
      }

      if (!usuarioId) return { suscripciones: [], totalMensualPEN: 0, totalMensualUSD: 0, cantidad: 0, porTipo: {}, ahorroPotencialFamiliar: 0 }

      const supabase = createClient()

      // Traer solo transacciones de la categoría "Suscripciones" (últimos 3 meses)
      const hace3Meses = new Date()
      hace3Meses.setMonth(hace3Meses.getMonth() - 3)
      const desde = hace3Meses.toISOString().split('T')[0]

      const { data, error } = await supabase
        .from('transacciones')
        .select('*')
        .eq('usuario_id', usuarioId)
        .eq('tipo', 'gasto')
        .eq('categoria', 'Suscripciones')
        .gte('fecha', desde)
        .order('fecha', { ascending: false })

      if (error) throw error
      return detectarSuscripcionesFromTxs(data || [])
    },
    enabled: IS_DEMO || !!usuarioId,
    staleTime: 5 * 60 * 1000, // 5 minutos
  })
}
