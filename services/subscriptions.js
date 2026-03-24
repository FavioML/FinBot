const { supabase } = require('../lib/db');
const log = require('../lib/logger');

// ═══════════════════════════════════════════════════════════════
// CATÁLOGO DE SUSCRIPCIONES — Servicios reales usados en Perú
// ═══════════════════════════════════════════════════════════════
// Cada entrada tiene:
//   id: identificador único
//   nombre: nombre visible al usuario
//   categoria_neto: categoría en el sistema NETO
//   subcategoria_neto: subcategoría en el sistema NETO
//   tipo: streaming | musica | gaming | cloud | ai | productividad | delivery | educacion | fitness | noticias | vpn | comunicacion | dating | finanzas
//   moneda: USD | PEN
//   precio_mensual: precio mensual aproximado (en su moneda)
//   precio_anual: precio anual si existe (null si no)
//   tiene_plan_familiar: boolean
//   precio_familiar: precio del plan familiar mensual (null si no aplica)
//   patrones: array de strings para match en nombre de comercio de transacciones
//   icono: emoji representativo
//   popular: boolean (top 20 en Perú)
//   precio_local_pen: precio en PEN si el servicio cobra directamente en soles (null si cobra en USD)
//   NOTA: Netflix, Spotify, Disney+, HBO y otros cobran en PEN con precio local en Perú
//         (más barato que la conversión USD). Cuando precio_local_pen existe, usar ese valor.

