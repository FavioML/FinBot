const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { FREEMIUM_ACTIVE, PLAN_CONFIG } = require('../lib/constants');

async function guardarMensaje(usuarioId, rol, mensaje) {
  try {
    const limiteChars = 10000;
    await supabase.from('conversaciones').insert({ usuario_id: usuarioId, rol: rol, mensaje: mensaje.substring(0, limiteChars) });
    const { data: viejos } = await supabase.from('conversaciones').select('id').eq('usuario_id', usuarioId).order('created_at', { ascending: false }).range(10, 100);
    if (viejos && viejos.length > 0) {
      await supabase.from('conversaciones').delete().in('id', viejos.map(v => v.id));
    }
  } catch(e) { log.error({ tag: 'HISTORIAL', err: e.message }, 'Error guardando historial'); }
}

async function obtenerHistorial(usuarioId) {
  try {
    const { data } = await supabase.from('conversaciones').select('rol, mensaje, created_at').eq('usuario_id', usuarioId).order('created_at', { ascending: false }).limit(6);
    if (!data || data.length === 0) return [];
    return data.reverse();
  } catch(e) { return []; }
}

async function obtenerOCrearUsuario(numeroWhatsapp) {
  const numeroNorm = numeroWhatsapp.replace(/^whatsapp:/i, '').replace(/^\+/, '');
  try {
    const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroNorm).single();
    if (data) return data;
  } catch (e) {}
  try {
    const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroWhatsapp).single();
    if (data) {
      await supabase.from('usuarios').update({ whatsapp: numeroNorm }).eq('whatsapp', numeroWhatsapp);
      data.whatsapp = numeroNorm;
      return data;
    }
  } catch (e) {}
  const { data: nuevo, error } = await supabase.from('usuarios').insert({ whatsapp: numeroNorm }).select().single();
  if (error) throw new Error('Error creando usuario: ' + error.message);
  return nuevo;
}

function getUserPlanConfig(usuario) {
  if (!FREEMIUM_ACTIVE) return PLAN_CONFIG.premium;
  const plan = usuario.plan || 'free';
  return PLAN_CONFIG[plan] || PLAN_CONFIG.free;
}

function getHistoryDateLimit(usuario) {
  const config = getUserPlanConfig(usuario);
  if (!config.historyMonths) return null;
  const parts = hoyPeru().split('-');
  const limit = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1 - config.historyMonths, parseInt(parts[2]));
  return limit.toISOString().split('T')[0];
}

module.exports = {
  guardarMensaje,
  obtenerHistorial,
  obtenerOCrearUsuario,
  getUserPlanConfig,
  getHistoryDateLimit,
};
