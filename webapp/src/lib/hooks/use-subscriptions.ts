'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Transaccion } from '@/lib/types';
import type { SuscripcionDetectada, TipoSuscripcion } from '@/lib/subscriptions-catalog';
import { TIPO_LABELS, TC_APROXIMADO } from '@/lib/subscriptions-catalog';

// ═══════════════════════════════════════════════════════════════
// CATÁLOGO DE ENRIQUECIMIENTO — Metadata extra para servicios conocidos
// Solo se usa para agregar iconos, planes y precios de referencia
// ═══════════════════════════════════════════════════════════════

interface CatalogoEntry {
  id: string
  nombre: string
  icono: string
  moneda: 'USD' | 'PEN'
  precio_mensual: number | null
  tiene_plan_familiar: boolean
  precio_familiar: number | null
  planes: { nombre: string; precio: number }[]
  patrones: string[]
}

const CATALOGO: CatalogoEntry[] = [
  // Streaming
  { id: 'netflix', nombre: 'Netflix', icono: '🎬', moneda: 'USD', precio_mensual: 15.49, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Con anuncios', precio: 6.99 }, { nombre: 'Estándar', precio: 15.49 }, { nombre: 'Premium', precio: 22.99 }], patrones: ['netflix', 'dlocal*netflix', 'nflx'] },
  { id: 'disney_plus', nombre: 'Disney+', icono: '🏰', moneda: 'USD', precio_mensual: 7.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Con anuncios', precio: 7.99 }, { nombre: 'Sin anuncios', precio: 13.99 }], patrones: ['disney+', 'disney plus', 'disneyplus', 'dlocal*disney'] },
  { id: 'hbo_max', nombre: 'Max (HBO)', icono: '🎭', moneda: 'USD', precio_mensual: 9.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Con anuncios', precio: 9.99 }, { nombre: 'Sin anuncios', precio: 16.99 }], patrones: ['hbo', 'hbo max', 'max.com', 'warnermedia', 'hbomax'] },
  { id: 'amazon_prime', nombre: 'Amazon Prime', icono: '📦', moneda: 'USD', precio_mensual: 14.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Prime Video', precio: 8.99 }, { nombre: 'Prime completo', precio: 14.99 }], patrones: ['amazon prime', 'amzn prime', 'prime video', 'amzn'] },
  { id: 'apple_tv', nombre: 'Apple TV+', icono: '🍎', moneda: 'USD', precio_mensual: 9.99, tiene_plan_familiar: true, precio_familiar: 9.99, planes: [{ nombre: 'Individual', precio: 9.99 }], patrones: ['apple tv'] },
  { id: 'paramount_plus', nombre: 'Paramount+', icono: '⛰️', moneda: 'USD', precio_mensual: 5.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Essential', precio: 5.99 }, { nombre: 'Con SHOWTIME', precio: 11.99 }], patrones: ['paramount+', 'paramount plus', 'paramountplus'] },
  { id: 'crunchyroll', nombre: 'Crunchyroll', icono: '🍥', moneda: 'USD', precio_mensual: 7.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Fan', precio: 7.99 }], patrones: ['crunchyroll'] },

  // Música
  { id: 'spotify', nombre: 'Spotify', icono: '🎵', moneda: 'USD', precio_mensual: 10.99, tiene_plan_familiar: true, precio_familiar: 16.99, planes: [{ nombre: 'Individual', precio: 10.99 }, { nombre: 'Duo', precio: 14.99 }, { nombre: 'Familiar', precio: 16.99 }, { nombre: 'Estudiante', precio: 5.99 }], patrones: ['spotify'] },
  { id: 'apple_music', nombre: 'Apple Music', icono: '🎶', moneda: 'USD', precio_mensual: 10.99, tiene_plan_familiar: true, precio_familiar: 16.99, planes: [{ nombre: 'Individual', precio: 10.99 }, { nombre: 'Familiar', precio: 16.99 }], patrones: ['apple music'] },
  { id: 'youtube_premium', nombre: 'YouTube Premium', icono: '▶️', moneda: 'USD', precio_mensual: 13.99, tiene_plan_familiar: true, precio_familiar: 22.99, planes: [{ nombre: 'Individual', precio: 13.99 }, { nombre: 'Familiar', precio: 22.99 }], patrones: ['youtube premium', 'youtube music', 'google*youtube', 'yt premium'] },

  // Gaming
  { id: 'xbox_gamepass', nombre: 'Xbox Game Pass', icono: '🎮', moneda: 'USD', precio_mensual: 17.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Core', precio: 9.99 }, { nombre: 'Ultimate', precio: 17.99 }], patrones: ['xbox', 'microsoft*xbox', 'xboxlive'] },
  { id: 'playstation_plus', nombre: 'PlayStation Plus', icono: '🕹️', moneda: 'USD', precio_mensual: 17.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Essential', precio: 9.99 }, { nombre: 'Premium', precio: 17.99 }], patrones: ['playstation', 'psn', 'sony interactive'] },

  // Cloud / Almacenamiento
  { id: 'google_one', nombre: 'Google One', icono: '☁️', moneda: 'USD', precio_mensual: 1.99, tiene_plan_familiar: true, precio_familiar: 1.99, planes: [{ nombre: '100 GB', precio: 1.99 }, { nombre: '200 GB', precio: 2.99 }, { nombre: '2 TB', precio: 9.99 }], patrones: ['google one', 'google*services', 'google storage', 'google drive'] },
  { id: 'icloud', nombre: 'iCloud+', icono: '🍏', moneda: 'USD', precio_mensual: 0.99, tiene_plan_familiar: true, precio_familiar: 0.99, planes: [{ nombre: '50 GB', precio: 0.99 }, { nombre: '200 GB', precio: 2.99 }, { nombre: '2 TB', precio: 9.99 }], patrones: ['icloud', 'apple icloud'] },
  { id: 'dropbox', nombre: 'Dropbox', icono: '📁', moneda: 'USD', precio_mensual: 11.99, tiene_plan_familiar: true, precio_familiar: 16.99, planes: [{ nombre: 'Plus', precio: 11.99 }], patrones: ['dropbox'] },

  // AI / Software
  { id: 'chatgpt', nombre: 'ChatGPT Plus', icono: '🤖', moneda: 'USD', precio_mensual: 20.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 20.00 }, { nombre: 'Pro', precio: 200.00 }], patrones: ['chatgpt', 'openai'] },
  { id: 'claude', nombre: 'Claude Pro', icono: '🧠', moneda: 'USD', precio_mensual: 20.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 20.00 }], patrones: ['claude', 'anthropic'] },
  { id: 'midjourney', nombre: 'Midjourney', icono: '🎨', moneda: 'USD', precio_mensual: 10.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Basic', precio: 10.00 }, { nombre: 'Standard', precio: 30.00 }], patrones: ['midjourney'] },

  // Productividad / Software
  { id: 'microsoft_365', nombre: 'Microsoft 365', icono: '📎', moneda: 'USD', precio_mensual: 6.99, tiene_plan_familiar: true, precio_familiar: 9.99, planes: [{ nombre: 'Personal', precio: 6.99 }, { nombre: 'Familiar', precio: 9.99 }], patrones: ['microsoft 365', 'microsoft*office', 'office 365'] },
  { id: 'canva', nombre: 'Canva Pro', icono: '🎨', moneda: 'USD', precio_mensual: 14.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 14.99 }], patrones: ['canva'] },
  { id: 'adobe_cc', nombre: 'Adobe Creative Cloud', icono: '🖌️', moneda: 'USD', precio_mensual: 54.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Fotografía', precio: 9.99 }, { nombre: 'Todas las apps', precio: 54.99 }], patrones: ['adobe', 'adobe.com', 'adobe systems'] },
  { id: 'notion', nombre: 'Notion', icono: '📝', moneda: 'USD', precio_mensual: 10.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 10.00 }], patrones: ['notion'] },
  { id: 'figma', nombre: 'Figma', icono: '🖼️', moneda: 'USD', precio_mensual: 15.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Professional', precio: 15.00 }], patrones: ['figma'] },
  { id: 'github', nombre: 'GitHub Pro', icono: '🐙', moneda: 'USD', precio_mensual: 4.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 4.00 }], patrones: ['github'] },

  // Comunicación
  { id: 'zoom', nombre: 'Zoom', icono: '📹', moneda: 'USD', precio_mensual: 13.33, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 13.33 }], patrones: ['zoom', 'zoom.us'] },
  { id: 'slack', nombre: 'Slack Pro', icono: '💬', moneda: 'USD', precio_mensual: 8.75, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 8.75 }], patrones: ['slack'] },

  // Noticias
  { id: 'el_comercio', nombre: 'El Comercio Digital', icono: '📰', moneda: 'PEN', precio_mensual: 29.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Digital', precio: 29.90 }], patrones: ['el comercio', 'elcomercio'] },

  // VPN
  { id: 'nordvpn', nombre: 'NordVPN', icono: '🔒', moneda: 'USD', precio_mensual: 12.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Mensual', precio: 12.99 }, { nombre: 'Anual', precio: 4.99 }], patrones: ['nordvpn', 'nordsec'] },

  // Fitness
  { id: 'strava', nombre: 'Strava', icono: '🏃', moneda: 'USD', precio_mensual: 5.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Premium', precio: 5.00 }], patrones: ['strava'] },

  // Delivery
  { id: 'rappi_prime', nombre: 'Rappi Prime', icono: '🛵', moneda: 'PEN', precio_mensual: 14.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Prime', precio: 14.90 }], patrones: ['rappi prime', 'rappi pro'] },
  { id: 'pedidosya_plus', nombre: 'PedidosYa Plus', icono: '🍔', moneda: 'PEN', precio_mensual: 16.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 16.90 }, { nombre: 'Plus (precio anterior)', precio: 9.90 }], patrones: ['pedidosya*plus', 'pedidosya plus', 'pedidos ya plus'] },

  // Educación
  { id: 'platzi', nombre: 'Platzi', icono: '🎓', moneda: 'USD', precio_mensual: 26.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Expert', precio: 26.00 }], patrones: ['platzi'] },
  { id: 'coursera', nombre: 'Coursera Plus', icono: '📚', moneda: 'USD', precio_mensual: 59.00, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 59.00 }], patrones: ['coursera'] },
  { id: 'duolingo', nombre: 'Duolingo Plus', icono: '🦉', moneda: 'USD', precio_mensual: 6.99, tiene_plan_familiar: true, precio_familiar: 9.99, planes: [{ nombre: 'Super', precio: 6.99 }], patrones: ['duolingo'] },

  // Dating
  { id: 'tinder', nombre: 'Tinder', icono: '🔥', moneda: 'USD', precio_mensual: 14.99, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 9.99 }, { nombre: 'Gold', precio: 14.99 }], patrones: ['tinder', 'match group'] },
]

