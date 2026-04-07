// Árbol canónico de categorías — única fuente de verdad
const CATEGORIAS_VALIDAS = new Set([
  'Alimentación', 'Transporte', 'Vivienda', 'Salud', 'Entretenimiento',
  'Suscripciones', 'Compras', 'Educación', 'Finanzas', 'Trabajo_Negocio', 'Otros'
]);

// Mapeo de variantes → canónico (retrocompatibilidad + correcciones automáticas)
const CATEGORIA_MAP = {
  'Comida': 'Alimentación', 'comida': 'Alimentación',
  'Alimentacion': 'Alimentación', 'alimentacion': 'Alimentación', 'alimentación': 'Alimentación',
  'Hogar': 'Vivienda', 'hogar': 'Vivienda', 'vivienda': 'Vivienda',
  'Auto': 'Transporte', 'auto': 'Transporte',
  'Streaming': 'Suscripciones', 'streaming': 'Suscripciones',
  'suscripciones': 'Suscripciones', 'suscripcion': 'Suscripciones', 'Suscripcion': 'Suscripciones',
  'Viajes': 'Otros', 'viajes': 'Otros',
  'Educacion': 'Educación', 'educacion': 'Educación',
  'Transferencia': 'Otros', 'transferencia': 'Otros',
  'transporte': 'Transporte', 'salud': 'Salud',
  'entretenimiento': 'Entretenimiento', 'compras': 'Compras',
  'finanzas': 'Finanzas', 'trabajo_negocio': 'Trabajo_Negocio',
  'otros': 'Otros',
};

// Nombres de meses en español (índice 1-12)
const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// Meses abreviados para formatFecha
const MESES_CORTOS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

// Categorías sugeridas con emojis y subcategorías
const CATEGORIAS_SUGERIDAS = [
  { nombre: 'Alimentación', emoji: '🍽️', subs: ['delivery','restaurante','supermercado','mercado','cafeteria','snacks'] },
  { nombre: 'Transporte',    emoji: '🚌',         subs: ['uber_cabify','taxi','bus_micro','metro_bus','gasolina','peaje','estacionamiento'] },
  { nombre: 'Vivienda',      emoji: '🏠',         subs: ['alquiler','mantenimiento','electricidad','agua','gas','internet','cable'] },
  { nombre: 'Salud',         emoji: '💊',         subs: ['farmacia','medico','clinica','laboratorio','seguro_salud','optica'] },
  { nombre: 'Entretenimiento', emoji: '🎰',       subs: ['cine','juegos','bares_clubs','eventos','hobbies'] },
  { nombre: 'Suscripciones', emoji: '🔄',         subs: ['streaming','musica','software','gaming','almacenamiento','otros'] },
  { nombre: 'Compras',       emoji: '🛒',         subs: ['ropa','calzado','electronico','hogar','belleza','mascotas'] },
  { nombre: 'Educación',     emoji: '📚',         subs: ['universidad','instituto','curso_online','utiles','idiomas','colegios'] },
  { nombre: 'Finanzas',      emoji: '💳',         subs: ['prestamo','tarjeta_credito','seguro','ahorro','inversion','comision_banco'] },
  { nombre: 'Trabajo_Negocio', emoji: '💼',       subs: ['herramientas','publicidad','oficina','logistica','contador'] },
  { nombre: 'Otros',         emoji: '📋',         subs: ['regalo','donacion','multa','viaje','sin_categoria'] }
];

// Freemium Configuration
const FREEMIUM_ACTIVE = true;

const PLAN_CONFIG = {
  free: {
    historyMonths: 1,
    reportesPerMonth: 0,
    excelUpload: false,
    dashboardTTL: 1,
    weeklyResumen: 'basic',
    scoreFinanciero: 'number',
    resumenDiario: false,
    recordatorios: false,
    maxPresupuestos: Infinity,
    maxMetas: Infinity,
    maxGmailAccounts: 0,
    ocrPerMonth: Infinity,
    consejoPerWeek: 0,
    csvExport: false,
    // Neto Score
    netoScoreDetail: false,
    netoScoreHistory: 1,
    netoScoreTips: false,
    netoScoreNotif: false,
    // Detector de Fugas
    fugasFrequency: 'monthly',
    fugasProjection: false,
    fugasLimits: false,
    // Planes de Ahorro (maxMetas ya existe arriba)
    metasViability: false,
    metasDynamic: false,
    metasCheckins: false,
    metasCuts: false,
    // Finanzas Compartidas
    maxSpaces: 1,
    maxSpaceMembers: 2,
    spaceSplit: 'equal',
    spaceHistory: 1,
    spaceBudget: false,
    spaceCollab: false,
  },
  premium: {
    historyMonths: null,
    reportesPerMonth: Infinity,
    excelUpload: true,
    dashboardTTL: 24,
    weeklyResumen: 'full',
    scoreFinanciero: 'full',
    resumenDiario: true,
    recordatorios: true,
    maxPresupuestos: Infinity,
    maxMetas: Infinity,
    maxGmailAccounts: Infinity,
    ocrPerMonth: Infinity,
    consejoPerWeek: Infinity,
    csvExport: true,
    // Neto Score
    netoScoreDetail: true,
    netoScoreHistory: 6,
    netoScoreTips: true,
    netoScoreNotif: true,
    // Detector de Fugas
    fugasFrequency: 'weekly',
    fugasProjection: true,
    fugasLimits: true,
    // Planes de Ahorro
    metasViability: true,
    metasDynamic: true,
    metasCheckins: true,
    metasCuts: true,
    // Finanzas Compartidas
    maxSpaces: Infinity,
    maxSpaceMembers: 6,
    spaceSplit: 'custom',
    spaceHistory: null,
    spaceBudget: true,
    spaceCollab: true,
  }
};

// Dashboard URL — única fuente de verdad para links al webapp
const WEBAPP_URL = 'https://app.neto.pe';

module.exports = {
  CATEGORIAS_VALIDAS, CATEGORIA_MAP, MESES, MESES_CORTOS,
  CATEGORIAS_SUGERIDAS, FREEMIUM_ACTIVE, PLAN_CONFIG, WEBAPP_URL,
};
