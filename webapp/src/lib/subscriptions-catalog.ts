// ═══════════════════════════════════════════════════════════════
// CATÁLOGO DE SUSCRIPCIONES — Frontend (app.neto.pe)
// Replica del catálogo backend para renderizado en webapp
// ═══════════════════════════════════════════════════════════════

export interface PlanSuscripcion {
  nombre: string
  precio: number
}

export interface SuscripcionCatalogo {
  id: string
  nombre: string
  tipo: TipoSuscripcion
  icono: string
  moneda: 'USD' | 'PEN'
  precio_mensual: number | null
  planes: PlanSuscripcion[]
  tiene_plan_familiar: boolean
  precio_familiar: number | null
  popular: boolean
  categoria_neto: string
  subcategoria_neto: string
}

export interface SuscripcionDetectada {
  id: string
  nombre: string
  tipo: TipoSuscripcion
  icono: string
  fuente: 'catalogo' | 'patron'
  estado: 'activa' | 'posible'
  moneda: 'USD' | 'PEN'
  monto_detectado: number
  monto_pen: number
  precio_referencia: number | null
  tiene_plan_familiar: boolean
  precio_familiar: number | null
  meses_detectados: number
  ultimo_pago: string
  categoria_neto: string
  subcategoria_neto: string
  planes_disponibles: PlanSuscripcion[]
  pagos_detalle: { monto: number; monto_pen: number; moneda: string; fecha: string }[]
}

export type TipoSuscripcion =
  | 'streaming'
  | 'musica'
  | 'gaming'
  | 'cloud'
  | 'ai'
  | 'productividad'
  | 'delivery'
  | 'educacion'
  | 'fitness'
  | 'noticias'
  | 'vpn'
  | 'comunicacion'
  | 'dating'
  | 'finanzas'
  | 'otro'

export const TIPO_LABELS: Record<TipoSuscripcion, { label: string; emoji: string }> = {
  streaming: { label: 'Streaming', emoji: '🎬' },
  musica: { label: 'Música', emoji: '🎵' },
  gaming: { label: 'Gaming', emoji: '🎮' },
  cloud: { label: 'Almacenamiento', emoji: '☁️' },
  ai: { label: 'Herramientas IA', emoji: '🤖' },
  productividad: { label: 'Productividad', emoji: '📎' },
  delivery: { label: 'Delivery', emoji: '🛵' },
  educacion: { label: 'Educación', emoji: '🎓' },
  fitness: { label: 'Fitness', emoji: '🏃' },
  noticias: { label: 'Noticias', emoji: '📰' },
  vpn: { label: 'VPN/Seguridad', emoji: '🔒' },
  comunicacion: { label: 'Comunicación', emoji: '📹' },
  dating: { label: 'Dating', emoji: '🔥' },
  finanzas: { label: 'Finanzas', emoji: '💰' },
  otro: { label: 'Otro', emoji: '🔄' },
}

// ═══════════════════════════════════════════════════════════════
// SUBSCRIPTION PATTERNS — For detecting subscriptions from transactions
// Each entry maps to a known digital service with matching patterns
// ═══════════════════════════════════════════════════════════════

export interface SubscriptionPattern {
  id: string
  nombre: string
  icono: string
  tipo: TipoSuscripcion
  patrones: string[]
  /** If set, only match transactions with amounts close to these values (±20%) */
  montos_validos?: number[]
}