const CATALOGO_SUSCRIPCIONES = [
  // ─── STREAMING DE VIDEO ───
  {
    id: 'netflix',
    nombre: 'Netflix',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'PEN', // cobra en PEN con precio local peruano
    precio_mensual: 25.90,
    precio_local_pen: 25.90,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Con anuncios', precio: 19.00 },
      { nombre: 'Estándar', precio: 25.90 },
      { nombre: 'Premium', precio: 39.90 },
    ],
    patrones: ['netflix', 'dlocal*netflix', 'netflix.com', 'nflx'],
    icono: '🎬',
    popular: true,
  },
  {
    id: 'disney_plus',
    nombre: 'Disney+',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'PEN',
    precio_mensual: 19.90,
    precio_local_pen: 19.90,
    precio_anual: null,
    tiene_plan_familiar: true,
    precio_familiar: 39.90,
    planes: [
      { nombre: 'Básico', precio: 19.90 },
      { nombre: 'Sin anuncios', precio: 29.90 },
      { nombre: 'Premium (inc. Star+)', precio: 39.90 },
    ],
    patrones: ['disney+', 'disney plus', 'disneyplus', 'dlocal*disney', 'the walt disney', 'dis*disneyplus'],
    icono: '🏰',
    popular: true,
  },
  {
    id: 'hbo_max',
    nombre: 'Max (HBO)',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'PEN',
    precio_mensual: 19.90,
    precio_local_pen: 19.90,
    precio_anual: null,
    tiene_plan_familiar: true,
    precio_familiar: 39.90,
    planes: [
      { nombre: 'Con anuncios', precio: 19.90 },
      { nombre: 'Sin anuncios', precio: 39.90 },
    ],
    patrones: ['hbo', 'hbo max', 'max.com', 'warnermedia', 'hbomax', 'max*subscription'],
    icono: '🎭',
    popular: true,
  },
  {
    id: 'amazon_prime',
    nombre: 'Amazon Prime',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 14.99,
    precio_anual: 139.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Prime Video', precio: 8.99 },
      { nombre: 'Prime completo', precio: 14.99 },
    ],
    patrones: ['amazon prime', 'amzn prime', 'prime video', 'amazon.com', 'amzn'],
    icono: '📦',
    popular: true,
  },
  {
    id: 'apple_tv',
    nombre: 'Apple TV+',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 9.99,
    precio_anual: 99.00,
    tiene_plan_familiar: true,
    precio_familiar: 9.99, // incluido en plan familiar
    planes: [
      { nombre: 'Individual', precio: 9.99 },
    ],
    patrones: ['apple tv', 'apple.com/bill'],
    icono: '🍎',
    popular: false,
  },
  {
    id: 'paramount_plus',
    nombre: 'Paramount+',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 5.99,
    precio_anual: 59.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Essential', precio: 5.99 },
      { nombre: 'Con SHOWTIME', precio: 11.99 },
    ],
    patrones: ['paramount+', 'paramount plus', 'paramountplus'],
    icono: '⛰️',
    popular: false,
  },
  {
    id: 'crunchyroll',
    nombre: 'Crunchyroll',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 7.99,
    precio_anual: 79.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Fan', precio: 7.99 },
      { nombre: 'Mega Fan', precio: 9.99 },
    ],
    patrones: ['crunchyroll', 'crunchy'],
    icono: '🍥',
    popular: false,
  },
  {
    id: 'vix_plus',
    nombre: 'ViX Premium',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 6.99,
    precio_anual: 69.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Premium', precio: 6.99 },
    ],
    patrones: ['vix', 'vix+', 'vix premium', 'televisa'],
    icono: '📺',
    popular: false,
  },

  // ─── MÚSICA ───
  {
    id: 'spotify',
    nombre: 'Spotify',
    tipo: 'musica',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'PEN', // cobra en PEN con precio local
    precio_mensual: 17.90,
    precio_local_pen: 17.90,
    precio_anual: null,
    tiene_plan_familiar: true,
    precio_familiar: 33.90,
    planes: [
      { nombre: 'Estudiante', precio: 10.90 },
      { nombre: 'Individual', precio: 17.90 },
      { nombre: 'Duo', precio: 26.90 },
      { nombre: 'Familiar (6)', precio: 33.90 },
    ],
    patrones: ['spotify', 'spotify.com', 'spotify ab'],
    icono: '🎵',
    popular: true,
  },
  {
    id: 'apple_music',
    nombre: 'Apple Music',
    tipo: 'musica',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'PEN',
    precio_mensual: 19.90,
    precio_local_pen: 19.90,
    precio_anual: null,
    tiene_plan_familiar: true,
    precio_familiar: 29.90,
    planes: [
      { nombre: 'Estudiante', precio: 9.90 },
      { nombre: 'Individual', precio: 19.90 },
      { nombre: 'Familiar (6)', precio: 29.90 },
    ],
    patrones: ['apple music', 'apple.com/bill'],
    icono: '🎶',
    popular: false,
  },
  {
    id: 'youtube_premium',
    nombre: 'YouTube Premium',
    tipo: 'musica',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'PEN',
    precio_mensual: 23.90,
    precio_local_pen: 23.90,
    precio_anual: null,
    tiene_plan_familiar: true,
    precio_familiar: 38.90,
    planes: [
      { nombre: 'Individual', precio: 23.90 },
      { nombre: 'Familiar (5)', precio: 38.90 },
    ],
    patrones: ['youtube premium', 'youtube music', 'google*youtube', 'google*youtubepre', 'yt premium'],
    icono: '▶️',
    popular: true,
  },
  {
    id: 'deezer',
    nombre: 'Deezer',
    tipo: 'musica',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 10.99,
    precio_anual: null,
    tiene_plan_familiar: true,
    precio_familiar: 17.99,
    planes: [
      { nombre: 'Premium', precio: 10.99 },
      { nombre: 'Familiar', precio: 17.99 },
    ],
    patrones: ['deezer'],
    icono: '🎧',
    popular: false,
  },

  // ─── GAMING ───
  {
    id: 'xbox_gamepass',
    nombre: 'Xbox Game Pass',
    tipo: 'gaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'juegos',
    moneda: 'USD',
    precio_mensual: 17.99,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Core', precio: 9.99 },
      { nombre: 'Standard', precio: 14.99 },
      { nombre: 'Ultimate', precio: 17.99 },
    ],
    patrones: ['xbox', 'microsoft*xbox', 'xbox game pass', 'xboxlive'],
    icono: '🎮',
    popular: false,
  },
  {
    id: 'playstation_plus',
    nombre: 'PlayStation Plus',
    tipo: 'gaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'juegos',
    moneda: 'USD',
    precio_mensual: 17.99,
    precio_anual: 79.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Essential', precio: 9.99 },
      { nombre: 'Extra', precio: 14.99 },
      { nombre: 'Premium', precio: 17.99 },
    ],
    patrones: ['playstation', 'psn', 'sony interactive', 'ps plus'],
    icono: '🕹️',
    popular: false,
  },
  {
    id: 'nintendo_online',
    nombre: 'Nintendo Switch Online',
    tipo: 'gaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'juegos',
    moneda: 'USD',
    precio_mensual: 3.99,
    precio_anual: 19.99,
    tiene_plan_familiar: true,
    precio_familiar: 34.99,
    planes: [
      { nombre: 'Individual', precio: 3.99 },
      { nombre: 'Individual + Expansion', precio: 49.99 },
    ],
    patrones: ['nintendo'],
    icono: '🍄',
    popular: false,
  },
  {
    id: 'steam',
    nombre: 'Steam',
    tipo: 'gaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'juegos',
    moneda: 'USD',
    precio_mensual: null, // compras, no suscripción fija
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [],
    patrones: ['steam', 'steampowered', 'valve'],
    icono: '🎲',
    popular: false,
  },

  // ─── CLOUD / ALMACENAMIENTO ───
  {
    id: 'google_one',
    nombre: 'Google One',
    tipo: 'cloud',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 1.99,
    precio_anual: 19.99,
    tiene_plan_familiar: true,
    precio_familiar: 1.99,
    planes: [
      { nombre: '100 GB', precio: 1.99 },
      { nombre: '200 GB', precio: 2.99 },
      { nombre: '2 TB', precio: 9.99 },
    ],
    patrones: ['google one', 'google*services', 'google storage', 'google drive'],
    icono: '☁️',
    popular: true,
  },
  {
    id: 'icloud',
    nombre: 'iCloud+',
    tipo: 'cloud',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 0.99,
    precio_anual: null,
    tiene_plan_familiar: true,
    precio_familiar: 0.99,
    planes: [
      { nombre: '50 GB', precio: 0.99 },
      { nombre: '200 GB', precio: 2.99 },
      { nombre: '2 TB', precio: 9.99 },
      { nombre: '6 TB', precio: 29.99 },
      { nombre: '12 TB', precio: 59.99 },
    ],
    patrones: ['icloud', 'apple icloud', 'apple.com/bill'],
    icono: '🍏',
    popular: true,
  },
  {
    id: 'dropbox',
    nombre: 'Dropbox',
    tipo: 'cloud',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 11.99,
    precio_anual: 119.88,
    tiene_plan_familiar: true,
    precio_familiar: 16.99,
    planes: [
      { nombre: 'Plus', precio: 11.99 },
      { nombre: 'Professional', precio: 24.99 },
      { nombre: 'Family', precio: 16.99 },
    ],
    patrones: ['dropbox'],
    icono: '📁',
    popular: false,
  },

  // ─── HERRAMIENTAS IA ───
  {
    id: 'chatgpt',
    nombre: 'ChatGPT Plus',
    tipo: 'ai',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 20.00,
    precio_anual: 200.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Plus', precio: 20.00 },
      { nombre: 'Pro', precio: 200.00 },
    ],
    patrones: ['chatgpt', 'openai', 'open ai'],
    icono: '🤖',
    popular: true,
  },
  {
    id: 'claude',
    nombre: 'Claude Pro',
    tipo: 'ai',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 20.00,
    precio_anual: 200.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Pro', precio: 20.00 },
    ],
    patrones: ['claude', 'claude.ai', 'anthropic'],
    icono: '🧠',
    popular: false,
  },
  {
    id: 'midjourney',
    nombre: 'Midjourney',
    tipo: 'ai',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 10.00,
    precio_anual: 96.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Basic', precio: 10.00 },
      { nombre: 'Standard', precio: 30.00 },
      { nombre: 'Pro', precio: 60.00 },
    ],
    patrones: ['midjourney'],
    icono: '🎨',
    popular: false,
  },
  {
    id: 'copilot',
    nombre: 'Microsoft Copilot Pro',
    tipo: 'ai',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 20.00,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Pro', precio: 20.00 },
    ],
    patrones: ['copilot', 'microsoft*copilot'],
    icono: '✨',
    popular: false,
  },
  {
    id: 'gemini',
    nombre: 'Google Gemini Advanced',
    tipo: 'ai',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 19.99,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Advanced (Google One AI Premium)', precio: 19.99 },
    ],
    patrones: ['gemini', 'google*ai', 'google one ai'],
    icono: '💎',
    popular: false,
  },

  // ─── PRODUCTIVIDAD / SOFTWARE ───
  {
    id: 'microsoft_365',
    nombre: 'Microsoft 365',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 6.99,
    precio_anual: 69.99,
    tiene_plan_familiar: true,
    precio_familiar: 9.99,
    planes: [
      { nombre: 'Personal', precio: 6.99 },
      { nombre: 'Familiar', precio: 9.99 },
    ],
    patrones: ['microsoft 365', 'microsoft*office', 'office 365', 'ms 365'],
    icono: '📎',
    popular: true,
  },
  {
    id: 'canva',
    nombre: 'Canva Pro',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 14.99,
    precio_anual: 119.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Pro', precio: 14.99 },
      { nombre: 'Teams', precio: 10.00 },
    ],
    patrones: ['canva'],
    icono: '🎨',
    popular: true,
  },
  {
    id: 'adobe_cc',
    nombre: 'Adobe Creative Cloud',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 54.99,
    precio_anual: 599.88,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Fotografía', precio: 9.99 },
      { nombre: 'App individual', precio: 22.99 },
      { nombre: 'Todas las apps', precio: 54.99 },
    ],
    patrones: ['adobe', 'adobe.com', 'adobe systems', 'adobe creative'],
    icono: '🖌️',
    popular: false,
  },
  {
    id: 'notion',
    nombre: 'Notion',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 10.00,
    precio_anual: 96.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Plus', precio: 10.00 },
      { nombre: 'Business', precio: 18.00 },
    ],
    patrones: ['notion', 'notion.so'],
    icono: '📝',
    popular: false,
  },
  {
    id: 'figma',
    nombre: 'Figma',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 15.00,
    precio_anual: 144.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Professional', precio: 15.00 },
      { nombre: 'Organization', precio: 45.00 },
    ],
    patrones: ['figma'],
    icono: '🖼️',
    popular: false,
  },
  {
    id: 'github',
    nombre: 'GitHub Pro',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 4.00,
    precio_anual: 48.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Pro', precio: 4.00 },
      { nombre: 'Team', precio: 4.00 },
      { nombre: 'Enterprise', precio: 21.00 },
    ],
    patrones: ['github'],
    icono: '🐙',
    popular: false,
  },
  {
    id: 'slack',
    nombre: 'Slack Pro',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 8.75,
    precio_anual: 87.50,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Pro', precio: 8.75 },
      { nombre: 'Business+', precio: 12.50 },
    ],
    patrones: ['slack'],
    icono: '💬',
    popular: false,
  },
  {
    id: 'zoom',
    nombre: 'Zoom',
    tipo: 'comunicacion',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 13.33,
    precio_anual: 159.90,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Pro', precio: 13.33 },
      { nombre: 'Business', precio: 21.99 },
    ],
    patrones: ['zoom', 'zoom.us', 'zoom video'],
    icono: '📹',
    popular: false,
  },
  {
    id: 'shopify',
    nombre: 'Shopify',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 39.00,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Basic', precio: 39.00 },
      { nombre: 'Shopify', precio: 105.00 },
      { nombre: 'Advanced', precio: 399.00 },
    ],
    patrones: ['shopify'],
    icono: '🛒',
    popular: false,
  },
  {
    id: 'grammarly',
    nombre: 'Grammarly Premium',
    tipo: 'productividad',
    categoria_neto: 'Trabajo_Negocio',
    subcategoria_neto: 'herramientas',
    moneda: 'USD',
    precio_mensual: 12.00,
    precio_anual: 144.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Premium', precio: 12.00 },
    ],
    patrones: ['grammarly'],
    icono: '✏️',
    popular: false,
  },

  // ─── DELIVERY / FOOD (PERÚ) ───
  {
    id: 'rappi_prime',
    nombre: 'Rappi Prime',
    tipo: 'delivery',
    categoria_neto: 'Alimentación',
    subcategoria_neto: 'delivery',
    moneda: 'PEN',
    precio_mensual: 14.90,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Prime', precio: 14.90 },
    ],
    patrones: ['rappi prime', 'rappi'],
    icono: '🛵',
    popular: true,
  },
  {
    id: 'pedidosya_plus',
    nombre: 'PedidosYa Plus',
    tipo: 'delivery',
    categoria_neto: 'Alimentación',
    subcategoria_neto: 'delivery',
    moneda: 'PEN',
    precio_mensual: 9.90,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Plus', precio: 9.90 },
    ],
    patrones: ['pedidosya plus', 'pedidosya', 'dlc*pedidosya'],
    icono: '🍔',
    popular: true,
  },
  {
    id: 'didi_club',
    nombre: 'DiDi Club',
    tipo: 'delivery',
    categoria_neto: 'Transporte',
    subcategoria_neto: 'uber_cabify',
    moneda: 'PEN',
    precio_mensual: 9.90,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Club', precio: 9.90 },
    ],
    patrones: ['didi club', 'didi'],
    icono: '🚗',
    popular: false,
  },

  // ─── EDUCACIÓN ───
  {
    id: 'platzi',
    nombre: 'Platzi',
    tipo: 'educacion',
    categoria_neto: 'Educación',
    subcategoria_neto: 'curso_online',
    moneda: 'USD',
    precio_mensual: 26.00,
    precio_anual: 199.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Expert', precio: 26.00 },
      { nombre: 'Expert+ (anual)', precio: 16.58 },
    ],
    patrones: ['platzi'],
    icono: '🎓',
    popular: true,
  },
  {
    id: 'coursera',
    nombre: 'Coursera Plus',
    tipo: 'educacion',
    categoria_neto: 'Educación',
    subcategoria_neto: 'curso_online',
    moneda: 'USD',
    precio_mensual: 59.00,
    precio_anual: 399.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Plus Mensual', precio: 59.00 },
      { nombre: 'Plus Anual', precio: 33.25 },
    ],
    patrones: ['coursera'],
    icono: '📚',
    popular: false,
  },
  {
    id: 'duolingo',
    nombre: 'Duolingo Plus',
    tipo: 'educacion',
    categoria_neto: 'Educación',
    subcategoria_neto: 'idiomas',
    moneda: 'USD',
    precio_mensual: 6.99,
    precio_anual: 83.99,
    tiene_plan_familiar: true,
    precio_familiar: 9.99,
    planes: [
      { nombre: 'Super', precio: 6.99 },
      { nombre: 'Super Familiar', precio: 9.99 },
    ],
    patrones: ['duolingo'],
    icono: '🦉',
    popular: true,
  },
  {
    id: 'domestika',
    nombre: 'Domestika Plus',
    tipo: 'educacion',
    categoria_neto: 'Educación',
    subcategoria_neto: 'curso_online',
    moneda: 'USD',
    precio_mensual: 9.99,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Plus', precio: 9.99 },
    ],
    patrones: ['domestika'],
    icono: '🎯',
    popular: false,
  },
  {
    id: 'udemy',
    nombre: 'Udemy',
    tipo: 'educacion',
    categoria_neto: 'Educación',
    subcategoria_neto: 'curso_online',
    moneda: 'USD',
    precio_mensual: null, // compras individuales
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [],
    patrones: ['udemy'],
    icono: '🏫',
    popular: false,
  },

  // ─── FITNESS / WELLNESS ───
  {
    id: 'strava',
    nombre: 'Strava',
    tipo: 'fitness',
    categoria_neto: 'Salud',
    subcategoria_neto: 'seguro_salud',
    moneda: 'USD',
    precio_mensual: 5.00,
    precio_anual: 49.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Premium', precio: 5.00 },
    ],
    patrones: ['strava'],
    icono: '🏃',
    popular: false,
  },
  {
    id: 'calm',
    nombre: 'Calm',
    tipo: 'fitness',
    categoria_neto: 'Salud',
    subcategoria_neto: 'seguro_salud',
    moneda: 'USD',
    precio_mensual: 14.99,
    precio_anual: 69.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Premium', precio: 14.99 },
    ],
    patrones: ['calm', 'calm.com'],
    icono: '🧘',
    popular: false,
  },
  {
    id: 'headspace',
    nombre: 'Headspace',
    tipo: 'fitness',
    categoria_neto: 'Salud',
    subcategoria_neto: 'seguro_salud',
    moneda: 'USD',
    precio_mensual: 12.99,
    precio_anual: 69.99,
    tiene_plan_familiar: true,
    precio_familiar: 99.99,
    planes: [
      { nombre: 'Individual', precio: 12.99 },
    ],
    patrones: ['headspace'],
    icono: '🧠',
    popular: false,
  },

  // ─── NOTICIAS / LECTURA ───
  {
    id: 'kindle_unlimited',
    nombre: 'Kindle Unlimited',
    tipo: 'noticias',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 11.99,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Unlimited', precio: 11.99 },
    ],
    patrones: ['kindle', 'kindle unlimited', 'amzn*kindle'],
    icono: '📖',
    popular: false,
  },
  {
    id: 'audible',
    nombre: 'Audible',
    tipo: 'noticias',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 7.95,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Plus', precio: 7.95 },
      { nombre: 'Premium Plus', precio: 14.95 },
    ],
    patrones: ['audible', 'amzn*audible'],
    icono: '🎧',
    popular: false,
  },
  {
    id: 'el_comercio',
    nombre: 'El Comercio Digital',
    tipo: 'noticias',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'PEN',
    precio_mensual: 29.90,
    precio_anual: 299.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Digital', precio: 29.90 },
    ],
    patrones: ['el comercio', 'elcomercio', 'grupo el comercio'],
    icono: '📰',
    popular: false,
  },
  {
    id: 'gestion',
    nombre: 'Gestión Digital',
    tipo: 'noticias',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'PEN',
    precio_mensual: 19.90,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Digital', precio: 19.90 },
    ],
    patrones: ['gestion', 'diario gestion'],
    icono: '📊',
    popular: false,
  },

  // ─── VPN / SEGURIDAD ───
  {
    id: 'nordvpn',
    nombre: 'NordVPN',
    tipo: 'vpn',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 12.99,
    precio_anual: 59.88,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Mensual', precio: 12.99 },
      { nombre: 'Anual', precio: 4.99 },
      { nombre: '2 años', precio: 3.39 },
    ],
    patrones: ['nordvpn', 'nord vpn', 'nordsec'],
    icono: '🔒',
    popular: false,
  },

  // ─── DATING ───
  {
    id: 'tinder',
    nombre: 'Tinder',
    tipo: 'dating',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 14.99,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Plus', precio: 9.99 },
      { nombre: 'Gold', precio: 14.99 },
      { nombre: 'Platinum', precio: 24.99 },
    ],
    patrones: ['tinder', 'match group'],
    icono: '🔥',
    popular: false,
  },
  {
    id: 'bumble',
    nombre: 'Bumble',
    tipo: 'dating',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 16.99,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Premium', precio: 16.99 },
      { nombre: 'Premium+', precio: 32.99 },
    ],
    patrones: ['bumble'],
    icono: '🐝',
    popular: false,
  },

  // ─── COMUNICACIÓN ───
  {
    id: 'discord_nitro',
    nombre: 'Discord Nitro',
    tipo: 'comunicacion',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 9.99,
    precio_anual: 99.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Nitro Basic', precio: 2.99 },
      { nombre: 'Nitro', precio: 9.99 },
    ],
    patrones: ['discord', 'discord nitro'],
    icono: '🎙️',
    popular: false,
  },

  // ─── AI ADICIONALES ───
  {
    id: 'perplexity',
    nombre: 'Perplexity Pro',
    tipo: 'ai',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 20.00,
    precio_anual: 200.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Pro', precio: 20.00 },
    ],
    patrones: ['perplexity'],
    icono: '🔍',
    popular: false,
  },

  // ─── BUNDLES ───
  {
    id: 'apple_one',
    nombre: 'Apple One',
    tipo: 'streaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 19.95,
    precio_anual: null,
    tiene_plan_familiar: true,
    precio_familiar: 25.95,
    planes: [
      { nombre: 'Individual (Music+TV+Arcade+50GB)', precio: 19.95 },
      { nombre: 'Familiar (6 personas)', precio: 25.95 },
      { nombre: 'Premier (2TB+News+Fitness)', precio: 37.95 },
    ],
    patrones: ['apple one'],
    icono: '🍎',
    popular: false,
  },

  // ─── GAMING ADICIONAL ───
  {
    id: 'ea_play',
    nombre: 'EA Play',
    tipo: 'gaming',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'juegos',
    moneda: 'USD',
    precio_mensual: 4.99,
    precio_anual: 29.99,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'EA Play', precio: 4.99 },
      { nombre: 'EA Play Pro', precio: 14.99 },
    ],
    patrones: ['ea play', 'ea*play', 'electronic arts'],
    icono: '⚽',
    popular: false,
  },

  // ─── VPN ADICIONALES ───
  {
    id: 'expressvpn',
    nombre: 'ExpressVPN',
    tipo: 'vpn',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 8.32,
    precio_anual: 99.95,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Anual', precio: 8.32 },
    ],
    patrones: ['expressvpn', 'express vpn'],
    icono: '🔒',
    popular: false,
  },
  {
    id: 'surfshark',
    nombre: 'Surfshark',
    tipo: 'vpn',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 2.49,
    precio_anual: 29.88,
    tiene_plan_familiar: true,
    precio_familiar: 2.49, // unlimited devices
    planes: [
      { nombre: '2 años', precio: 2.49 },
      { nombre: 'Anual', precio: 3.99 },
    ],
    patrones: ['surfshark'],
    icono: '🦈',
    popular: false,
  },

  // ─── EDUCACIÓN ADICIONAL ───
  {
    id: 'linkedin_learning',
    nombre: 'LinkedIn Learning',
    tipo: 'educacion',
    categoria_neto: 'Educación',
    subcategoria_neto: 'curso_online',
    moneda: 'USD',
    precio_mensual: 19.99,
    precio_anual: 239.88,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Individual', precio: 19.99 },
    ],
    patrones: ['linkedin learning', 'linkedin'],
    icono: '💼',
    popular: false,
  },

  // ─── LECTURA ADICIONAL ───
  {
    id: 'medium',
    nombre: 'Medium',
    tipo: 'noticias',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 5.00,
    precio_anual: 50.00,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Member', precio: 5.00 },
    ],
    patrones: ['medium', 'medium.com'],
    icono: '📖',
    popular: false,
  },
  {
    id: 'scribd',
    nombre: 'Scribd',
    tipo: 'noticias',
    categoria_neto: 'Entretenimiento',
    subcategoria_neto: 'suscripciones',
    moneda: 'USD',
    precio_mensual: 11.99,
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [
      { nombre: 'Individual', precio: 11.99 },
    ],
    patrones: ['scribd'],
    icono: '📚',
    popular: false,
  },

  // ─── FINANZAS (PERÚ) ───
  {
    id: 'tyba',
    nombre: 'Tyba',
    tipo: 'finanzas',
    categoria_neto: 'Finanzas',
    subcategoria_neto: 'inversion',
    moneda: 'PEN',
    precio_mensual: null, // comisiones, no suscripción
    precio_anual: null,
    tiene_plan_familiar: false,
    precio_familiar: null,
    planes: [],
    patrones: ['tyba', 'credicorp capital'],
    icono: '💰',
    popular: false,
  },
];

