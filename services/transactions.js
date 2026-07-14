const crypto = require('crypto');
const { supabase } = require('../lib/db');
const { validarMonto, normalizarCategoria } = require('../lib/validators');
const { hoyPeru } = require('../lib/dates');
const { esPagoNeto } = require('../lib/config');
const log = require('../lib/logger');
const analytics = require('../lib/analytics');

// Dedup window for manual entries (gmail entries dedup separately).
// Short enough that legitimate rapid entries (e.g. 5 taxis of S/50 in a
// row) don't collide; only catches webhook double-fires which retry
// within a few seconds. Was 5min — caused str-001/002 in QA: 5/8 rapid
// duplicate-content entries collapsed to 3 rows.
const DEDUP_WINDOW_MS = 10 * 1000;

// Cache de tipo de cambio
let _tcCache = null;
let _tcCacheTime = 0;

async function obtenerTipoCambio() {
  const FALLBACK = { compra: 3.82, venta: 3.85 };
  const now = Date.now();
  if (_tcCache && (now - _tcCacheTime) < 86400000) return _tcCache;

  async function fetchTCForDate(fecha) {
    const resp = await fetch('https://dolar.pe/api/public/series?pair=USD-PEN&from=' + fecha + '&to=' + fecha, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const serie = json?.series?.['USD-PEN'];
    if (!serie) return null;
    const data = serie.data || [];
    const last = data[data.length - 1];
    if (typeof last === 'number' && last > 3.0 && last < 5.0) return last;
    return null;
  }

  try {
    let venta = await fetchTCForDate(hoyPeru());
    if (!venta) {
      // dolar.pe puede no tener datos del día actual antes de las ~9am Lima
      venta = await fetchTCForDate(require('../lib/dates').ayerPeru());
    }
    if (venta) {
      _tcCache = { compra: parseFloat((venta * 0.998).toFixed(4)), venta: parseFloat(venta.toFixed(4)) };
      _tcCacheTime = now;
      return _tcCache;
    }
    return _tcCache || FALLBACK;
  } catch(e) {
    log.error({ tag: 'TC', err: e.message }, 'Error tipo cambio');
    return _tcCache || FALLBACK;
  }
}

async function guardarTransaccion(usuarioId, datos) {
  const montoValidado = validarMonto(datos.monto);
  if (montoValidado === null) throw new Error('Monto inválido: ' + datos.monto);
  const _moneda = datos.moneda || 'PEN';
  let _montoPen = montoValidado; let _tcUsado = null;
  if (_moneda === 'USD') { try { const _tc = await obtenerTipoCambio(); _tcUsado = _tc.venta; _montoPen = validarMonto(montoValidado * _tc.venta) || montoValidado; } catch(e) {} }
  // Limpiar comercios genéricos del parser (ej: "Gasto pendiente de BCP S/5 del 2026-04-02" → "BCP")
  if (datos.comercio && /^(gasto|pago|cargo|operaci[oó]n|consumo)\b/i.test(datos.comercio)) {
    const bancos = ['BCP','BBVA','Interbank','Scotiabank','Yape','Plin','Falabella','Ripley','BanBif','Mibanco'];
    const found = bancos.find(b => datos.comercio.toUpperCase().includes(b.toUpperCase()));
    if (found) datos.comercio = found;
  }
  const fechaTx = datos.fecha || hoyPeru();
  const dedupRaw = usuarioId + '|' + fechaTx + '|' + montoValidado + '|' + (datos.comercio || '') + '|' + (datos.tipo || 'gasto');
  const dedupHash = crypto.createHash('md5').update(dedupRaw).digest('hex');
  if (!datos.descripcion_original || !datos.descripcion_original.startsWith('gmail:')) {
    const ventanaInicio = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: existente } = await supabase.from('transacciones').select('id')
      .eq('usuario_id', usuarioId).eq('dedup_hash', dedupHash).gte('created_at', ventanaInicio).limit(1);
    if (existente && existente.length > 0) {
      log.info({ tag: 'DEDUP', hash: dedupHash }, 'Transacción duplicada ignorada');
      return existente[0];
    }
  }
  let catFinal = normalizarCategoria(datos.categoria);
  let subFinal = datos.subcategoria || 'sin_categoria';
  if (datos.comercio) {
    const regla = await buscarReglaComercio(usuarioId, datos.comercio);
    if (regla) { catFinal = regla.categoria; if (regla.subcategoria) subFinal = regla.subcategoria; }
  }
  // Normalizar capitalización de subcategoría para consistencia
  if (subFinal && subFinal !== 'sin_categoria') {
    subFinal = subFinal.charAt(0).toUpperCase() + subFinal.slice(1);
  }
  // Pago de la suscripción a Neto (Yape S/10 o S/99 a Favio Mendoza) → categoría Suscripciones
  if (esPagoNeto(datos)) {
    datos.comercio = 'Neto';
    catFinal = 'Suscripciones';
    subFinal = 'Software';
  }
  const { data, error } = await supabase.from('transacciones').insert({
    usuario_id: usuarioId, tipo: datos.tipo || 'gasto', monto: montoValidado, moneda: _moneda,
    monto_pen: _montoPen, tipo_cambio: _tcUsado, metodo_pago: datos.metodo_pago || null,
    comercio: datos.comercio, categoria: catFinal,
    subcategoria: subFinal, banco: datos.banco,
    fecha: fechaTx,
    descripcion_original: datos.descripcion_original, confirmado: false,
    dedup_hash: dedupHash
  }).select().single();
  if (error) throw error;
  // Activación: primera transacción del usuario (excluye importación masiva de Gmail).
  if (!datos.descripcion_original || !datos.descripcion_original.startsWith('gmail:')) {
    try {
      const { count } = await supabase.from('transacciones')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', usuarioId);
      if (count === 1) {
        analytics.capture(usuarioId, 'wa_first_transaction', { tipo: data.tipo, categoria: data.categoria });
      }
    } catch (e) { /* nunca romper el registro por analytics */ }
  }
  return data;
}

