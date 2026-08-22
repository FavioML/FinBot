const { supabase } = require('../lib/db');
const { hoyPeru } = require('../lib/dates');
const log = require('../lib/logger');
const { validarMonto } = require('../lib/validators');

/**
 * El monto se valida ACÁ, en el chokepoint de deudas, y no solo en los handlers.
 *
 * Es el mismo criterio que `guardarTransaccion`: un archivo que escribe plata valida
 * su propia entrada, así el call-site nuevo que se olvide no abre un hueco. Lo delató
 * `tests/plata-validada.test.js` el día que se escribió — este módulo insertaba
 * `monto_original` y `monto_pendiente` sin mirar el número, y el guard de arriba
 * (`handlers/intents/deudas.js`) era `parseFloat` + `> 0` + `isNaN`, o sea sin
 * `isFinite` y sin techo: exactamente el gemelo de B18, que se cerró para
 * transacciones y no para deudas.
 *
 * `isNaN(Infinity)` es false, así que `1e999` pasaba los tres checks, y PostgREST
 * serializa Infinity como `null`: `monto_pendiente = null` es la deuda envenenada de
 * forma permanente que qa-money-edge ya documentó como P0 por el lado de la webapp.
 */
function montoDeDeuda(valor) {
  const v = validarMonto(valor);
  if (v === null) throw new Error('Monto de deuda inválido: ' + valor);
  return v;
}

/**
 * Registra una deuda nueva.
 * @param {string} usuarioId
 * @param {'debo'|'me_deben'} tipo
 * @param {string} contraparte - nombre del acreedor/deudor
 * @param {number} monto
 * @param {string} moneda - 'PEN' o 'USD'
 * @param {string|null} descripcion
 */
async function registrarDeuda(usuarioId, tipo, contraparte, monto, moneda = 'PEN', descripcion = null, fechaVencimiento = null) {
  const montoValidado = montoDeDeuda(monto);
  const { data, error } = await supabase.from('deudas').insert({
    usuario_id: usuarioId,
    tipo,
    contraparte: contraparte.trim(),
    monto_original: montoValidado,
    monto_pendiente: montoValidado,
    moneda,
    descripcion: descripcion ? descripcion.trim() : null,
    fecha_vencimiento: fechaVencimiento || null,
    estado: 'activa',
  }).select().single();
  if (error) throw error;
  return data;
}

/**
 * Obtiene todas las deudas activas del usuario.
 */
async function obtenerDeudas(usuarioId, soloActivas = true) {
  let q = supabase.from('deudas').select('*').eq('usuario_id', usuarioId).order('created_at', { ascending: false });
  if (soloActivas) q = q.eq('estado', 'activa');
  const { data, error } = await q;
  // El fallback a [] es legitimo (usuario sin deudas), pero un error de query se veia
  // identico a "no tiene deudas" en los 10+ call sites. Ahora deja rastro.
  if (error) log.error({ tag: 'DEUDAS', usuarioId, err: error.message }, 'Query deudas fallo: se devuelve lista vacia');
  return data || [];
}

/**
 * Registra un abono a una deuda y actualiza monto_pendiente.
 * Si el monto_pendiente llega a 0, marca la deuda como pagada.
 * @param {string} usuarioId
 * @param {string} contraparte - busca deuda activa por nombre (fuzzy)
 * @param {number} montoAbono
 * @returns {{ deuda, abono, completada }}
 */