// ═══════════════════════════════════════════════════════════════
// MOTOR DE DETECCIÓN — Identifica suscripciones desde transacciones
// ═══════════════════════════════════════════════════════════════

/**
 * Busca coincidencia de un nombre de comercio con el catálogo
 * @param {string} comercio - Nombre del comercio de la transacción
 * @returns {object|null} - Entrada del catálogo o null
 */
function matchCatalogo(comercio) {
  if (!comercio) return null;
  const lower = comercio.toLowerCase().trim();
  for (const sub of CATALOGO_SUSCRIPCIONES) {
    for (const patron of sub.patrones) {
      if (lower.includes(patron) || patron.includes(lower)) {
        return sub;
      }
    }
  }
  return null;
}

/**
 * Detecta suscripciones activas del usuario analizando sus transacciones
 * Busca pagos recurrentes (mismo comercio, monto similar, 2+ meses)
 *
 * @param {string} usuarioId
 * @returns {Promise<object>} - { suscripciones_detectadas, total_mensual_pen, total_mensual_usd, resumen }
 */
async function detectarSuscripciones(usuarioId) {
  const TC = 3.75; // tipo de cambio aproximado USD/PEN
  const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));

  // Traer transacciones de los últimos 3 meses para detectar recurrencia
  const hace3Meses = new Date(hoy);
  hace3Meses.setMonth(hace3Meses.getMonth() - 3);
  const desde = hace3Meses.toISOString().split('T')[0];

  const { data: txs, error } = await supabase
    .from('transacciones')
    .select('comercio, monto, moneda, monto_pen, categoria, subcategoria, fecha')
    .eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto')
    .gte('fecha', desde)
    .order('fecha', { ascending: false });

  if (error) {
    log.error({ tag: 'SUBS', err: error.message }, 'Error consultando transacciones para suscripciones');
    return { suscripciones_detectadas: [], total_mensual_pen: 0, total_mensual_usd: 0 };
  }

  if (!txs || txs.length === 0) {
    return { suscripciones_detectadas: [], total_mensual_pen: 0, total_mensual_usd: 0 };
  }

  // Agrupar por comercio normalizado
  const porComercio = {};
  for (const tx of txs) {
    const nombre = (tx.comercio || '').trim();
    if (!nombre) continue;
    const key = nombre.toLowerCase();
    if (!porComercio[key]) {
      porComercio[key] = {
        nombre_original: nombre,
        pagos: [],
        moneda: tx.moneda || 'PEN',
      };
    }
    porComercio[key].pagos.push({
      monto: parseFloat(tx.monto),
      monto_pen: parseFloat(tx.monto_pen || tx.monto),
      fecha: tx.fecha,
      categoria: tx.categoria,
      subcategoria: tx.subcategoria,
    });
  }

  // Analizar cada comercio para detectar recurrencia
  const suscripciones = [];
  const mesesSet = new Set();

  for (const [key, data] of Object.entries(porComercio)) {
    const catalogoMatch = matchCatalogo(data.nombre_original);

    // Para entrar como suscripción detectada necesita:
    // 1. Estar en el catálogo Y tener al menos 1 pago, O
    // 2. Tener pagos en 2+ meses distintos con monto similar
    const mesesConPago = new Set(data.pagos.map(p => p.fecha.substring(0, 7)));

    if (catalogoMatch && data.pagos.length >= 1) {
      // Match directo con catálogo
      const ultimoPago = data.pagos[0]; // ya ordenado desc
      const montoPromedio = data.pagos.reduce((s, p) => s + p.monto, 0) / data.pagos.length;

      // Usar precio_local_pen si existe (servicios que cobran en soles)
      const precioRef = catalogoMatch.precio_local_pen || catalogoMatch.precio_mensual;
      const monedaRef = catalogoMatch.precio_local_pen ? 'PEN' : catalogoMatch.moneda;

      suscripciones.push({
        id: catalogoMatch.id,
        nombre: catalogoMatch.nombre,
        tipo: catalogoMatch.tipo,
        icono: catalogoMatch.icono,
        fuente: 'catalogo',
        estado: 'activa',
        moneda: data.moneda,
        monto_detectado: Math.round(montoPromedio * 100) / 100,
        monto_pen: data.moneda === 'USD' ? Math.round(montoPromedio * TC * 100) / 100 : Math.round(montoPromedio * 100) / 100,
        precio_referencia: precioRef,
        tiene_plan_familiar: catalogoMatch.tiene_plan_familiar,
        precio_familiar: catalogoMatch.precio_familiar,
        meses_detectados: mesesConPago.size,
        ultimo_pago: ultimoPago.fecha,
        categoria_neto: catalogoMatch.categoria_neto,
        subcategoria_neto: catalogoMatch.subcategoria_neto,
        planes_disponibles: catalogoMatch.planes || [],
      });
    } else if (mesesConPago.size >= 2) {
      // Patrón recurrente sin match en catálogo
      const montos = data.pagos.map(p => p.monto);
      const avg = montos.reduce((a, b) => a + b, 0) / montos.length;
      const varianza = montos.reduce((s, m) => s + Math.pow(m - avg, 2), 0) / montos.length;
      const coefVar = avg > 0 ? Math.sqrt(varianza) / avg : 1;

      // Si el coeficiente de variación es bajo (<0.3), es probablemente una suscripción
      if (coefVar < 0.3 && avg > 2) {
        const ultimoPago = data.pagos[0];
        suscripciones.push({
          id: 'custom_' + key.replace(/[^a-z0-9]/g, '_'),
          nombre: data.nombre_original,
          tipo: 'otro',
          icono: '🔄',
          fuente: 'patron',
          estado: 'posible',
          moneda: data.moneda,
          monto_detectado: Math.round(avg * 100) / 100,
          monto_pen: data.moneda === 'USD' ? Math.round(avg * TC * 100) / 100 : Math.round(avg * 100) / 100,
          precio_referencia: null,
          tiene_plan_familiar: false,
          precio_familiar: null,
          meses_detectados: mesesConPago.size,
          ultimo_pago: ultimoPago.fecha,
          categoria_neto: ultimoPago.categoria || 'Otros',
          subcategoria_neto: ultimoPago.subcategoria || 'sin_categoria',
          planes_disponibles: [],
        });
      }
    }
  }

  // Calcular totales
  let totalPEN = 0;
  let totalUSD = 0;
  for (const sub of suscripciones) {
    if (sub.moneda === 'USD') totalUSD += sub.monto_detectado;
    else totalPEN += sub.monto_detectado;
  }

  // Ordenar por monto PEN descendente
  suscripciones.sort((a, b) => b.monto_pen - a.monto_pen);

  return {
    suscripciones_detectadas: suscripciones,
    total_mensual_pen: Math.round((totalPEN + totalUSD * TC) * 100) / 100,
    total_mensual_usd: Math.round(totalUSD * 100) / 100,
    cantidad: suscripciones.length,
    resumen: {
      por_tipo: agruparPorTipo(suscripciones),
      activas: suscripciones.filter(s => s.estado === 'activa').length,
      posibles: suscripciones.filter(s => s.estado === 'posible').length,
      ahorro_potencial_familiar: calcularAhorroFamiliar(suscripciones),
    }
  };
}