export const SUBSCRIPTION_PATTERNS: SubscriptionPattern[] = [
  // Streaming
  { id: 'netflix', nombre: 'Netflix', icono: '🎬', tipo: 'streaming', patrones: ['netflix', 'dlocal*netflix', 'netflix.com', 'nflx'] },
  { id: 'disney_plus', nombre: 'Disney+', icono: '🏰', tipo: 'streaming', patrones: ['disney+', 'disney plus', 'disneyplus', 'dlocal*disney', 'the walt disney', 'dis*disneyplus'] },
  { id: 'hbo_max', nombre: 'Max (HBO)', icono: '🎭', tipo: 'streaming', patrones: ['hbo', 'hbo max', 'max.com', 'warnermedia', 'hbomax', 'max*subscription'] },
  { id: 'amazon_prime', nombre: 'Amazon Prime', icono: '📦', tipo: 'streaming', patrones: ['amazon prime', 'amzn prime', 'prime video', 'amzn'] },
  { id: 'apple_tv', nombre: 'Apple TV+', icono: '🍎', tipo: 'streaming', patrones: ['apple tv', 'apple.com/bill'] },
  { id: 'paramount_plus', nombre: 'Paramount+', icono: '⛰️', tipo: 'streaming', patrones: ['paramount+', 'paramount plus', 'paramountplus'] },
  { id: 'crunchyroll', nombre: 'Crunchyroll', icono: '🍥', tipo: 'streaming', patrones: ['crunchyroll', 'crunchy'] },
  { id: 'vix_plus', nombre: 'ViX Premium', icono: '📺', tipo: 'streaming', patrones: ['vix', 'vix+', 'vix premium', 'televisa'] },
  { id: 'apple_one', nombre: 'Apple One', icono: '🍎', tipo: 'streaming', patrones: ['apple one'] },

  // Musica
  { id: 'spotify', nombre: 'Spotify', icono: '🎵', tipo: 'musica', patrones: ['spotify', 'spotify.com', 'spotify ab'] },
  { id: 'apple_music', nombre: 'Apple Music', icono: '🎶', tipo: 'musica', patrones: ['apple music'] },
  { id: 'youtube_premium', nombre: 'YouTube Premium', icono: '▶️', tipo: 'musica', patrones: ['youtube premium', 'youtube music', 'google*youtube', 'google*youtubepre', 'yt premium'] },
  { id: 'deezer', nombre: 'Deezer', icono: '🎧', tipo: 'musica', patrones: ['deezer'] },

  // Gaming
  { id: 'xbox_gamepass', nombre: 'Xbox Game Pass', icono: '🎮', tipo: 'gaming', patrones: ['xbox', 'microsoft*xbox', 'xbox game pass', 'xboxlive'] },
  { id: 'playstation_plus', nombre: 'PlayStation Plus', icono: '🕹️', tipo: 'gaming', patrones: ['playstation', 'psn', 'sony interactive', 'ps plus'] },
  { id: 'nintendo_online', nombre: 'Nintendo Switch Online', icono: '🍄', tipo: 'gaming', patrones: ['nintendo'] },
  { id: 'steam', nombre: 'Steam', icono: '🎲', tipo: 'gaming', patrones: ['steam', 'steampowered', 'valve'] },
  { id: 'ea_play', nombre: 'EA Play', icono: '⚽', tipo: 'gaming', patrones: ['ea play', 'ea*play', 'electronic arts'] },

  // Cloud
  { id: 'google_one', nombre: 'Google One', icono: '☁️', tipo: 'cloud', patrones: ['google one', 'google*services', 'google storage', 'google drive'] },
  { id: 'icloud', nombre: 'iCloud+', icono: '🍏', tipo: 'cloud', patrones: ['icloud', 'apple icloud'] },
  { id: 'dropbox', nombre: 'Dropbox', icono: '📁', tipo: 'cloud', patrones: ['dropbox'] },

  // AI
  { id: 'chatgpt', nombre: 'ChatGPT Plus', icono: '🤖', tipo: 'ai', patrones: ['chatgpt', 'openai', 'open ai'] },
  { id: 'claude', nombre: 'Claude Pro', icono: '🧠', tipo: 'ai', patrones: ['claude', 'claude.ai', 'anthropic'] },
  { id: 'midjourney', nombre: 'Midjourney', icono: '🎨', tipo: 'ai', patrones: ['midjourney'] },
  { id: 'copilot', nombre: 'Microsoft Copilot Pro', icono: '✨', tipo: 'ai', patrones: ['copilot', 'microsoft*copilot'] },
  { id: 'gemini', nombre: 'Google Gemini Advanced', icono: '💎', tipo: 'ai', patrones: ['gemini', 'google*ai', 'google one ai'] },
  { id: 'perplexity', nombre: 'Perplexity Pro', icono: '🔍', tipo: 'ai', patrones: ['perplexity'] },

  // Productividad
  { id: 'microsoft_365', nombre: 'Microsoft 365', icono: '📎', tipo: 'productividad', patrones: ['microsoft 365', 'microsoft*office', 'office 365', 'ms 365'] },
  { id: 'canva', nombre: 'Canva Pro', icono: '🎨', tipo: 'productividad', patrones: ['canva'] },
  { id: 'adobe_cc', nombre: 'Adobe Creative Cloud', icono: '🖌️', tipo: 'productividad', patrones: ['adobe', 'adobe.com', 'adobe systems', 'adobe creative'] },
  { id: 'notion', nombre: 'Notion', icono: '📝', tipo: 'productividad', patrones: ['notion', 'notion.so'] },
  { id: 'figma', nombre: 'Figma', icono: '🖼️', tipo: 'productividad', patrones: ['figma'] },
  { id: 'github', nombre: 'GitHub Pro', icono: '🐙', tipo: 'productividad', patrones: ['github'] },
  { id: 'slack', nombre: 'Slack Pro', icono: '💬', tipo: 'productividad', patrones: ['slack'] },
  { id: 'shopify', nombre: 'Shopify', icono: '🛒', tipo: 'productividad', patrones: ['shopify'] },
  { id: 'grammarly', nombre: 'Grammarly Premium', icono: '✏️', tipo: 'productividad', patrones: ['grammarly'] },

  // Comunicacion
  { id: 'zoom', nombre: 'Zoom', icono: '📹', tipo: 'comunicacion', patrones: ['zoom', 'zoom.us', 'zoom video'] },
  { id: 'discord_nitro', nombre: 'Discord Nitro', icono: '🎙️', tipo: 'comunicacion', patrones: ['discord', 'discord nitro'] },

  // Delivery (solo suscripciones, NO pedidos individuales)
  { id: 'rappi_prime', nombre: 'Rappi Prime', icono: '🛵', tipo: 'delivery', patrones: ['rappi prime', 'rappi pro'] },
  { id: 'pedidosya_plus', nombre: 'PedidosYa Plus', icono: '🍔', tipo: 'delivery', patrones: ['pedidosya', 'pedidos ya'], montos_validos: [9.90, 16.90] },
  { id: 'didi_club', nombre: 'DiDi Club', icono: '🚗', tipo: 'delivery', patrones: ['didi club'] },

  // Educacion
  { id: 'platzi', nombre: 'Platzi', icono: '🎓', tipo: 'educacion', patrones: ['platzi'] },
  { id: 'coursera', nombre: 'Coursera Plus', icono: '📚', tipo: 'educacion', patrones: ['coursera'] },
  { id: 'duolingo', nombre: 'Duolingo Plus', icono: '🦉', tipo: 'educacion', patrones: ['duolingo'] },
  { id: 'domestika', nombre: 'Domestika Plus', icono: '🎯', tipo: 'educacion', patrones: ['domestika'] },
  { id: 'udemy', nombre: 'Udemy', icono: '🏫', tipo: 'educacion', patrones: ['udemy'] },
  { id: 'linkedin_learning', nombre: 'LinkedIn Learning', icono: '💼', tipo: 'educacion', patrones: ['linkedin learning', 'linkedin'] },

  // Fitness
  { id: 'strava', nombre: 'Strava', icono: '🏃', tipo: 'fitness', patrones: ['strava'] },
  { id: 'calm', nombre: 'Calm', icono: '🧘', tipo: 'fitness', patrones: ['calm', 'calm.com'] },
  { id: 'headspace', nombre: 'Headspace', icono: '🧠', tipo: 'fitness', patrones: ['headspace'] },

  // Noticias / Lectura
  { id: 'kindle_unlimited', nombre: 'Kindle Unlimited', icono: '📖', tipo: 'noticias', patrones: ['kindle', 'kindle unlimited', 'amzn*kindle'] },
  { id: 'audible', nombre: 'Audible', icono: '🎧', tipo: 'noticias', patrones: ['audible', 'amzn*audible'] },
  { id: 'el_comercio', nombre: 'El Comercio Digital', icono: '📰', tipo: 'noticias', patrones: ['el comercio', 'elcomercio', 'grupo el comercio'] },
  { id: 'gestion', nombre: 'Gestion Digital', icono: '📊', tipo: 'noticias', patrones: ['gestion', 'diario gestion'] },
  { id: 'medium', nombre: 'Medium', icono: '📖', tipo: 'noticias', patrones: ['medium', 'medium.com'] },
  { id: 'scribd', nombre: 'Scribd', icono: '📚', tipo: 'noticias', patrones: ['scribd'] },

  // VPN
  { id: 'nordvpn', nombre: 'NordVPN', icono: '🔒', tipo: 'vpn', patrones: ['nordvpn', 'nord vpn', 'nordsec'] },
  { id: 'expressvpn', nombre: 'ExpressVPN', icono: '🔒', tipo: 'vpn', patrones: ['expressvpn', 'express vpn'] },
  { id: 'surfshark', nombre: 'Surfshark', icono: '🦈', tipo: 'vpn', patrones: ['surfshark'] },

  // Dating
  { id: 'tinder', nombre: 'Tinder', icono: '🔥', tipo: 'dating', patrones: ['tinder', 'match group'] },
  { id: 'bumble', nombre: 'Bumble', icono: '🐝', tipo: 'dating', patrones: ['bumble'] },
]

