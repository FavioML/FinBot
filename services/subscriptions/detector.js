const { supabase } = require('../../lib/db');
const log = require('../../lib/logger');
const { obtenerTipoCambio, TC_FALLBACK } = require('../transactions');
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
      // Solo match hacia adelante: el patrón del catálogo debe estar contenido en el
      // nombre del comercio (cubre prefijos de pasarela como "DLOCAL*NETFLIX"). Se
      // eliminó el match inverso `patron.includes(lower)`: hacía que un comercio corto
      // matcheara por accidente ('ea' caía dentro de 'steam') y que un pedido de comida
      // 'pedidosya' matcheara el plan 'pedidosya plus' por ser substring. Los patrones
      // canónicos cortos (netflix, spotify, disney+) siguen como patrón directo.
      if (lower.includes(patron)) {
        return sub;
      }
    }
  }
  return null;
}

/**
 * Agrupa los pagos en clusters por monto (±10%) y devuelve el cluster que abarca más
 * meses distintos como la "cuota recurrente" (desempate → monto mayor). El resto son
 * cargos puntuales. Sirve para descriptores opacos que agrupan más de un servicio bajo
 * un mismo comercio (ej. "Apple" = Music + iCloud): sin esto, la varianza global de los
 * montos mezclados tumbaba el grupo entero. Paridad con recurringCluster del webapp
 * (services/subscriptions-catalog en la app Next).
 * @param {{monto:number, fecha:string}[]} pagos
 * @returns {{recurring: object[], extras: object[]}}
 */
function recurringCluster(pagos) {
  if (pagos.length <= 1) return { recurring: [...pagos], extras: [] };
  const monthSpan = (arr) => new Set(arr.map(p => p.fecha.substring(0, 7))).size;
  const clusters = [];
  for (const p of [...pagos].sort((a, b) => b.monto - a.monto)) {
    let placed = false;
    for (const c of clusters) {
      const ref = c[0].monto;
      if (ref > 0 && Math.abs(p.monto - ref) / ref <= 0.1) { c.push(p); placed = true; break; }
    }
    if (!placed) clusters.push([p]);
  }
  let best = clusters[0];
  let bestSpan = monthSpan(best);
  for (const c of clusters.slice(1)) {
    const span = monthSpan(c);
    if (span > bestSpan || (span === bestSpan && c[0].monto > best[0].monto)) { best = c; bestSpan = span; }
  }
  const extras = pagos.filter(p => !best.includes(p));
  return { recurring: best, extras };
}

/**
 * ¿La transacción está categorizada como suscripción? Gate de la detección por patrón
 * (no aplica al catálogo, que se reconoce por nombre). El categorizador de Neto marca las
 * suscripciones con categoría 'Suscripciones' (ej. Suscripciones/Software, /Gimnasio) o
 * subcategoría 'suscripciones' (ej. Entretenimiento/suscripciones). Utilidades como
 * internet/celular viven bajo 'Vivienda' y quedan fuera a propósito: no son lo que el
 * usuario entiende por "suscripciones" ni están en el catálogo.
 * @param {{categoria?: string, subcategoria?: string}} pago
 * @returns {boolean}
 */