async function obtenerGastosMes(usuarioId, fechaMinima) {
  const hoyStr = hoyPeru();
  const parts = hoyStr.split('-');
  const primero = parts[0] + '-' + parts[1] + '-01';
  const desde = fechaMinima && fechaMinima > primero ? fechaMinima : primero;
  const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto').gte('fecha', desde).order('fecha', { ascending: false });
  return data || [];
}

async function obtenerGastosSemana(usuarioId, fechaMinima) {
  const hoyStr = hoyPeru();
  const hoy = new Date(hoyStr + 'T12:00:00');
  hoy.setDate(hoy.getDate() - 7);
  const desdeStr = hoy.toISOString().split('T')[0];
  const desde = fechaMinima && fechaMinima > desdeStr ? fechaMinima : desdeStr;
  const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto').gte('fecha', desde).order('fecha', { ascending: false });
  return data || [];
}

async function obtenerUltimaTransaccion(usuarioId) {
  const { data } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId)
    .order('created_at', { ascending: false }).limit(1).single();
  return data || null;
}

async function recategorizarTransaccion(usuarioId, comercio, categoriaNueva, subcategoriaNueva) {
  let { data: txs } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId).ilike('comercio', '%' + comercio + '%')
    .order('created_at', { ascending: false }).limit(5);
  if ((!txs || txs.length === 0) && comercio.length > 3) {
    const palabras = comercio.split(/\s+/).filter(p => p.length >= 3);
    for (const palabra of palabras) {
      const { data: txsPalabra } = await supabase.from('transacciones').select('*')
        .eq('usuario_id', usuarioId).ilike('comercio', '%' + palabra + '%')
        .order('created_at', { ascending: false }).limit(5);
      if (txsPalabra && txsPalabra.length > 0) { txs = txsPalabra; break; }
    }
  }
  if (!txs || txs.length === 0) return { ok: false, msg: 'No encontre ninguna transaccion de *' + comercio + '*.' };
  const tx = txs[0];
  const categoriaAnterior = tx.categoria || 'Sin categoria';
  const updates = { categoria: categoriaNueva };
  if (subcategoriaNueva) updates.subcategoria = subcategoriaNueva;
  const { error } = await supabase.from('transacciones').update(updates).eq('id', tx.id);
  if (error) return { ok: false, msg: 'Error actualizando: ' + error.message };
  return { ok: true, tx, msg: 'Listo! Movi *' + (tx.comercio || comercio) + '* (S/ ' + tx.monto + ') de *' + categoriaAnterior + '* a *' + categoriaNueva + (subcategoriaNueva ? ' > ' + subcategoriaNueva : '') + '*.' };
}

async function recategorizarPorId(transaccionId, categoriaNueva) {
  const { error } = await supabase.from('transacciones').update({ categoria: categoriaNueva }).eq('id', transaccionId);
  if (error) return { ok: false, msg: 'Error actualizando.' };
  return { ok: true };
}

