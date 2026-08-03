const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { FREEMIUM_ACTIVE, PLAN_CONFIG } = require('../lib/constants');
const analytics = require('../lib/analytics');

// Retención de `conversaciones`. La tabla cumple dos funciones a la vez: contexto
// para el LLM (obtenerHistorial lee 6 turnos) y única evidencia de qué escribió el
// usuario. La purga original guardaba solo los 10 turnos más recientes, así que el
// alta se borraba apenas el usuario tenía algo de actividad — y de los que se caen
// EN el alta no quedaba nada con qué diagnosticar.
//
// HEAD_PROTEGIDO: los primeros turnos de cada usuario (el onboarding) no se purgan
// nunca. TAIL_RETENIDO: cuántos turnos recientes se conservan además del head.
// Peor caso 55 filas por usuario.
const HEAD_PROTEGIDO = 15;
const TAIL_RETENIDO = 40;

async function guardarMensaje(usuarioId, rol, mensaje) {
  try {
    const limiteChars = 10000;
    await supabase.from('conversaciones').insert({ usuario_id: usuarioId, rol: rol, mensaje: mensaje.substring(0, limiteChars) });
    // Candidatos a purga primero: mientras el usuario no pase de TAIL_RETENIDO turnos
    // esto vuelve vacío y no se paga la query del head (el caso común).
    const { data: viejos } = await supabase.from('conversaciones').select('id').eq('usuario_id', usuarioId).order('created_at', { ascending: false }).range(TAIL_RETENIDO, 500);
    if (viejos && viejos.length > 0) {
      const { data: head } = await supabase.from('conversaciones').select('id').eq('usuario_id', usuarioId).order('created_at', { ascending: true }).limit(HEAD_PROTEGIDO);
      const protegidos = new Set((head || []).map(h => h.id));
      const aBorrar = viejos.map(v => v.id).filter(id => !protegidos.has(id));
      if (aBorrar.length > 0) {
        await supabase.from('conversaciones').delete().in('id', aBorrar);
      }
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
  // Sin número no hay nada que buscar ni que crear, y el throw va ANTES de todo a propósito.
  // Dejar pasar un valor vacío no se queda en el `.replace` de abajo: llega al INSERT del
  // final, y como `whatsapp` es NULLABLE (identidad dual web-first, migr 046) el insert NO
  // falla — crea un usuario FANTASMA sin número, imposible de vincular a nadie, que además
  // entra al embudo como un alta real. Fallar acá es más barato que ensuciar `usuarios`.
  if (!numeroWhatsapp || typeof numeroWhatsapp !== 'string') {
    throw new Error('obtenerOCrearUsuario: número de WhatsApp vacío o inválido (' +
      JSON.stringify(numeroWhatsapp) + ')');
  }
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
  // Activación: primer contacto / creación de usuario por WhatsApp.
  analytics.capture(nuevo.id, 'wa_user_registered', {
    channel: 'whatsapp',
    $set: { whatsapp: numeroNorm, plan: nuevo.plan || 'free', signup_channel: 'whatsapp' },
  });
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