function esCategoriaSuscripcion(pago) {
  const cat = (pago.categoria || '').toLowerCase();
  const sub = (pago.subcategoria || '').toLowerCase();
  return cat === 'suscripciones' || sub === 'suscripciones';
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
  // El `3.85` que había acá era una SEGUNDA copia del fallback, a mano y sin nombre: el día
  // que se ajuste el de `transactions.js` éste se queda viejo y nadie lo va a buscar.
  const TC = tcData.venta || TC_FALLBACK.venta;
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

  // Agrupar pagos. Los matches de catálogo se agrupan por catalog id, de modo que
  // distintas grafías del mismo servicio ("PedidosYa Plus", "pedidosya plus",
  // "DL*PEDIDOSYAPLUS") caen en un solo grupo y no se reportan duplicadas. Los comercios
  // sin match de catálogo se agrupan por su string normalizado. txs viene ordenado por
  // fecha desc, así que el primer pago de cada grupo es el más reciente.
  const grupos = {};
  for (const tx of txs) {
    const nombre = (tx.comercio || '').trim();
    if (!nombre) continue;
    const catalogoMatch = matchCatalogo(nombre);
    const key = catalogoMatch ? 'cat:' + catalogoMatch.id : 'com:' + nombre.toLowerCase();
    if (!grupos[key]) {
      grupos[key] = {
        catalogo: catalogoMatch,
        nombre_original: nombre, // grafía del pago más reciente
        pagos: [],
        moneda: tx.moneda || 'PEN',
      };
    }
    grupos[key].pagos.push({
      monto: parseFloat(tx.monto),
      monto_pen: parseFloat(tx.monto_pen || tx.monto),
      fecha: tx.fecha,
      categoria: tx.categoria,
      subcategoria: tx.subcategoria,
    });
  }

  // Analizar cada grupo para detectar recurrencia
  const suscripciones = [];

  for (const [key, data] of Object.entries(grupos)) {
    const catalogoMatch = data.catalogo;
    const mesesConPago = new Set(data.pagos.map(p => p.fecha.substring(0, 7)));
    const ultimoPago = data.pagos[0]; // más reciente (txs ordenados desc)

    if (catalogoMatch) {
      // Match de catálogo. El estado depende de la recurrencia real:
      //   2+ meses distintos con pago -> 'activa' (es lo que dispara el recordatorio en el cron)
      //   1 solo mes -> 'posible' (puede ser una compra única en un storefront de catálogo,
      //   p.ej. Amazon; no la marcamos activa ni notificamos hasta confirmar recurrencia).
      const estado = mesesConPago.size >= 2 ? 'activa' : 'posible';
      // Monto mostrado = último pago: refleja lo que paga hoy y coincide con un plan real.
      const montoDetectado = ultimoPago.monto;

      // Usar precio_local_pen si existe (servicios que cobran en soles)
      const precioRef = catalogoMatch.precio_local_pen || catalogoMatch.precio_mensual;

      suscripciones.push({
        id: catalogoMatch.id,
        nombre: catalogoMatch.nombre,
        tipo: catalogoMatch.tipo,
        icono: catalogoMatch.icono,
        fuente: 'catalogo',
        estado,
        moneda: data.moneda,
        monto_detectado: Math.round(montoDetectado * 100) / 100,
        // monto_pen persistido del pago (C7): usa el TC del día en que se registró, no el
        // de hoy. Recalcular con el TC actual metía drift en subs USD (ej. pago a 3.70,
        // hoy 3.85). ultimoPago.monto_pen ya viene de la fila (o monto si era PEN).
        monto_pen: Math.round(ultimoPago.monto_pen * 100) / 100,
        precio_referencia: precioRef,
        tiene_plan_familiar: catalogoMatch.tiene_plan_familiar,
        precio_familiar: catalogoMatch.precio_familiar,
        meses_detectados: mesesConPago.size,
        ultimo_pago: ultimoPago.fecha,
        categoria_neto: catalogoMatch.categoria_neto,
        subcategoria_neto: catalogoMatch.subcategoria_neto,
        planes_disponibles: catalogoMatch.planes || [],
      });
    } else if (esCategoriaSuscripcion(ultimoPago)) {
      // Patrón recurrente sin match en catálogo. Exige que la transacción esté
      // CATEGORIZADA como suscripción. Sin este gate, la sola estabilidad de monto
      // marcaba gastos de vida cotidiana como "suscripción": pedidos de comida, gasolina,
      // estacionamiento, barbería, transferencias a personas (todos con montos parecidos
      // mes a mes). El categorizador de Neto ya tiene la categoría/subcategoría
      // "Suscripciones"; solo eso pasa la rama por patrón (p.ej. un software o gimnasio
      // no listado en el catálogo).
      //
      // Clave: la estabilidad se mide sobre la CUOTA recurrente (el cluster de monto que
      // abarca más meses), NO sobre todos los pagos. Un descriptor opaco tipo "Apple"
      // agrupa dos servicios (Music + iCloud) con montos dispares; medir la varianza
      // global tumbaba el grupo entero. La cuota estable (p.ej. iCloud) surface y los
      // otros cargos quedan fuera de la cuota. Paridad con el motor del webapp.
      const { recurring } = recurringCluster(data.pagos);
      const recurringMonths = new Set(recurring.map(p => p.fecha.substring(0, 7))).size;
      if (recurringMonths >= 2) {
        const montos = recurring.map(p => p.monto);
        const avg = montos.reduce((a, b) => a + b, 0) / montos.length;
        // Promedio de los monto_pen persistidos (C7): sin recompute con TC de hoy.
        const montosPen = recurring.map(p => p.monto_pen);
        const avgPen = montosPen.reduce((a, b) => a + b, 0) / montosPen.length;
        const varianza = montos.reduce((s, m) => s + Math.pow(m - avg, 2), 0) / montos.length;
        const coefVar = avg > 0 ? Math.sqrt(varianza) / avg : 1;

        // Coef. de variación bajo (<0.3) y monto no trivial (>2) => probablemente suscripción
        if (coefVar < 0.3 && avg > 2) {
          suscripciones.push({
            id: 'custom_' + key.replace(/[^a-z0-9]/g, '_'),
            nombre: data.nombre_original,
            tipo: 'otro',
            icono: '🔄',
            fuente: 'patron',
            estado: 'posible',
            moneda: data.moneda,
            monto_detectado: Math.round(avg * 100) / 100,
            monto_pen: Math.round(avgPen * 100) / 100,
            precio_referencia: null,
            tiene_plan_familiar: false,
            precio_familiar: null,
            // El conteo del CLUSTER recurrente, no el global: mesesConPago incluye
            // los pagos `extras` del otro servicio que comparte el descriptor
            // opaco (Apple), e inflaba los meses de una cuota que no los abarca.
            meses_detectados: recurringMonths,
            ultimo_pago: ultimoPago.fecha,
            categoria_neto: ultimoPago.categoria || 'Otros',
            subcategoria_neto: ultimoPago.subcategoria || 'sin_categoria',
            planes_disponibles: [],
          });
        }
      }
    }
  }

  // Calcular totales. El total en PEN suma los monto_pen persistidos de cada sub (C7): sin
  // reconvertir USD con el TC de hoy. El total en USD suma los montos USD originales (figura
  // real en dólares), que no depende del TC.
  let totalPenPersistido = 0;
  let totalUSD = 0;
  for (const sub of suscripciones) {
    totalPenPersistido += sub.monto_pen;
    if (sub.moneda === 'USD') totalUSD += sub.monto_detectado;
  }

  // Ordenar por monto PEN descendente
  suscripciones.sort((a, b) => b.monto_pen - a.monto_pen);

  return {
    suscripciones_detectadas: suscripciones,
    total_mensual_pen: Math.round(totalPenPersistido * 100) / 100,
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
