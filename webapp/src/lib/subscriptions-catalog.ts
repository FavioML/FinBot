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

// Tipo de cambio aproximado para conversiones en el frontend
export const TC_APROXIMADO = 3.75

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