/**
 * Agrupa suscripciones por tipo y calcula subtotales
 */
function agruparPorTipo(suscripciones) {
  const grupos = {};
  for (const sub of suscripciones) {
    if (!grupos[sub.tipo]) grupos[sub.tipo] = { cantidad: 0, total_pen: 0, items: [] };
    grupos[sub.tipo].cantidad += 1;
    grupos[sub.tipo].total_pen += sub.monto_pen;
    grupos[sub.tipo].items.push(sub.nombre);
  }
  // Redondear
  for (const g of Object.values(grupos)) {
    g.total_pen = Math.round(g.total_pen * 100) / 100;
  }
  return grupos;
}

/**
 * Calcula cuánto ahorraría el usuario si cambia a planes familiares
 */
function calcularAhorroFamiliar(suscripciones) {
  let ahorro = 0;
  const TC = 3.75;
  for (const sub of suscripciones) {
    if (sub.tiene_plan_familiar && sub.precio_familiar && sub.precio_referencia) {
      // El familiar cuesta más, pero si compartes con alguien más, ahorras
      // Asumiendo que comparte con 1 persona: costo = familiar / 2
      const costoCompartido = sub.precio_familiar / 2;
      if (costoCompartido < sub.monto_detectado) {
        const diff = sub.monto_detectado - costoCompartido;
        ahorro += sub.moneda === 'USD' ? diff * TC : diff;
      }
    }
  }
  return Math.round(ahorro * 100) / 100;
}