async function abonarDeuda(usuarioId, contraparte, montoAbono) {
  // Antes de tocar la DB: un abono Infinity pasaba el `montoAbono > pendiente` de más
  // abajo (Infinity > 100 corta bien) pero un NaN NO —toda comparación con NaN es
  // false—, así que el sobrepago no lo frenaba y `pendiente - NaN` dejaba la deuda en
  // NaN para siempre. Acá lanza, que es lo que el handler ya sabe convertir en mensaje.
  const montoValidado = montoDeDeuda(montoAbono);
  // Buscar la deuda activa más reciente que coincida con la contraparte
  const { data: deudas, error: errDeudas } = await supabase.from('deudas')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('estado', 'activa')
    .ilike('contraparte', `%${contraparte.trim()}%`)
    .order('created_at', { ascending: false });
  // Sin leer el error, `deudas` viene null y el `return null` de abajo es indistinguible de
  // "no le debes nada a esa persona". El handler lo traduce a ese mensaje y el abono se
  // pierde: el usuario cree que dijo algo que Neto no entendio. Tirar deja que el handler
  // diga que fallo, que es lo unico honesto que se puede decir aca.
  if (errDeudas) throw errDeudas;

  if (!deudas || deudas.length === 0) return null;

  const deuda = deudas[0];
  const pendiente = parseFloat(deuda.monto_pendiente);

  // Prevent overpayment
  if (montoValidado > pendiente) {
    // `moneda` va en el return porque el handler la lee (`resultado.moneda`) para
    // elegir el símbolo. Nunca estuvo, así que un sobrepago sobre una deuda en dólares
    // decía "El abono de S/ 100 excede lo pendiente (S/ 20)". El test que lo cubría
    // mockeaba un campo que la función no producía.
    return { error: 'overpayment', monto_pendiente: pendiente, moneda: deuda.moneda };
  }

  const nuevoPendiente = Math.max(0, pendiente - montoValidado);
  const completada = nuevoPendiente === 0;

  // Insertar abono
  const { data: abono, error: eAbono } = await supabase.from('deuda_abonos').insert({
    deuda_id: deuda.id,
    monto: montoValidado,
    fecha: hoyPeru(),
  }).select().single();
  if (eAbono) throw eAbono;

  // Actualizar deuda
  const { data: deudaActualizada, error: eDeuda } = await supabase.from('deudas').update({
    monto_pendiente: nuevoPendiente,
    estado: completada ? 'pagada' : 'activa',
    updated_at: new Date().toISOString(),
  }).eq('id', deuda.id).select().single();
  if (eDeuda) throw eDeuda;

  return { deuda: deudaActualizada, abono, completada };
}

/**
 * Marca una deuda como pagada por nombre de contraparte.
 */
async function marcarDeudaPagada(usuarioId, contraparte) {
  const { data: deudas, error: errDeudas } = await supabase.from('deudas')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('estado', 'activa')
    .ilike('contraparte', `%${contraparte.trim()}%`)
    .order('created_at', { ascending: false });
  // Mismo engano que en `abonarDeuda`, y aca la consecuencia es que la deuda queda
  // sin saldar mientras al usuario se le dice que no existe.
  if (errDeudas) throw errDeudas;

  if (!deudas || deudas.length === 0) return null;

  const deuda = deudas[0];
  const { data, error } = await supabase.from('deudas').update({
    monto_pendiente: 0,
    estado: 'pagada',
    updated_at: new Date().toISOString(),
  }).eq('id', deuda.id).select().single();
  if (error) throw error;
  return data;
}

/**
 * Formatea el resumen de deudas para WhatsApp.
 */
async function formatearResumenDeudas(usuarioId) {
  const deudas = await obtenerDeudas(usuarioId);
  if (deudas.length === 0) {
    return 'Todo limpio, no tienes deudas pendientes. 👏\n\nSi necesitas anotar alguna, dime algo como:\n_"debo 200 a Juan"_ o _"Pedro me debe 100 por la cena"_';
  }

  const debo = deudas.filter(d => d.tipo === 'debo');
  const meDeben = deudas.filter(d => d.tipo === 'me_deben');

  const totalDeboPen = debo.filter(d => d.moneda !== 'USD').reduce((s, d) => s + parseFloat(d.monto_pendiente), 0);
  const totalDeboUsd = debo.filter(d => d.moneda === 'USD').reduce((s, d) => s + parseFloat(d.monto_pendiente), 0);
  const totalMeDebenPen = meDeben.filter(d => d.moneda !== 'USD').reduce((s, d) => s + parseFloat(d.monto_pendiente), 0);
  const totalMeDebenUsd = meDeben.filter(d => d.moneda === 'USD').reduce((s, d) => s + parseFloat(d.monto_pendiente), 0);

  let msg = '';

  if (debo.length > 0) {
    const sym = d => d.moneda === 'USD' ? '$' : 'S/';
    let totalDeboStr = 'S/ ' + totalDeboPen.toFixed(2);
    if (totalDeboUsd > 0) totalDeboStr += (totalDeboPen > 0 ? ' + ' : '') + '$ ' + totalDeboUsd.toFixed(2);
    msg += '📤 *Lo que debes* (Total: ' + totalDeboStr + '):\n\n';
    for (const d of debo) {
      const pct = Math.round(((parseFloat(d.monto_original) - parseFloat(d.monto_pendiente)) / parseFloat(d.monto_original)) * 100);
      msg += '• *' + d.contraparte + '* → ' + sym(d) + ' ' + parseFloat(d.monto_pendiente).toFixed(2);
      if (d.descripcion) msg += ' _(' + d.descripcion + ')_';
      if (pct > 0) msg += ' [' + pct + '% pagado]';
      msg += '\n';
    }
  }

  if (meDeben.length > 0) {
    if (msg) msg += '\n';
    let totalMeDebenStr = 'S/ ' + totalMeDebenPen.toFixed(2);
    if (totalMeDebenUsd > 0) totalMeDebenStr += (totalMeDebenPen > 0 ? ' + ' : '') + '$ ' + totalMeDebenUsd.toFixed(2);
    msg += '📥 *Lo que te deben* (Total: ' + totalMeDebenStr + '):\n\n';
    const sym = d => d.moneda === 'USD' ? '$' : 'S/';
    for (const d of meDeben) {
      msg += '• *' + d.contraparte + '* → ' + sym(d) + ' ' + parseFloat(d.monto_pendiente).toFixed(2);
      if (d.descripcion) msg += ' _(' + d.descripcion + ')_';
      msg += '\n';
    }
  }

  msg += '\n_Escribe "pagué a [nombre]" para registrar un abono._';
  return msg;
}

