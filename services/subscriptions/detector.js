const { supabase } = require('../../lib/db');
const log = require('../../lib/logger');
const { obtenerTipoCambio } = require('../transactions');
const { CATALOGO_SUSCRIPCIONES } = require('./catalog');

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
  const tcData = await obtenerTipoCambio();
  const TC = tcData.venta || 3.85;
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
      ahorro_potencial_familiar: calcularAhorroFamiliar(suscripciones, TC),
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
function calcularAhorroFamiliar(suscripciones, TC = 3.85) {
  let ahorro = 0;
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

module.exports = {
  matchCatalogo,
  detectarSuscripciones,
};