/**
 * Obtiene el catálogo completo para mostrar en la webapp
 * Filtra solo servicios con precio mensual (suscripciones reales)
 */
function obtenerCatalogo() {
  return CATALOGO_SUSCRIPCIONES
    .filter(s => s.precio_mensual !== null)
    .map(s => ({
      id: s.id,
      nombre: s.nombre,
      tipo: s.tipo,
      icono: s.icono,
      moneda: s.moneda,
      precio_mensual: s.precio_mensual,
      planes: s.planes,
      tiene_plan_familiar: s.tiene_plan_familiar,
      popular: s.popular,
    }));
}

/**
 * Genera el texto de análisis de suscripciones para WhatsApp (voz NETO)
 */
function generarTextoSuscripciones(dataSubs, nombreUsuario) {
  const nombre = nombreUsuario ? nombreUsuario.split(' ')[0] : '';
  const { suscripciones_detectadas: subs, total_mensual_pen, resumen } = dataSubs;

  if (subs.length === 0) {
    return nombre
      ? nombre + ', no detecté suscripciones activas en tus transacciones. Si tienes alguna, regístrala manual y la trackeo.'
      : 'No detecté suscripciones activas. Si tienes alguna, regístrala y la trackeo.';
  }

  let msg = '🔄 ' + (nombre ? nombre + ', t' : 'T') + 'ienes ' + subs.length + ' suscripci' + (subs.length === 1 ? 'ón' : 'ones') + ' detectada' + (subs.length === 1 ? '' : 's') + ' (≈ S/' + total_mensual_pen + '/mes):\n\n';

  for (const sub of subs.slice(0, 8)) {
    const precio = sub.moneda === 'USD'
      ? '$' + sub.monto_detectado + ' (≈ S/' + sub.monto_pen + ')'
      : 'S/' + sub.monto_detectado;
    msg += sub.icono + ' ' + sub.nombre + ': ' + precio + '\n';
  }
  if (subs.length > 8) {
    msg += '... y ' + (subs.length - 8) + ' más\n';
  }

  // Tip de ahorro si aplica
  if (resumen.ahorro_potencial_familiar > 10) {
    msg += '\n💡 Si compartes planes familiares podrías ahorrar ≈ S/' + resumen.ahorro_potencial_familiar + '/mes';
  }

  msg += '\n\n¿Quieres que revise si alguna te conviene cancelar o cambiar de plan?';

  return msg;
}

module.exports = {
  CATALOGO_SUSCRIPCIONES,
  matchCatalogo,
  detectarSuscripciones,
  obtenerCatalogo,
  generarTextoSuscripciones,
};
