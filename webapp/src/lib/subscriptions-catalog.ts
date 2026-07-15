// ═══════════════════════════════════════════════════════════════
// CATÁLOGO DE SUSCRIPCIONES — Frontend (app.neto.pe)
// Fuente única alineada con el backend (services/subscriptions/catalog.js).
// Precios locales en PEN donde el servicio cobra en soles (Netflix, Spotify…),
// planes reales peruanos, precio_familiar y patrones afinados.
// NO duplicar catálogos: el hook use-subscriptions y recurring-payments
// consumen este módulo (matchCatalogo es la única fuente de dedup).
// ═══════════════════════════════════════════════════════════════

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
  | 'software'
  | 'almacenamiento'
  | 'otros'
  | 'otro'

export interface PlanSuscripcion {
  nombre: string
  precio: number
}

export interface CatalogEntry {
  id: string
  nombre: string
  tipo: TipoSuscripcion
  categoria_neto: string
  subcategoria_neto: string
  moneda: 'USD' | 'PEN'
  /** Precio mensual en su moneda (null si no es suscripción fija, ej. Steam) */
  precio_mensual: number | null
  /** Precio en PEN si el servicio cobra directo en soles (null si cobra en USD) */
  precio_local_pen: number | null
  tiene_plan_familiar: boolean
  precio_familiar: number | null
  planes: PlanSuscripcion[]
  patrones: string[]
  icono: string
  popular: boolean
}

export interface SuscripcionDetectada {
  id: string
  nombre: string
  tipo: TipoSuscripcion
  icono: string
  fuente: 'catalogo' | 'patron'
  estado: 'activa' | 'posible'
  moneda: 'USD' | 'PEN'
  /** Cuota recurrente por ocurrencia (NO la suma del mes) */
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
  /** Todos los pagos; `recurrente=false` marca cargos puntuales/recargos aparte de la cuota */
  pagos_detalle: PagoDetalle[]
  /** Plan marcado a mano por el usuario (override plan_nombre). Resalta ese plan como "el tuyo". */
  plan_actual?: string | null
  /** True si el usuario aplicó algún override (renombrar/plan/dividir) sobre esta sub. */
  es_override?: boolean
  /** Si la sub salió de dividir un descriptor opaco, id de la sub base (para deshacer). */
  split_parent_id?: string | null
}

// Labels for catalog tipos
export const TIPO_LABELS: Record<string, { label: string; emoji: string }> = {
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
  software: { label: 'Software', emoji: '💻' },
  almacenamiento: { label: 'Almacenamiento', emoji: '☁️' },
  otros: { label: 'Otros', emoji: '📋' },
  otro: { label: 'Otro', emoji: '📋' },
}

// ═══════════════════════════════════════════════════════════════
// CATÁLOGO — portado de services/subscriptions/catalog.js
// ═══════════════════════════════════════════════════════════════