function matchCatalogo(comercio: string): CatalogoEntry | null {
  if (!comercio) return null
  const lower = comercio.toLowerCase().trim()
  for (const sub of CATALOGO) {
    for (const patron of sub.patrones) {
      if (lower.includes(patron)) {
        return sub
      }
    }
  }
  return null
}

interface DeteccionResult {
  suscripciones: SuscripcionDetectada[]
  totalMensualPEN: number
  totalMensualUSD: number
  cantidad: number
  porTipo: Record<string, { cantidad: number; totalPEN: number; items: string[] }>
  ahorroPotencialFamiliar: number
}

function detectarSuscripcionesFromTxs(txs: Transaccion[]): DeteccionResult {
  // Agrupar por comercio — usar catalog ID para merge cuando hay match
  const groups: Record<string, {
    catalogMatch: CatalogoEntry | null
    nombre: string
    subcategoria: string
    pagos: { monto: number; montoPen: number; fecha: string; moneda: string }[]
    moneda: 'USD' | 'PEN'
  }> = {}

  for (const tx of txs) {
    if (tx.tipo !== 'gasto') continue
    const nombre = (tx.comercio || 'Sin comercio').trim()
    if (!nombre) continue
    const match = matchCatalogo(nombre)
    const groupKey = match ? `catalog:${match.id}` : `comercio:${nombre.toLowerCase()}`

    if (!groups[groupKey]) {
      groups[groupKey] = {
        catalogMatch: match,
        nombre: match ? match.nombre : nombre,
        subcategoria: tx.subcategoria || 'otros',
        pagos: [],
        moneda: match ? match.moneda : (tx.moneda || 'PEN') as 'USD' | 'PEN',
      }
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

    const mesesConPago = new Set(data.pagos.map(p => p.fecha.substring(0, 7)))
    const avgPen = data.pagos.reduce((s, p) => s + p.montoPen, 0) / mesesConPago.size
    const sortedPagos = [...data.pagos].sort((a, b) => b.fecha.localeCompare(a.fecha))
    const ultimoPago = sortedPagos[0]
    const moneda = data.moneda
    const montoDisplay = moneda === 'USD'
      ? Math.round(avgPen / TC_APROXIMADO * 100) / 100
      : Math.round(avgPen * 100) / 100

    // tipo = subcategoría real de la DB (no del catálogo)
    const subcatLabel = TIPO_LABELS[data.subcategoria] ? data.subcategoria : 'otros'

    suscripciones.push({
      id: match ? match.id : key,
      nombre: data.nombre,
      tipo: subcatLabel as TipoSuscripcion,
      icono: match ? match.icono : (TIPO_LABELS[subcatLabel]?.emoji || '📋'),
      fuente: match ? 'catalogo' : 'patron',
      estado: 'activa',
      moneda,
      monto_detectado: montoDisplay,
      monto_pen: Math.round(avgPen * 100) / 100,
      precio_referencia: match ? match.precio_mensual : null,
      tiene_plan_familiar: match ? match.tiene_plan_familiar : false,
      precio_familiar: match ? match.precio_familiar : null,
      meses_detectados: mesesConPago.size,
      ultimo_pago: ultimoPago.fecha,
      categoria_neto: 'Suscripciones',
      subcategoria_neto: data.subcategoria,
      planes_disponibles: match ? match.planes : [],
      pagos_detalle: sortedPagos.map(p => ({
        monto: p.monto,
        monto_pen: p.montoPen,
        moneda: p.moneda,
        fecha: p.fecha,
      })),
    })
  }

  suscripciones.sort((a, b) => b.monto_pen - a.monto_pen)

  let totalPEN = 0
  let totalUSD = 0
  for (const sub of suscripciones) {
    if (sub.moneda === 'USD') totalUSD += sub.monto_detectado
    else totalPEN += sub.monto_detectado
  }

  // Agrupar por subcategoría (tipo)
  const porTipo: Record<string, { cantidad: number; totalPEN: number; items: string[] }> = {}
  for (const sub of suscripciones) {
    if (!porTipo[sub.tipo]) porTipo[sub.tipo] = { cantidad: 0, totalPEN: 0, items: [] }
    porTipo[sub.tipo].cantidad += 1
    porTipo[sub.tipo].totalPEN += sub.monto_pen
    porTipo[sub.tipo].items.push(sub.nombre)
  }

  // Ahorro familiar
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
    suscripciones,
    totalMensualPEN: Math.round((totalPEN + totalUSD * TC_APROXIMADO) * 100) / 100,
    totalMensualUSD: Math.round(totalUSD * 100) / 100,
    cantidad: suscripciones.length,
    porTipo,
    ahorroPotencialFamiliar: Math.round(ahorro * 100) / 100,
  }
}

export function useSubscriptions(usuarioId?: string) {
  const supabase = createClient()

  return useQuery({
    queryKey: ['subscriptions', usuarioId],
    queryFn: async (): Promise<DeteccionResult> => {
      if (!usuarioId) return { suscripciones: [], totalMensualPEN: 0, totalMensualUSD: 0, cantidad: 0, porTipo: {}, ahorroPotencialFamiliar: 0 }

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
    enabled: !!usuarioId,
    staleTime: 5 * 60 * 1000, // 5 minutos
  })
}
