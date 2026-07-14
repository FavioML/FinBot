export const CATEGORIAS = [
  { nombre: 'Alimentación', emoji: '🍽️', subs: ['delivery','restaurante','supermercado','mercado','cafeteria','snacks'] },
  { nombre: 'Transporte', emoji: '🚌', subs: ['uber_cabify','taxi','bus_micro','metro_bus','gasolina','peaje','estacionamiento'] },
  { nombre: 'Vivienda', emoji: '🏠', subs: ['alquiler','mantenimiento','electricidad','agua','gas','internet','cable'] },
  { nombre: 'Salud', emoji: '💊', subs: ['farmacia','medico','clinica','laboratorio','seguro_salud','optica'] },
  { nombre: 'Entretenimiento', emoji: '🎰', subs: ['cine','juegos','bares_clubs','eventos','hobbies'] },
  { nombre: 'Suscripciones', emoji: '🔄', subs: ['streaming','musica','software','gaming','almacenamiento','otros'] },
  { nombre: 'Compras', emoji: '🛒', subs: ['ropa','calzado','electronico','hogar','belleza','mascotas'] },
  { nombre: 'Educación', emoji: '📚', subs: ['universidad','instituto','curso_online','utiles','idiomas','colegios'] },
  { nombre: 'Finanzas', emoji: '💳', subs: ['prestamo','tarjeta_credito','seguro','ahorro','inversion','comision_banco'] },
  { nombre: 'Trabajo_Negocio', emoji: '💼', subs: ['herramientas','publicidad','oficina','logistica','contador'] },
  { nombre: 'Otros', emoji: '📋', subs: ['regalo','donacion','multa','viaje','sin_categoria'] }
] as const;

export const CATEGORIA_EMOJI: Record<string, string> = Object.fromEntries(
  CATEGORIAS.map(c => [c.nombre, c.emoji])
);

// Extended emoji mapping including non-canonical category names
const EMOJI_FALLBACK: Record<string, string> = {
  'Auto': '🚗',
  'Viajes': '✈️',
  'auto': '🚗',
  'viajes': '✈️',
  'comida': '🍽️',
  'hogar': '🏠',
  'entretenimiento': '🎰',
  'suscripciones': '🔄',
  'suscripcion': '🔄',
  'transporte': '🚌',
  'salud': '💊',
  'compras': '🛒',
  'educacion': '📚',
  'educación': '📚',
  'finanzas': '💳',
  'trabajo': '💼',
  'otros': '📋',
};

export function getCategoriaEmoji(categoria: string): string {
  // First try exact match in canonical
  if (CATEGORIA_EMOJI[categoria]) return CATEGORIA_EMOJI[categoria];
  // Then try fallback map
  if (EMOJI_FALLBACK[categoria]) return EMOJI_FALLBACK[categoria];
  // Try case-insensitive
  const lower = categoria.toLowerCase();
  for (const [key, emoji] of Object.entries(EMOJI_FALLBACK)) {
    if (key.toLowerCase() === lower) return emoji;
  }
  // Try partial match
  if (lower.includes('comida') || lower.includes('aliment')) return '🍽️';
  if (lower.includes('auto') || lower.includes('transport')) return '🚗';
  if (lower.includes('viaje')) return '✈️';
  if (lower.includes('casa') || lower.includes('hogar') || lower.includes('vivien')) return '🏠';
  if (lower.includes('salud') || lower.includes('medic')) return '💊';
  if (lower.includes('suscri')) return '🔄';
  if (lower.includes('entret')) return '🎰';
  if (lower.includes('compra')) return '🛒';
  if (lower.includes('educ')) return '📚';
  if (lower.includes('finanz')) return '💳';
  if (lower.includes('trabaj') || lower.includes('negocio')) return '💼';
  // Default
  return '📋';
}

// Valor centinela del filtro "Por revisar". No es una categoria real: nunca debe
// coincidir con un nombre que el usuario pueda crear.
export const CATEGORIA_POR_REVISAR = '__por_revisar__';

// Una transaccion "por revisar" es la que la clasificacion no supo ubicar: cayo
// en la categoria paraguas "Otros", o la NLP marco la subcategoria como fallida.
// La NLP escribe ese fallo de dos formas ('Sin_categoria' y el string 'null'), y
// el casing varia segun la fuente, asi que se normaliza antes de comparar.
//
// Una subcategoria NULL/vacia NO cuenta: significa "nunca se asigno subcategoria",
// que es un estado normal (una transaccion Uber -> Transporte sin sub esta bien
// clasificada). Meterla aqui inundaria la vista de falsos positivos.
export function needsReview(t: { categoria?: string | null; subcategoria?: string | null }): boolean {
  const cat = (t.categoria ?? '').trim().toLowerCase();
  const sub = (t.subcategoria ?? '').trim().toLowerCase();
  return cat === 'otros' || sub === 'sin_categoria' || sub === 'null';
}

export const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

export const SOCIAL_LINKS = {
  whatsapp: 'https://wa.me/51933014505',
  facebook: 'https://www.facebook.com/profile.php?id=61578664208419',
  instagram: 'https://www.instagram.com/neto_peru/',
  tiktok: 'https://www.tiktok.com/@neto_peru',
  web: 'https://neto.pe',
};

// --- Admin / unit economics ---
import type { AdminCostCategory, AdminCostFrequency } from './types-admin';

export const COST_PER_PRO_USER_PEN = 0.78;
export const PRO_PRICE_MONTHLY_PEN = 10;
export const PRO_PRICE_YEARLY_PEN = 99;
export const CAC_REFERIDOS_PEN = 3.33;

export const ADMIN_COST_CATEGORY_LABELS: Record<AdminCostCategory, string> = {
  infra: 'Infraestructura',
  domain: 'Dominio',
  comms: 'Comunicaciones',
  ai: 'IA',
  compliance: 'Compliance',
  tooling: 'Herramientas',
  other: 'Otro',
};

export const ADMIN_COST_FREQUENCY_LABELS: Record<AdminCostFrequency, string> = {
  monthly: 'Mensual',
  yearly: 'Anual',
  one_time: 'Único',
};