export const CATALOGO_SUSCRIPCIONES: CatalogEntry[] = [
  // ─── STREAMING ───
  { id: 'netflix', nombre: 'Netflix', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'PEN', precio_mensual: 25.90, precio_local_pen: 25.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Con anuncios', precio: 19.00 }, { nombre: 'Estándar', precio: 25.90 }, { nombre: 'Premium', precio: 39.90 }], patrones: ['netflix', 'dlocal*netflix', 'netflix.com', 'nflx'], icono: '🎬', popular: true },
  { id: 'disney_plus', nombre: 'Disney+', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'PEN', precio_mensual: 19.90, precio_local_pen: 19.90, tiene_plan_familiar: true, precio_familiar: 39.90, planes: [{ nombre: 'Básico', precio: 19.90 }, { nombre: 'Sin anuncios', precio: 29.90 }, { nombre: 'Premium (inc. Star+)', precio: 39.90 }], patrones: ['disney+', 'disney plus', 'disneyplus', 'dlocal*disney', 'the walt disney', 'dis*disneyplus'], icono: '🏰', popular: true },
  { id: 'hbo_max', nombre: 'Max (HBO)', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'PEN', precio_mensual: 19.90, precio_local_pen: 19.90, tiene_plan_familiar: true, precio_familiar: 39.90, planes: [{ nombre: 'Con anuncios', precio: 19.90 }, { nombre: 'Sin anuncios', precio: 39.90 }], patrones: ['hbo', 'hbo max', 'max.com', 'warnermedia', 'hbomax', 'max*subscription'], icono: '🎭', popular: true },
  { id: 'amazon_prime', nombre: 'Amazon Prime', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 14.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Prime Video', precio: 8.99 }, { nombre: 'Prime completo', precio: 14.99 }], patrones: ['amazon prime', 'amzn prime', 'prime video'], icono: '📦', popular: true },
  { id: 'apple_tv', nombre: 'Apple TV+', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 9.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 9.99, planes: [{ nombre: 'Individual', precio: 9.99 }], patrones: ['apple tv', 'apple tv+'], icono: '🍎', popular: false },
  { id: 'paramount_plus', nombre: 'Paramount+', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 5.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Essential', precio: 5.99 }, { nombre: 'Con SHOWTIME', precio: 11.99 }], patrones: ['paramount+', 'paramount plus', 'paramountplus'], icono: '⛰️', popular: false },
  { id: 'crunchyroll', nombre: 'Crunchyroll', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 7.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Fan', precio: 7.99 }, { nombre: 'Mega Fan', precio: 9.99 }], patrones: ['crunchyroll', 'crunchy'], icono: '🍥', popular: false },
  { id: 'vix_plus', nombre: 'ViX Premium', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 6.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Premium', precio: 6.99 }], patrones: ['vix', 'vix+', 'vix premium', 'televisa'], icono: '📺', popular: false },
  { id: 'apple_one', nombre: 'Apple One', tipo: 'streaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 19.95, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 25.95, planes: [{ nombre: 'Individual', precio: 19.95 }, { nombre: 'Familiar (6)', precio: 25.95 }, { nombre: 'Premier', precio: 37.95 }], patrones: ['apple one'], icono: '🍎', popular: false },

  // ─── MÚSICA ───
  { id: 'spotify', nombre: 'Spotify', tipo: 'musica', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'PEN', precio_mensual: 17.90, precio_local_pen: 17.90, tiene_plan_familiar: true, precio_familiar: 33.90, planes: [{ nombre: 'Estudiante', precio: 10.90 }, { nombre: 'Individual', precio: 17.90 }, { nombre: 'Duo', precio: 26.90 }, { nombre: 'Familiar (6)', precio: 33.90 }], patrones: ['spotify', 'spotify.com', 'spotify ab'], icono: '🎵', popular: true },
  { id: 'apple_music', nombre: 'Apple Music', tipo: 'musica', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'PEN', precio_mensual: 19.90, precio_local_pen: 19.90, tiene_plan_familiar: true, precio_familiar: 29.90, planes: [{ nombre: 'Estudiante', precio: 9.90 }, { nombre: 'Individual', precio: 19.90 }, { nombre: 'Familiar (6)', precio: 29.90 }], patrones: ['apple music'], icono: '🎶', popular: false },
  { id: 'youtube_premium', nombre: 'YouTube Premium', tipo: 'musica', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'PEN', precio_mensual: 23.90, precio_local_pen: 23.90, tiene_plan_familiar: true, precio_familiar: 38.90, planes: [{ nombre: 'Individual', precio: 23.90 }, { nombre: 'Familiar (5)', precio: 38.90 }], patrones: ['youtube premium', 'youtube music', 'google*youtube', 'google*youtubepre', 'yt premium'], icono: '▶️', popular: true },
  { id: 'deezer', nombre: 'Deezer', tipo: 'musica', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 10.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 17.99, planes: [{ nombre: 'Premium', precio: 10.99 }, { nombre: 'Familiar', precio: 17.99 }], patrones: ['deezer'], icono: '🎧', popular: false },

  // ─── GAMING ───
  { id: 'xbox_gamepass', nombre: 'Xbox Game Pass', tipo: 'gaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'juegos', moneda: 'USD', precio_mensual: 17.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Core', precio: 9.99 }, { nombre: 'Standard', precio: 14.99 }, { nombre: 'Ultimate', precio: 17.99 }], patrones: ['xbox', 'microsoft*xbox', 'xbox game pass', 'xboxlive'], icono: '🎮', popular: false },
  { id: 'playstation_plus', nombre: 'PlayStation Plus', tipo: 'gaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'juegos', moneda: 'USD', precio_mensual: 17.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Essential', precio: 9.99 }, { nombre: 'Extra', precio: 14.99 }, { nombre: 'Premium', precio: 17.99 }], patrones: ['playstation', 'psn', 'sony interactive', 'ps plus'], icono: '🕹️', popular: false },
  { id: 'nintendo_online', nombre: 'Nintendo Switch Online', tipo: 'gaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'juegos', moneda: 'USD', precio_mensual: 3.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 34.99, planes: [{ nombre: 'Individual', precio: 3.99 }, { nombre: 'Familiar', precio: 34.99 }], patrones: ['nintendo'], icono: '🍄', popular: false },
  { id: 'steam', nombre: 'Steam', tipo: 'gaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'juegos', moneda: 'USD', precio_mensual: null, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [], patrones: ['steam', 'steampowered', 'valve'], icono: '🎲', popular: false },
  { id: 'ea_play', nombre: 'EA Play', tipo: 'gaming', categoria_neto: 'Entretenimiento', subcategoria_neto: 'juegos', moneda: 'USD', precio_mensual: 4.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'EA Play', precio: 4.99 }, { nombre: 'EA Play Pro', precio: 14.99 }], patrones: ['ea play', 'ea*play', 'electronic arts'], icono: '⚽', popular: false },

  // ─── CLOUD ───
  { id: 'google_one', nombre: 'Google One', tipo: 'cloud', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 1.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 1.99, planes: [{ nombre: '100 GB', precio: 1.99 }, { nombre: '200 GB', precio: 2.99 }, { nombre: '2 TB', precio: 9.99 }], patrones: ['google one', 'google storage', 'google drive'], icono: '☁️', popular: true },
  { id: 'icloud', nombre: 'iCloud+', tipo: 'cloud', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 0.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 0.99, planes: [{ nombre: '50 GB', precio: 0.99 }, { nombre: '200 GB', precio: 2.99 }, { nombre: '2 TB', precio: 9.99 }, { nombre: '6 TB', precio: 29.99 }, { nombre: '12 TB', precio: 59.99 }], patrones: ['icloud', 'apple icloud'], icono: '🍏', popular: true },
  { id: 'dropbox', nombre: 'Dropbox', tipo: 'cloud', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 11.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 16.99, planes: [{ nombre: 'Plus', precio: 11.99 }, { nombre: 'Professional', precio: 24.99 }, { nombre: 'Family', precio: 16.99 }], patrones: ['dropbox'], icono: '📁', popular: false },

  // ─── HERRAMIENTAS IA ───
  { id: 'chatgpt', nombre: 'ChatGPT Plus', tipo: 'ai', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 20.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 20.00 }, { nombre: 'Pro', precio: 200.00 }], patrones: ['chatgpt', 'openai', 'open ai'], icono: '🤖', popular: true },
  { id: 'claude', nombre: 'Claude', tipo: 'ai', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 20.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 20.00 }, { nombre: 'Max 5x', precio: 100.00 }, { nombre: 'Max 20x', precio: 200.00 }], patrones: ['claude', 'claude.ai', 'anthropic'], icono: '🧠', popular: false },
  { id: 'midjourney', nombre: 'Midjourney', tipo: 'ai', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 10.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Basic', precio: 10.00 }, { nombre: 'Standard', precio: 30.00 }, { nombre: 'Pro', precio: 60.00 }], patrones: ['midjourney'], icono: '🎨', popular: false },
  { id: 'copilot', nombre: 'Microsoft Copilot Pro', tipo: 'ai', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 20.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 20.00 }], patrones: ['copilot', 'microsoft*copilot'], icono: '✨', popular: false },
  { id: 'gemini', nombre: 'Google Gemini Advanced', tipo: 'ai', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 19.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Advanced (Google One AI Premium)', precio: 19.99 }], patrones: ['gemini', 'google*ai', 'google one ai'], icono: '💎', popular: false },
  { id: 'perplexity', nombre: 'Perplexity Pro', tipo: 'ai', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 20.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 20.00 }], patrones: ['perplexity'], icono: '🔍', popular: false },

  // ─── PRODUCTIVIDAD / SOFTWARE ───
  { id: 'microsoft_365', nombre: 'Microsoft 365', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 6.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 9.99, planes: [{ nombre: 'Personal', precio: 6.99 }, { nombre: 'Familiar', precio: 9.99 }], patrones: ['microsoft 365', 'microsoft*office', 'office 365', 'ms 365'], icono: '📎', popular: true },
  { id: 'canva', nombre: 'Canva Pro', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 14.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 14.99 }, { nombre: 'Teams', precio: 10.00 }], patrones: ['canva'], icono: '🎨', popular: true },
  { id: 'adobe_cc', nombre: 'Adobe Creative Cloud', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 54.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Fotografía', precio: 9.99 }, { nombre: 'App individual', precio: 22.99 }, { nombre: 'Todas las apps', precio: 54.99 }], patrones: ['adobe', 'adobe.com', 'adobe systems', 'adobe creative'], icono: '🖌️', popular: false },
  { id: 'notion', nombre: 'Notion', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 10.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 10.00 }, { nombre: 'Business', precio: 18.00 }], patrones: ['notion', 'notion.so'], icono: '📝', popular: false },
  { id: 'figma', nombre: 'Figma', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 15.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Professional', precio: 15.00 }, { nombre: 'Organization', precio: 45.00 }], patrones: ['figma'], icono: '🖼️', popular: false },
  { id: 'github', nombre: 'GitHub Pro', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 4.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 4.00 }, { nombre: 'Team', precio: 4.00 }, { nombre: 'Enterprise', precio: 21.00 }], patrones: ['github'], icono: '🐙', popular: false },
  { id: 'slack', nombre: 'Slack Pro', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 8.75, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 8.75 }, { nombre: 'Business+', precio: 12.50 }], patrones: ['slack'], icono: '💬', popular: false },
  { id: 'zoom', nombre: 'Zoom', tipo: 'comunicacion', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 13.33, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 13.33 }, { nombre: 'Business', precio: 21.99 }], patrones: ['zoom', 'zoom.us', 'zoom video'], icono: '📹', popular: false },
  { id: 'shopify', nombre: 'Shopify', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 39.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Basic', precio: 39.00 }, { nombre: 'Shopify', precio: 105.00 }, { nombre: 'Advanced', precio: 399.00 }], patrones: ['shopify'], icono: '🛒', popular: false },
  { id: 'grammarly', nombre: 'Grammarly Premium', tipo: 'productividad', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 12.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Premium', precio: 12.00 }], patrones: ['grammarly'], icono: '✏️', popular: false },

  // ─── DEV / INFRA (relevantes para usuarios técnicos; no están en el backend) ───
  { id: 'railway', nombre: 'Railway', tipo: 'software', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 5.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Hobby', precio: 5.00 }, { nombre: 'Pro', precio: 20.00 }], patrones: ['railway', 'railway.app'], icono: '🚂', popular: false },
  { id: 'vercel', nombre: 'Vercel', tipo: 'software', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 20.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 20.00 }], patrones: ['vercel'], icono: '▲', popular: false },
  { id: 'cloudflare', nombre: 'Cloudflare', tipo: 'software', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 5.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 25.00 }], patrones: ['cloudflare'], icono: '🌩️', popular: false },
  { id: 'supabase', nombre: 'Supabase', tipo: 'software', categoria_neto: 'Trabajo_Negocio', subcategoria_neto: 'herramientas', moneda: 'USD', precio_mensual: 25.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Pro', precio: 25.00 }], patrones: ['supabase'], icono: '⚡', popular: false },

  // ─── DELIVERY ───
  { id: 'rappi_prime', nombre: 'Rappi Prime', tipo: 'delivery', categoria_neto: 'Alimentación', subcategoria_neto: 'delivery', moneda: 'PEN', precio_mensual: 14.90, precio_local_pen: 14.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Prime', precio: 14.90 }], patrones: ['rappi prime', 'rappiprime'], icono: '🛵', popular: true },
  { id: 'pedidosya_plus', nombre: 'PedidosYa Plus', tipo: 'delivery', categoria_neto: 'Alimentación', subcategoria_neto: 'delivery', moneda: 'PEN', precio_mensual: 9.90, precio_local_pen: 9.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 9.90 }], patrones: ['pedidosya plus', 'pedidosyaplus'], icono: '🍔', popular: true },
  { id: 'didi_club', nombre: 'DiDi Club', tipo: 'delivery', categoria_neto: 'Transporte', subcategoria_neto: 'uber_cabify', moneda: 'PEN', precio_mensual: 9.90, precio_local_pen: 9.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Club', precio: 9.90 }], patrones: ['didi club'], icono: '🚗', popular: false },

  // ─── EDUCACIÓN ───
  { id: 'platzi', nombre: 'Platzi', tipo: 'educacion', categoria_neto: 'Educación', subcategoria_neto: 'curso_online', moneda: 'USD', precio_mensual: 26.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Expert', precio: 26.00 }, { nombre: 'Expert+ (anual)', precio: 16.58 }], patrones: ['platzi'], icono: '🎓', popular: true },
  { id: 'coursera', nombre: 'Coursera Plus', tipo: 'educacion', categoria_neto: 'Educación', subcategoria_neto: 'curso_online', moneda: 'USD', precio_mensual: 59.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus Mensual', precio: 59.00 }, { nombre: 'Plus Anual', precio: 33.25 }], patrones: ['coursera'], icono: '📚', popular: false },
  { id: 'duolingo', nombre: 'Duolingo Plus', tipo: 'educacion', categoria_neto: 'Educación', subcategoria_neto: 'idiomas', moneda: 'USD', precio_mensual: 6.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 9.99, planes: [{ nombre: 'Super', precio: 6.99 }, { nombre: 'Super Familiar', precio: 9.99 }], patrones: ['duolingo'], icono: '🦉', popular: true },
  { id: 'domestika', nombre: 'Domestika Plus', tipo: 'educacion', categoria_neto: 'Educación', subcategoria_neto: 'curso_online', moneda: 'USD', precio_mensual: 9.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 9.99 }], patrones: ['domestika'], icono: '🎯', popular: false },
  { id: 'udemy', nombre: 'Udemy', tipo: 'educacion', categoria_neto: 'Educación', subcategoria_neto: 'curso_online', moneda: 'USD', precio_mensual: null, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [], patrones: ['udemy'], icono: '🏫', popular: false },
  { id: 'linkedin_learning', nombre: 'LinkedIn Learning', tipo: 'educacion', categoria_neto: 'Educación', subcategoria_neto: 'curso_online', moneda: 'USD', precio_mensual: 19.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Individual', precio: 19.99 }], patrones: ['linkedin learning'], icono: '💼', popular: false },

  // ─── FITNESS / WELLNESS ───
  { id: 'strava', nombre: 'Strava', tipo: 'fitness', categoria_neto: 'Salud', subcategoria_neto: 'seguro_salud', moneda: 'USD', precio_mensual: 5.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Premium', precio: 5.00 }], patrones: ['strava'], icono: '🏃', popular: false },
  { id: 'calm', nombre: 'Calm', tipo: 'fitness', categoria_neto: 'Salud', subcategoria_neto: 'seguro_salud', moneda: 'USD', precio_mensual: 14.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Premium', precio: 14.99 }], patrones: ['calm', 'calm.com'], icono: '🧘', popular: false },
  { id: 'headspace', nombre: 'Headspace', tipo: 'fitness', categoria_neto: 'Salud', subcategoria_neto: 'seguro_salud', moneda: 'USD', precio_mensual: 12.99, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 99.99, planes: [{ nombre: 'Individual', precio: 12.99 }], patrones: ['headspace'], icono: '🧠', popular: false },

  // ─── NOTICIAS / LECTURA ───
  { id: 'kindle_unlimited', nombre: 'Kindle Unlimited', tipo: 'noticias', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 11.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Unlimited', precio: 11.99 }], patrones: ['kindle', 'kindle unlimited', 'amzn*kindle'], icono: '📖', popular: false },
  { id: 'audible', nombre: 'Audible', tipo: 'noticias', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 7.95, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 7.95 }, { nombre: 'Premium Plus', precio: 14.95 }], patrones: ['audible', 'amzn*audible'], icono: '🎧', popular: false },
  { id: 'el_comercio', nombre: 'El Comercio Digital', tipo: 'noticias', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'PEN', precio_mensual: 29.90, precio_local_pen: 29.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Digital', precio: 29.90 }], patrones: ['el comercio', 'elcomercio', 'grupo el comercio'], icono: '📰', popular: false },
  { id: 'gestion', nombre: 'Gestión Digital', tipo: 'noticias', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'PEN', precio_mensual: 19.90, precio_local_pen: 19.90, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Digital', precio: 19.90 }], patrones: ['gestion', 'diario gestion'], icono: '📊', popular: false },
  { id: 'medium', nombre: 'Medium', tipo: 'noticias', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 5.00, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Member', precio: 5.00 }], patrones: ['medium', 'medium.com'], icono: '📖', popular: false },
  { id: 'scribd', nombre: 'Scribd', tipo: 'noticias', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 11.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Individual', precio: 11.99 }], patrones: ['scribd'], icono: '📚', popular: false },

  // ─── VPN ───
  { id: 'nordvpn', nombre: 'NordVPN', tipo: 'vpn', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 12.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Mensual', precio: 12.99 }, { nombre: 'Anual', precio: 4.99 }, { nombre: '2 años', precio: 3.39 }], patrones: ['nordvpn', 'nord vpn', 'nordsec'], icono: '🔒', popular: false },
  { id: 'expressvpn', nombre: 'ExpressVPN', tipo: 'vpn', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 8.32, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Anual', precio: 8.32 }], patrones: ['expressvpn', 'express vpn'], icono: '🔒', popular: false },
  { id: 'surfshark', nombre: 'Surfshark', tipo: 'vpn', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 2.49, precio_local_pen: null, tiene_plan_familiar: true, precio_familiar: 2.49, planes: [{ nombre: '2 años', precio: 2.49 }, { nombre: 'Anual', precio: 3.99 }], patrones: ['surfshark'], icono: '🦈', popular: false },

  // ─── DATING ───
  { id: 'tinder', nombre: 'Tinder', tipo: 'dating', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 14.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Plus', precio: 9.99 }, { nombre: 'Gold', precio: 14.99 }, { nombre: 'Platinum', precio: 24.99 }], patrones: ['tinder', 'match group'], icono: '🔥', popular: false },
  { id: 'bumble', nombre: 'Bumble', tipo: 'dating', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 16.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Premium', precio: 16.99 }, { nombre: 'Premium+', precio: 32.99 }], patrones: ['bumble'], icono: '🐝', popular: false },

  // ─── COMUNICACIÓN ───
  { id: 'discord_nitro', nombre: 'Discord Nitro', tipo: 'comunicacion', categoria_neto: 'Entretenimiento', subcategoria_neto: 'suscripciones', moneda: 'USD', precio_mensual: 9.99, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [{ nombre: 'Nitro Basic', precio: 2.99 }, { nombre: 'Nitro', precio: 9.99 }], patrones: ['discord', 'discord nitro'], icono: '🎙️', popular: false },

  // ─── FINANZAS ───
  { id: 'tyba', nombre: 'Tyba', tipo: 'finanzas', categoria_neto: 'Finanzas', subcategoria_neto: 'inversion', moneda: 'PEN', precio_mensual: null, precio_local_pen: null, tiene_plan_familiar: false, precio_familiar: null, planes: [], patrones: ['tyba', 'credicorp capital'], icono: '💰', popular: false },
]

// Forward-only match: el patrón del catálogo debe estar contenido en el nombre del
// comercio (cubre prefijos de pasarela como "DLOCAL*NETFLIX"). NO match inverso —
// evitaba que un comercio corto matchee por accidente ('ea' dentro de 'steam') o que
// un pedido 'pedidosya' matchee el plan 'pedidosya plus'. Fuente única de dedup.
export function matchCatalogo(comercio: string | null | undefined): CatalogEntry | null {
  if (!comercio) return null
  const lower = comercio.toLowerCase().trim()
  for (const sub of CATALOGO_SUSCRIPCIONES) {
    for (const patron of sub.patrones) {
      if (lower.includes(patron)) return sub
    }
  }
  return null
}

/** Lookup directo por id de catálogo (para overrides que fijan catalog_id, ej. split). */
export function getCatalogById(id: string | null | undefined): CatalogEntry | null {
  if (!id) return null
  return CATALOGO_SUSCRIPCIONES.find((c) => c.id === id) ?? null
}

// ═══════════════════════════════════════════════════════════════
// CUOTA RECURRENTE — separa la cuota que se repite de cargos puntuales
// ═══════════════════════════════════════════════════════════════

function monthSpan<T extends { fecha: string }>(pagos: T[]): number {
  return new Set(pagos.map((p) => p.fecha.substring(0, 7))).size
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Agrupa los pagos en clusters por monto (±10%) y devuelve el cluster que abarca
 * más meses distintos como la "cuota recurrente" (desempate → monto mayor, que
 * suele ser la suscripción base y no un recargo). El resto son cargos puntuales.
 * Corrige el bug de sumar 2 cargos del mismo mes como si fueran la cuota mensual.
 */
export function recurringCluster<T extends { monto: number; fecha: string }>(
  pagos: T[]
): { recurring: T[]; extras: T[] } {
  if (pagos.length <= 1) return { recurring: [...pagos], extras: [] }

  const clusters: T[][] = []
  for (const p of [...pagos].sort((a, b) => b.monto - a.monto)) {
    let placed = false
    for (const c of clusters) {
      const ref = c[0].monto
      if (ref > 0 && Math.abs(p.monto - ref) / ref <= 0.1) {
        c.push(p)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([p])
  }

  let best = clusters[0]
  let bestSpan = monthSpan(best)
  for (const c of clusters.slice(1)) {
    const span = monthSpan(c)
    if (span > bestSpan || (span === bestSpan && c[0].monto > best[0].monto)) {
      best = c
      bestSpan = span
    }
  }

  const extras = pagos.filter((p) => !best.includes(p))
  return { recurring: best, extras }
}

// ═══════════════════════════════════════════════════════════════
// CLUSTERS DE MONTO — para dividir un descriptor opaco (ej. "APPLE.COM/BILL")
// en varias suscripciones concurrentes, cada cluster de monto = un servicio.
// A diferencia de recurringCluster (que elige UN cluster como la cuota), acá
// devolvemos TODOS los clusters ordenados por meses abarcados.
// ═══════════════════════════════════════════════════════════════

export interface PagoDetalle {
  monto: number
  monto_pen: number
  moneda: string
  fecha: string
  recurrente: boolean
}

export interface AmountCluster {
  centroidPen: number
  pagos: PagoDetalle[]
  months: number
}

export function amountClusters(pagos: PagoDetalle[]): AmountCluster[] {
  const clusters: PagoDetalle[][] = []
  for (const p of [...pagos].sort((a, b) => b.monto_pen - a.monto_pen)) {
    let placed = false
    for (const c of clusters) {
      const ref = c[0].monto_pen
      if (ref > 0 && Math.abs(p.monto_pen - ref) / ref <= 0.12) {
        c.push(p)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([p])
  }
  return clusters
    .map((c) => ({
      centroidPen: median(c.map((p) => p.monto_pen)),
      pagos: c,
      months: new Set(c.map((p) => p.fecha.substring(0, 7))).size,
    }))
    .sort((a, b) => b.months - a.months || b.centroidPen - a.centroidPen)
}

// ═══════════════════════════════════════════════════════════════
// detectSubscriptions — total rápido de suscripciones para el overview
// (solo alimenta el texto de insight; la vista detallada usa use-subscriptions)
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
  const gastos = transactions.filter((t) => t.tipo === 'gasto')

  const matchMap = new Map<
    string,
    { entry: CatalogEntry; pagos: { monto: number; fecha: string }[] }
  >()

  for (const tx of gastos) {
    const entry = matchCatalogo(tx.comercio)
    if (!entry) continue
    if (!matchMap.has(entry.id)) matchMap.set(entry.id, { entry, pagos: [] })
    matchMap.get(entry.id)!.pagos.push({ monto: tx.monto_pen, fecha: tx.fecha })
  }

  const results: DetectedSubscription[] = []
  for (const [, data] of matchMap) {
    const { recurring } = recurringCluster(data.pagos)
    const monthly = Math.round(median(recurring.map((p) => p.monto)) * 100) / 100
    const months = monthSpan(data.pagos)
    const lastPayment = data.pagos.reduce((a, b) => (a > b.fecha ? a : b.fecha), '')
    const tipoInfo = TIPO_LABELS[data.entry.tipo] || TIPO_LABELS.otro
    results.push({
      id: data.entry.id,
      nombre: data.entry.nombre,
      icono: data.entry.icono,
      tipo: data.entry.tipo,
      tipoLabel: tipoInfo.label,
      monthlyAmount: monthly,
      annualProjection: Math.round(monthly * 12 * 100) / 100,
      monthsDetected: months,
      lastPayment,
    })
  }

  return results.sort((a, b) => b.annualProjection - a.annualProjection)
}

// ═══════════════════════════════════════════════════════════════
// Formateo / tipo de cambio
// ═══════════════════════════════════════════════════════════════

// Tipo de cambio referencial para conversiones frontend
export const TC_APROXIMADO = 3.85

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
