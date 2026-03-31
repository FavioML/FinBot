const { supabase } = require('../lib/db');

/**
 * Registra una deuda nueva.
 * @param {string} usuarioId
 * @param {'debo'|'me_deben'} tipo
 * @param {string} contraparte - nombre del acreedor/deudor
 * @param {number} monto
 * @param {string} moneda - 'PEN' o 'USD'
 * @param {string|null} descripcion
 */
async function registrarDeuda(usuarioId, tipo, contraparte, monto, moneda = 'PEN', descripcion = null) {
  const { data, error } = await supabase.from('deudas').insert({
    usuario_id: usuarioId,
    tipo,
    contraparte: contraparte.trim(),
    monto_original: monto,
    monto_pendiente: monto,
    moneda,
    descripcion: descripcion ? descripcion.trim() : null,
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
  const { data } = await q;
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
  // Buscar la deuda activa más reciente que coincida con la contraparte
  const { data: deudas } = await supabase.from('deudas')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('estado', 'activa')
    .ilike('contraparte', `%${contraparte.trim()}%`)
    .order('created_at', { ascending: false });

  if (!deudas || deudas.length === 0) return null;

  const deuda = deudas[0];
  const nuevoPendiente = Math.max(0, parseFloat(deuda.monto_pendiente) - montoAbono);
  const completada = nuevoPendiente === 0;

  // Insertar abono
  const { data: abono, error: eAbono } = await supabase.from('deuda_abonos').insert({
    deuda_id: deuda.id,
    monto: montoAbono,
    fecha: new Date().toISOString().split('T')[0],
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
  const { data: deudas } = await supabase.from('deudas')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('estado', 'activa')
    .ilike('contraparte', `%${contraparte.trim()}%`)
    .order('created_at', { ascending: false });

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
    return 'No tienes deudas activas registradas. 👏\n\nPara registrar una escribe:\n_"debo S/200 a Juan"_\n_"Pedro me debe S/100 por la cena"_';
  }

  const debo = deudas.filter(d => d.tipo === 'debo');
  const meDeben = deudas.filter(d => d.tipo === 'me_deben');

  const totalDebo = debo.reduce((s, d) => s + parseFloat(d.monto_pendiente), 0);
  const totalMeDeben = meDeben.reduce((s, d) => s + parseFloat(d.monto_pendiente), 0);

  let msg = '';

  if (debo.length > 0) {
    const sym = d => d.moneda === 'USD' ? '$' : 'S/';
    msg += '📤 *Lo que debes* (Total: S/ ' + totalDebo.toFixed(2) + '):\n\n';
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
    msg += '📥 *Lo que te deben* (Total: S/ ' + totalMeDeben.toFixed(2) + '):\n\n';
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

module.exports = {
  registrarDeuda,
  obtenerDeudas,
  abonarDeuda,
  marcarDeudaPagada,
  formatearResumenDeudas,
};