/**
 * Obtiene deudas activas próximas a vencer (para recordatorios cron).
 * @returns {Array} deudas con datos del usuario (whatsapp, nombre)
 */
async function obtenerDeudasProximasVencer() {
  const hoy = hoyPeru();
  const hoyDate = new Date(hoy + 'T12:00:00');
  const desde = new Date(hoyDate); desde.setDate(desde.getDate() - 3);
  const hasta = new Date(hoyDate); hasta.setDate(hasta.getDate() + 3);

  // `plan` va en el embed porque el recordatorio manda el ledger de deudas por WhatsApp, y
  // `ver_deudas` está en INTENTS_LECTURA: se cobra. Sin esta columna el cron no tenía cómo
  // saltar a quien está en el muro.
  const { data, error } = await supabase.from('deudas')
    .select('*, usuarios!inner(whatsapp, nombre, plan, recordatorios_activos)')
    .eq('estado', 'activa')
    .not('fecha_vencimiento', 'is', null)
    .gte('fecha_vencimiento', desde.toISOString().split('T')[0])
    .lte('fecha_vencimiento', hasta.toISOString().split('T')[0]);
  // La poblacion de `checkRecordatorioDeudas`: el `|| []` convierte una caida en "hoy no
  // vence ninguna deuda", que es el silencio exacto que costo 12 dias en el cron gemelo. El
  // catch de `checkRecordatorioDeudas` loguea con su tag, asi que tirar deja rastro y no
  // manda nada — la decision correcta, ahora dicha en voz alta.
  if (error) throw error;

  return data || [];
}

/**
 * Consolida deudas activas por contraparte (totales por moneda).
 */
async function consolidarDeudasPorContraparte(usuarioId, contraparte) {
  const { data: deudas, error: errDeudas } = await supabase.from('deudas')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('estado', 'activa')
    .ilike('contraparte', '%' + contraparte.trim() + '%')
    .order('created_at', { ascending: false });
  if (errDeudas) throw errDeudas;

  if (!deudas || deudas.length === 0) return null;

  const nombreReal = deudas[0].contraparte;
  const totales = { PEN: 0, USD: 0 };
  const debo = { PEN: 0, USD: 0 };
  const meDeben = { PEN: 0, USD: 0 };

  for (const d of deudas) {
    const m = parseFloat(d.monto_pendiente);
    totales[d.moneda || 'PEN'] += m;
    if (d.tipo === 'debo') debo[d.moneda || 'PEN'] += m;
    else meDeben[d.moneda || 'PEN'] += m;
  }

  return { contraparte: nombreReal, totales, debo, meDeben, deudas };
}

/**
 * Marca TODAS las deudas activas con una contraparte como pagadas.
 * @returns {number} cantidad de deudas saldadas
 */
async function saldarTodasDeudas(usuarioId, contraparte) {
  const { data: deudas, error: errDeudas } = await supabase.from('deudas')
    .select('id')
    .eq('usuario_id', usuarioId)
    .eq('estado', 'activa')
    .ilike('contraparte', '%' + contraparte.trim() + '%');
  // El `return 0` de abajo se reporta como "no habia nada que saldar". Con la base caida eso
  // es un saldo que el usuario da por cerrado y sigue abierto.
  if (errDeudas) throw errDeudas;

  if (!deudas || deudas.length === 0) return 0;

  const ids = deudas.map(d => d.id);
  const { error } = await supabase.from('deudas').update({
    monto_pendiente: 0,
    estado: 'pagada',
    updated_at: new Date().toISOString(),
  }).in('id', ids);

  if (error) throw error;
  return ids.length;
}

module.exports = {
  registrarDeuda,
  obtenerDeudas,
  abonarDeuda,
  marcarDeudaPagada,
  formatearResumenDeudas,
  obtenerDeudasProximasVencer,
  consolidarDeudasPorContraparte,
  saldarTodasDeudas,
};