// ═══════════════════════════════════════════════════════════════
// detectSubscriptions — match transactions against known patterns
// ═══════════════════════════════════════════════════════════════

export interface DetectedSubscription {
  id: string
  nombre: string
  icono: string
  tipo: TipoSuscripcion
  tipoLabel: string
  monthlyAmount: number
  annualProjection: number
  monthsDetected: number
  lastPayment: string
}

export function detectSubscriptions(
  transactions: Array<{
    tipo: string
    comercio?: string
    monto_pen: number
    fecha: string
  }>
): DetectedSubscription[] {
  const gastos = transactions.filter(t => t.tipo === 'gasto')

  // For each subscription pattern, collect matching transactions
  const matchMap = new Map<string, {
    pattern: SubscriptionPattern
    months: Set<string>
    amounts: number[]
    lastDate: string
  }>()

  for (const tx of gastos) {
    const comercio = (tx.comercio || '').toLowerCase().trim()
    if (!comercio || comercio === 'sin comercio') continue

    for (const sub of SUBSCRIPTION_PATTERNS) {
      const matched = sub.patrones.some(p => comercio.includes(p.toLowerCase()))
      if (matched) {
        // If montos_validos is set, only include payments close to valid amounts (±5%)
        if (sub.montos_validos) {
          const isValidAmount = sub.montos_validos.some(v => Math.abs(tx.monto_pen - v) / v <= 0.05)
          if (!isValidAmount) continue
        }
        if (!matchMap.has(sub.id)) {
          matchMap.set(sub.id, {
            pattern: sub,
            months: new Set(),
            amounts: [],
            lastDate: tx.fecha,
          })
        }
        const entry = matchMap.get(sub.id)!
        entry.months.add(tx.fecha.substring(0, 7))
        entry.amounts.push(tx.monto_pen)
        if (tx.fecha > entry.lastDate) entry.lastDate = tx.fecha
        break // one match per transaction
      }
    }
  }

  const results: DetectedSubscription[] = []

  for (const [, data] of matchMap) {
    // Require at least 1 month of data (it's a known service)
    const avg = data.amounts.reduce((s, a) => s + a, 0) / data.months.size
    const tipoInfo = TIPO_LABELS[data.pattern.tipo]
    results.push({
      id: data.pattern.id,
      nombre: data.pattern.nombre,
      icono: data.pattern.icono,
      tipo: data.pattern.tipo,
      tipoLabel: tipoInfo.label,
      monthlyAmount: Math.round(avg * 100) / 100,
      annualProjection: Math.round(avg * 12 * 100) / 100,
      monthsDetected: data.months.size,
      lastPayment: data.lastDate,
    })
  }

  return results.sort((a, b) => b.annualProjection - a.annualProjection)
}

// Tipo de cambio para conversiones frontend (se actualiza via /api/exchange-rate)
export let TC_APROXIMADO = 3.85

export function convertirAPEN(monto: number, moneda: 'USD' | 'PEN'): number {
  return moneda === 'USD' ? Math.round(monto * TC_APROXIMADO * 100) / 100 : monto
}

export function formatPrecio(monto: number, moneda: 'USD' | 'PEN'): string {
  if (moneda === 'USD') {
    return `$${monto.toFixed(2)}`
  }
  return `S/${monto.toFixed(2)}`
}

export function formatPrecioConversion(monto: number, moneda: 'USD' | 'PEN'): string {
  if (moneda === 'USD') {
    const pen = convertirAPEN(monto, 'USD')
    return `$${monto.toFixed(2)} (≈ S/${pen.toFixed(0)})`
  }
  return `S/${monto.toFixed(2)}`
}
