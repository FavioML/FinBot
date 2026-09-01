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

/**
 * @returns {Promise<boolean>} si el turno quedó escrito en `conversaciones`.
 *
 * **Devuelve un booleano desde el 31-ago-2026, y no es cosmético.** Antes no devolvía nada y
 * su `catch` se tragaba todo, así que `await guardarMensaje(...)` resolvía pase lo que pasase
 * — la trampa de `feedback_await_que_resuelve_no_prueba_exito`. El único llamador que informa
 * el resultado (`/admin/notify`, con `saved_in_history`) lo deducía de que no hubiera
 * excepción, así que decía `true` sobre un INSERT rechazado. Leer el `{ error }` acá sin
 * devolverlo dejaba ese informe igual de falso, con la diferencia de que ahora la función SÍ
 * sabía. Lo encontró la revisión adversarial.
 *
 * La purga no afecta el valor: el turno ya está escrito y que no se pueda podar el historial
 * viejo no lo desescribe.
 */
async function guardarMensaje(usuarioId, rol, mensaje) {
  try {
    const limiteChars = 10000;
    const { error: errInsert } = await supabase.from('conversaciones').insert({ usuario_id: usuarioId, rol: rol, mensaje: mensaje.substring(0, limiteChars) });
    // No corta: `conversaciones` es contexto e historial, no la escritura que el usuario vino
    // a hacer. Pero sin este log un turno perdido no deja ni rastro, y esta tabla es la UNICA
    // evidencia de que el usuario escribio algo (ver el comentario de retencion, arriba).
    if (errInsert) {
      log.error({ tag: 'HISTORIAL', err: errInsert.message, usuarioId, rol }, 'No se pudo guardar el turno en conversaciones');
      return false;
    }
    // Candidatos a purga primero: mientras el usuario no pase de TAIL_RETENIDO turnos
    // esto vuelve vacío y no se paga la query del head (el caso común).
    const { data: viejos, error: errViejos } = await supabase.from('conversaciones').select('id').eq('usuario_id', usuarioId).order('created_at', { ascending: false }).range(TAIL_RETENIDO, 500);
    if (errViejos) {
      log.error({ tag: 'HISTORIAL', err: errViejos.message, usuarioId }, 'No se pudieron leer los candidatos a purga: no se purga nada');
      return true;
    }
    if (viejos && viejos.length > 0) {
      const { data: head, error: errHead } = await supabase.from('conversaciones').select('id').eq('usuario_id', usuarioId).order('created_at', { ascending: true }).limit(HEAD_PROTEGIDO);
      // **La peor de las tres, y la razon por la que este archivo no era cosmetico.** Sin leer
      // el error, un fallo de ESTA lectura dejaba `head` en null, `protegidos` vacio, y
      // `aBorrar` pasaba a ser TODA la lista de viejos — incluidos los HEAD_PROTEGIDO turnos
      // del onboarding que el comentario de arriba promete que "no se purgan nunca". O sea que
      // una caida transitoria de la base borraba de forma PERMANENTE la unica evidencia de como
      // se dio de alta esa persona. Su hermana de arriba falla hacia el lado seguro (no purga);
      // esta fallaba hacia el lado que destruye datos.
      if (errHead) {
        log.error({ tag: 'HISTORIAL', err: errHead.message, usuarioId }, 'No se pudo leer el head protegido: no se purga nada');
        return true;
      }
      const protegidos = new Set((head || []).map(h => h.id));
      const aBorrar = viejos.map(v => v.id).filter(id => !protegidos.has(id));
      if (aBorrar.length > 0) {
        const { error: errBorrado } = await supabase.from('conversaciones').delete().in('id', aBorrar);
        if (errBorrado) log.error({ tag: 'HISTORIAL', err: errBorrado.message, usuarioId, cuantos: aBorrar.length }, 'No se pudo purgar el historial viejo');
      }
    }
    return true;
  } catch(e) {
    // Sigue siendo alcanzable, y NO por las queries: supabase-js no lanza. Lo que puede tirar
    // aca es `mensaje.substring` con un `mensaje` que no sea string.
    log.error({ tag: 'HISTORIAL', err: e.message }, 'Error guardando historial');
    return false;
  }
}

async function obtenerHistorial(usuarioId) {
  try {
    const { data, error } = await supabase.from('conversaciones').select('rol, mensaje, created_at').eq('usuario_id', usuarioId).order('created_at', { ascending: false }).limit(6);
    // Devuelve `[]` igual: el LLM tiene que poder contestar sin contexto, y cortar el mensaje
    // del usuario por no tener historial seria peor. Lo que cambia es que "no hay turnos
    // previos" deja de ser indistinguible de "no pude leerlos" — que es lo que se ve despues
    // como un Neto que contesta como si fuera el primer mensaje.
    if (error) {
      log.error({ tag: 'HISTORIAL', err: error.message, usuarioId }, 'No se pudo leer el historial: se responde SIN contexto');
      return [];
    }
    if (!data || data.length === 0) return [];
    return data.reverse();
  } catch(e) { return []; }
}