async function corregirTransaccionEspecifica(usuarioId, comercio, monto, fecha, categoriaNueva, subcategoriaNueva) {
  let query = supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId)
    .ilike('comercio', '%' + comercio + '%')
    .order('fecha', { ascending: false })
    .limit(10);
  const { data: txs } = await query;
  if (!txs || txs.length === 0) return { ok: false, comercio };
  let tx = txs[0];
  if (fecha || monto) {
    const match = txs.find(t => {
      const fechaOk = !fecha || (t.fecha && t.fecha.startsWith(fecha));
      const montoOk = !monto || Math.abs(parseFloat(t.monto) - monto) < 0.5;
      return fechaOk && montoOk;
    });
    if (match) tx = match;
  }
  const updates = { categoria: categoriaNueva };
  if (subcategoriaNueva) updates.subcategoria = subcategoriaNueva;
  const { error } = await supabase.from('transacciones').update(updates).eq('id', tx.id);
  if (error) return { ok: false, comercio };
  return { ok: true, comercio: tx.comercio || comercio, monto: tx.monto_pen || tx.monto, moneda: tx.moneda || 'PEN' };
}

// --- Reglas de comercio ---

// Una regla PISA la categoria que dedujo la NLP (ver guardarTransaccion), asi que
// una regla que no clasifica nada es peor que no tener regla: condena al comercio
// a caer sin clasificar para siempre, aunque la NLP hubiera acertado. Dos casos:
//
//   - subcategoria 'sin_categoria' / 'null' -> se normaliza a null (la categoria
//     sigue sirviendo: "metro" -> Comida sin sub es una regla util).
//   - categoria "Otros" y ademas sin subcategoria -> no enseña nada. No se guarda.
//     ("Otros / Regalo" si es legitima: es una clasificacion deliberada.)
//
// Espejo de needsReview() en webapp/src/lib/constants.ts — si cambia una, cambia
// la otra (backend CommonJS y webapp TS no comparten modulo).
function normalizarDestinoRegla(categoria, subcategoria) {
  const cat = (categoria || '').trim();
  const sub = (subcategoria || '').trim();
  const subUtil = ['', 'sin_categoria', 'null'].includes(sub.toLowerCase()) ? null : sub;
  if (!cat) return null;
  if (cat.toLowerCase() === 'otros' && !subUtil) return null;
  return { categoria: cat, subcategoria: subUtil };
}

async function guardarReglaComercio(usuarioId, comercio, categoria, subcategoria) {
  if (!comercio) return;
  const patron = comercio.toLowerCase().trim();
  if (!patron) return;

  const destino = normalizarDestinoRegla(categoria, subcategoria);
  if (!destino) {
    log.info({ tag: 'REGLA', comercio: patron, categoria, subcategoria }, 'Regla descartada: no clasifica nada');
    return;
  }

  try {
    await supabase.from('reglas_comercio').upsert({
      usuario_id: usuarioId, comercio_pattern: patron,
      categoria: destino.categoria, subcategoria: destino.subcategoria,
      updated_at: new Date().toISOString()
    }, { onConflict: 'usuario_id,comercio_pattern' });
  } catch(e) { log.error({ tag: 'REGLA', err: e.message }, 'Error guardando regla comercio'); }
}

async function buscarReglaComercio(usuarioId, comercio) {
  if (!comercio) return null;
  const patron = comercio.toLowerCase().trim();
  const { data } = await supabase.from('reglas_comercio').select('categoria,subcategoria')
    .eq('usuario_id', usuarioId).eq('comercio_pattern', patron).single();
  return data || null;
}

async function retroaplicarRegla(usuarioId, comercio, categoria, subcategoria) {
  if (!comercio || !categoria) return 0;
  try {
    const updates = { categoria };
    if (subcategoria) updates.subcategoria = subcategoria;
    const { count } = await supabase.from('transacciones').update(updates, { count: 'exact' })
      .eq('usuario_id', usuarioId).ilike('comercio', '%' + comercio + '%');
    log.info({ tag: 'REGLA', comercio, categoria, subcategoria, count }, 'Regla retroaplicada');
    return count || 0;
  } catch(e) { log.error({ tag: 'RETROAPLICAR', err: e.message }, 'Error retroaplicando regla'); return 0; }
}

module.exports = {
  obtenerTipoCambio, guardarTransaccion,
  obtenerGastosMes, obtenerGastosSemana, obtenerUltimaTransaccion,
  recategorizarTransaccion, recategorizarPorId, corregirTransaccionEspecifica,
  guardarReglaComercio, buscarReglaComercio, retroaplicarRegla,
  DEDUP_WINDOW_MS,
};