// Aprende el BSUID de un usuario que HOY todavía manda su número. Ver migración 065: es lo
// único que lo conectará con su cuenta el día que active un username de WhatsApp y `from`
// deje de venir.
//
// Dos reglas, y las dos importan:
// - **Nunca borra.** Los call-sites que no vienen del webhook no tienen BSUID a mano, y un
//   `null` de ellos no debe limpiar lo ya aprendido.
// - **Nunca rompe el flujo.** Es enriquecimiento, no parte del alta. Si el UPDATE falla (por
//   ejemplo si el índice único choca porque ese BSUID ya está en otra fila, que sería un
//   usuario duplicado) se registra y se sigue: el mensaje del usuario vale más que la columna.
//
// Ojo con el corolario, que costó un hallazgo (B19): como esta función se traga el fallo, un
// `await persistirBsuid(...)` que resuelve **no prueba que el UPDATE haya pegado**. Quien
// necesite esa distinción —hoy solo el camino saliente, que deja de consultar para siempre—
// tiene que usar `persistirBsuidConEstado`, no inferirla de que no hubo excepción.
//
//   guardado   → el UPDATE confirmó
//   sin_cambio → no había nada que escribir (sin BSUID, sin usuario, o ya lo tenía)
//   colision   → 23505: ese BSUID vive en OTRA fila. Permanente; reintentar no lo arregla
//   fallo      → transitorio (red, timeout, error de Postgres). Se puede reintentar
async function persistirBsuidConEstado(usuario, bsuid) {
  if (!bsuid || !usuario || !usuario.id || usuario.bsuid === bsuid) return { usuario, estado: 'sin_cambio' };
  try {
    const { error } = await supabase.from('usuarios').update({ bsuid }).eq('id', usuario.id);
    if (error) {
      // 23505 no es "no se pudo guardar": es que ESE BSUID ya está en OTRA fila, o sea que
      // la misma persona tiene dos usuarios y Meta nos lo acaba de decir. Colapsarlo en el
      // log genérico de abajo era perder la única señal automática de identidad partida que
      // existe — y la identidad partida es exactamente lo que el BSUID vino a evitar
      // (hallazgo B21). Va con tag propio y a `errores`, que es donde se busca por usuario.
      if (error.code === '23505') {
        const { data: duenio, error: errDuenio } = await supabase.from('usuarios')
          .select('id, whatsapp, created_at').eq('bsuid', bsuid).maybeSingle();
        // El estado sigue siendo `colision` con o sin este dato: el 23505 ya lo probo. Lo que
        // se pierde sin leer el error es saber POR QUE `otroUsuarioId` viene vacio, y esa
        // columna es la mitad util del hallazgo de identidad partida (B21).
        if (errDuenio) log.error({ tag: 'BSUID_COLISION', err: errDuenio.message, bsuid }, 'No se pudo identificar al otro dueño del BSUID');
        log.error({ tag: 'BSUID_COLISION', usuarioId: usuario.id, otroUsuarioId: duenio && duenio.id, bsuid },
          'El BSUID ya pertenece a otro usuario: identidad partida');
        try {
          require('../lib/error-monitor').registrarError('BSUID_COLISION',
            'BSUID ya asignado a otro usuario',
            { usuarioId: usuario.id, otroUsuarioId: duenio && duenio.id, bsuid });
        } catch (e2) { /* el registro del diagnóstico nunca puede romper el mensaje */ }
        return { usuario, estado: 'colision' };
      }
      log.error({ tag: 'BSUID', err: error.message, usuarioId: usuario.id }, 'No se pudo guardar el BSUID');
      return { usuario, estado: 'fallo' };
    }
    usuario.bsuid = bsuid;
    log.info({ tag: 'BSUID', usuarioId: usuario.id }, 'BSUID aprendido');
  } catch (e) {
    log.error({ tag: 'BSUID', err: e.message, usuarioId: usuario.id }, 'No se pudo guardar el BSUID');
    return { usuario, estado: 'fallo' };
  }
  return { usuario, estado: 'guardado' };
}

// La forma que usa el camino caliente: devuelve el usuario y nada más. Los call-sites del alta
// lo encadenan directo en su `return`, y ninguno de ellos puede hacer nada con el estado.
async function persistirBsuid(usuario, bsuid) {
  const { usuario: u } = await persistirBsuidConEstado(usuario, bsuid);
  return u;
}

// Reconoce a un usuario cuando Meta ya no manda su número (activó un username de WhatsApp) y
// lo único que llega es el BSUID. Solo encuentra a quien escribió alguna vez DESPUÉS de la
// migración 065: antes de eso no había dónde guardarlo. No crea nada — si no está, no está.
async function buscarUsuarioPorBsuid(bsuid) {
  if (!bsuid) return null;
  try {
    const { data, error } = await supabase.from('usuarios').select('*').eq('bsuid', bsuid).maybeSingle();
    // Devuelve null igual —sin numero no hay nada mejor que hacer con este mensaje— pero el
    // log cambia de significado: el llamador (handlers/webhook.js) escribe "Mensaje entrante
    // sin from — se descarta" y una fila en `errores` que dice DESCONOCIDO. Con la lectura
    // caida eso es falso, y esconde el caso caro: el gasto de alguien IDENTIFICADO que se
    // perdio por una caida, que es justo lo que el BSUID vino a evitar.
    if (error) {
      log.error({ tag: 'BSUID', err: error.message, bsuid }, 'No se pudo buscar por BSUID: el mensaje se descarta como DESCONOCIDO sin serlo');
      return null;
    }
    return data || null;
  } catch (e) {
    log.error({ tag: 'BSUID', err: e.message }, 'Error buscando usuario por BSUID');
    return null;
  }
}

async function obtenerOCrearUsuario(numeroWhatsapp, bsuid = null) {
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
  // **Los dos `try/catch` que envolvían estas lecturas eran INALCANZABLES**, y no eran un
  // descuido de estilo: estaban escritos creyendo que `.single()` LANZA cuando no encuentra
  // fila. No lanza — supabase-js devuelve `{ data: null, error: PGRST116 }` — así que el
  // `catch {}` vacío nunca corrió una sola vez y lo que de verdad hacía caer al INSERT era el
  // `if (data)` en falso. Es el tercer caso de la misma clase que dejó el ítem 20.
  //
  // **Estas dos fallan ABIERTO y la decisión se apoya en un hecho de la base, no en un
  // gusto:** `usuarios_whatsapp_key` es un índice ÚNICO (verificado contra producción el
  // 31-ago-2026). O sea que si la lectura se cae y caemos igual al INSERT, Postgres rechaza el
  // alta duplicada con 23505 en vez de partirle la identidad al usuario. Cortar acá con un
  // throw le costaría el primer mensaje a alguien que se está dando de alta durante un
  // parpadeo de la base, y no compraría nada que el índice no compre ya.
  //
  // Lo que sí se arregla es la MENTIRA: sin leer el error, ese 23505 salía como
  // "Error creando usuario: duplicate key…", que manda a investigar el alta cuando lo que
  // falló fue la lectura de al lado.
  let errLectura = null;
  {
    const { data, error } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroNorm).maybeSingle();
    if (error) { errLectura = error; log.error({ tag: 'ALTA', err: error.message, numero: numeroNorm }, 'No se pudo buscar al usuario por número normalizado'); }
    if (data) return await persistirBsuid(data, bsuid);
  }
  {
    const { data, error } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroWhatsapp).maybeSingle();
    if (error) { errLectura = errLectura || error; log.error({ tag: 'ALTA', err: error.message }, 'No se pudo buscar al usuario por número sin normalizar'); }
    if (data) {
      // No corta el alta: la fila ya está y se devuelve igual. Sin este log, un usuario que
      // se quedó con el número viejo en la base reintenta esta migración en CADA mensaje y
      // nada lo dice.
      const { error: errNorm } = await supabase.from('usuarios').update({ whatsapp: numeroNorm }).eq('whatsapp', numeroWhatsapp);
      if (errNorm) log.error({ tag: 'ALTA', err: errNorm.message, usuarioId: data.id }, 'No se pudo normalizar el número del usuario');
      data.whatsapp = numeroNorm;
      return await persistirBsuid(data, bsuid);
    }
  }
  // El BSUID va en un UPDATE aparte, no en este INSERT, a propósito: `usuarios_bsuid_key` es
  // único, así que un BSUID ya presente en otra fila haría fallar el INSERT y con él el ALTA
  // entera. Perder la columna es barato; perder al usuario que recién escribe, no.
  const { data: nuevo, error } = await supabase.from('usuarios').insert({ whatsapp: numeroNorm }).select().single();
  if (error) {
    // El 23505 después de una lectura caída NO es un alta duplicada: es el índice único
    // haciendo de red porque no pudimos ver la fila que ya existía. Decirlo cambia a dónde
    // mira el que lee el log.
    if (errLectura && error.code === '23505') {
      // Se interpola tambien `error.message`: el INSERT solo escribe `whatsapp`, asi que hoy el
      // unico unique que puede disparar es `usuarios_whatsapp_key` — pero nombrarlo en prosa y
      // tirar el mensaje real deja el log apuntando al indice equivocado el dia que `usuarios`
      // tenga otro. Lo encontro la revision adversarial.
      throw new Error('No se pudo leer al usuario existente (' + errLectura.message + '); el alta duplicada la frenó un indice unico: ' + error.message);
    }
    throw new Error('Error creando usuario: ' + error.message);
  }
  // Activación: primer contacto / creación de usuario por WhatsApp.
  analytics.capture(nuevo.id, 'wa_user_registered', {
    channel: 'whatsapp',
    $set: { whatsapp: numeroNorm, plan: nuevo.plan || 'free', signup_channel: 'whatsapp' },
  });
  return await persistirBsuid(nuevo, bsuid);
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
  persistirBsuid,
  persistirBsuidConEstado,
  buscarUsuarioPorBsuid,
  getUserPlanConfig,
  getHistoryDateLimit,
};
