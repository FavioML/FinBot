const { supabase } = require('../lib/db');
const { activarPro, rechazarSolicitudPro, reclamarPagoPendiente } = require('../lib/pro-payment');
const { responderTicket, listarTicketsPendientes, cerrarSesion } = require('../lib/support-tickets');
const { esProPagado, enTrial } = require('../lib/trial');
const log = require('../lib/logger');

/**
 * Comandos administrativos compartidos entre canales (WhatsApp y Telegram).
 *
 * El admin recibe las notificaciones de comprobante por Telegram (ver lib/admin-notify),
 * así que debe poder aprobar desde ahí. Esta función centraliza la lógica para que ambos
 * canales se comporten idéntico — evitar divergencia es justo lo que falló antes (el
 * comando /pago solo existía en el webhook de WhatsApp).
 *
 * @param {string} cmd - comando ya normalizado (toLowerCase().trim()).
 * @param {string} [rawText] - texto original SIN normalizar. Necesario para /responder:
 *   el mensaje al usuario debe conservar mayúsculas y acentos (cmd viene en lower).
 *   Por defecto es `cmd` para no romper callers que sólo pasan un argumento.
 * @returns {Promise<string|null>} respuesta para el admin, o null si no es un comando admin.
 *
 * IMPORTANTE: la autorización (¿quién es admin?) la decide el caller, no esta función.
 * Los side effects (update en usuarios, registro de pago, aviso al usuario final por
 * WhatsApp) viven aquí porque son correctos sin importar por qué canal aprobó el admin.
 */
async function procesarComandoAdmin(cmd, rawText = cmd) {
  // /activar <numero_whatsapp> — activa Pro 1 mes (sin link OAuth)
  if (cmd.startsWith('/activar ')) {
    const numeroActivar = cmd.replace('/activar ', '').trim().replace(/\+/g, '');
    const { data: usuarioActivar } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroActivar).single();
    if (!usuarioActivar) {
      return '❌ No encontre un usuario con el numero: ' + numeroActivar;
    }
    // `esProPagado` y no `plan === 'premium'`: durante el trial esa columna vale 'premium'
    // (así los ~40 gates entregan Pro sin tocarse), así que cortar por ella hacía IMPOSIBLE
    // compear a alguien que está probando — justo la población a la que uno le regala un mes
    // para cerrar. El endpoint hermano POST /admin/activar nunca tuvo este chequeo y sí podía.
    // Compear en trial es seguro: activarPro apila el periodo SOBRE `trial_vence` (no lo
    // acorta) y sella `trial_estado: 'convertido'`, que es lo que impide que checkTrialExpiry
    // le baje el plan al vencer la prueba y se evapore el comp.
    if (esProPagado(usuarioActivar)) {
      return '⚠️ ' + (usuarioActivar.nombre || numeroActivar) + ' ya tiene Premium activo.';
    }
    // Activación rápida: 1 mes, sin link OAuth (fuente única en activarPro). Es un comp, igual
    // que POST /admin/activar: `esConversionPagada: false` va explícito (es el default, pero acá
    // decide dos cosas que no se leen solas — no premia al referrer y el pago se registra en S/0).
    const { venceStr } = await activarPro({ usuario: usuarioActivar, tipoPlan: 'mensual', aprobadoPor: 'admin:/activar', enviarLinkGmail: false, esConversionPagada: false });
    return '✅ Premium activado para ' + (usuarioActivar.nombre || numeroActivar) + '\nVence: ' + venceStr;
  }

  // /pago <numero_whatsapp> <mensual|anual> — confirma pago Pro + envía link OAuth
  if (cmd.startsWith('/pago ')) {
    const partes = cmd.replace('/pago ', '').trim().split(/\s+/);
    const numeroPago = (partes[0] || '').replace(/\+/g, '');
    const tipoPlan = partes[1] || 'mensual';
    const { data: usuarioPago } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroPago).single();
    if (!usuarioPago) {
      return '❌ No encontré un usuario con el número: ' + numeroPago;
    }
    await activarPro({ usuario: usuarioPago, tipoPlan, aprobadoPor: 'admin:/pago', enviarLinkGmail: true, esConversionPagada: true });
    return '✅ Pago confirmado para ' + (usuarioPago.nombre || numeroPago) + ' (' + (tipoPlan === 'anual' ? 'anual' : 'mensual') + '). Link OAuth enviado.';
  }

  // /usuarios | /admin | /panel — panel resumen
  if (cmd === '/usuarios' || cmd === '/admin' || cmd === '/panel') {
    // `trial_estado` va en el select porque `esProPagado` la NECESITA para decidir: una
    // fila parcial no puede responder "¿paga?" y devolvería false para todos.
    const { data: todos } = await supabase.from('usuarios').select('whatsapp, nombre, plan, trial_estado, pago_pendiente, estado_pago, created_at').order('created_at', { ascending: false }).limit(20);
    if (!todos || todos.length === 0) return 'No hay usuarios registrados.';
    // `plan === 'premium'` es TRUE durante el trial, así que este panel contaba a quien
    // está probando como Pro pagado y el número de conversión salía inflado (M16).
    const pagados = todos.filter(esProPagado).length;
    const enPrueba = todos.filter(enTrial).length;
    const pendientes = todos.filter(u => u.pago_pendiente).length;
    let msg = '*Panel NETO*\n---------------\n';
    msg += 'Total: ' + todos.length + ' usuarios\n';
    msg += 'Pro pagado: ' + pagados + ' | En prueba: ' + enPrueba + ' | En el muro: ' + (todos.length - pagados - enPrueba) + '\n';
    if (pendientes > 0) msg += '⚠️ Pagos pendientes: ' + pendientes + '\n';
    msg += '\n*Ultimos usuarios:*\n';
    todos.slice(0, 10).forEach(u => {
      // Tres estados, no dos: el ⭐ sobre alguien en prueba hacía leer el panel como si
      // ya hubiera pagado.
      const plan = esProPagado(u) ? '⭐' : (enTrial(u) ? '🎁' : '🔒');
      const pend = u.pago_pendiente ? ' 💸' : '';
      const estado = u.estado_pago === 'pagado' ? '' : (u.estado_pago === 'pendiente' ? ' ⏳' : '');
      msg += plan + ' ' + (u.nombre || u.whatsapp) + pend + estado + '\n';
    });
    msg += '\n_Comandos:_\n/pago <num> <mensual|anual>\n/activar <num>\n/tickets\n/responder <num> <mensaje>\n/cerrar <num>';
    return msg;
  }

  // /responder <numero_whatsapp> <mensaje> — responde un ticket de soporte
  // Usa rawText: el mensaje del admin conserva mayúsculas/acentos (cmd viene en lower).
  if (cmd.startsWith('/responder ')) {
    const resto = String(rawText).trim().substring('/responder '.length).trim();
    const spaceIdx = resto.indexOf(' ');
    if (spaceIdx === -1) {
      return 'Formato: /responder <número> <mensaje>\nEj: /responder 51933014505 Hola, ya revisé tu caso...';
    }
    const numDestino = resto.substring(0, spaceIdx);
    const mensaje = resto.substring(spaceIdx + 1).trim();
    if (!mensaje) {
      return 'Escribe el mensaje. Ej: /responder ' + numDestino.replace(/\+/g, '') + ' Ya revisé tu caso...';
    }
    const r = await responderTicket({ numDestino, mensaje });
    return r.msg;
  }

  // /tickets — lista los tickets de soporte pendientes
  if (cmd === '/tickets' || cmd.startsWith('/tickets ')) {
    return await listarTicketsPendientes();
  }

  // /cerrar <numero_whatsapp> — cierra la conversación de soporte de un usuario y le avisa
  if (cmd.startsWith('/cerrar ')) {
    const numero = cmd.replace('/cerrar ', '').trim().replace(/\+/g, '');
    if (!numero) return 'Formato: /cerrar <número>\nEj: /cerrar 51933014505';
    const r = await cerrarSesion({ whatsapp: numero, avisarUsuario: true });
    return r.msg;
  }

  return null;
}

/**
 * Resuelve la solicitud Pro y su usuario ANTES de tocar el estado del pago.
 *
 * **El orden es el arreglo.** El claim de `reclamarPagoPendiente` es atómico y NO repetible:
 * una vez que la fila pasa a `aprobado`, el reintento del botón contesta "Ya procesado" y no
 * vuelve a activar nada. Así que todo lo que pueda fallar tiene que fallar ANTES del claim.
 *
 * Acá vivía el agujero: la lectura del usuario iba DESPUÉS del claim y descartaba su `error`,
 * así que una lectura caída se leía como "Usuario no encontrado" — con el pago ya marcado
 * aprobado, `activarPro` sin correr, y la persona pagando y quedándose en Free. Leer el error
 * ahí habría cambiado la mentira por un error honesto, pero el pago quedaba trabado igual: lo
 * que lo destraba es mover el claim, no mirar el error de donde estaba.
 *
 * Es el mismo diagnóstico que `pro-payment.js` cerró para la lectura de `pagos`: se blindó una
 * y el agujero se mudó a la de al lado. La lección que queda escrita es esa, no el parche.
 *
 * `maybeSingle` y no `single`: con cero filas `single` devuelve PGRST116 en `error`, y un
 * `if (error)` a secas convertiría "ese pago no existe" en un fallo de infraestructura.
 *
 * @returns {Promise<{pago:object,usuario:object}|{answer:string}>}
 */
async function resolverSolicitudPro(pagoId) {
  const { data: pago, error: errPago } = await supabase.from('pagos')
    .select('id, estado, usuario_id').eq('id', pagoId).maybeSingle();
  if (errPago) {
    log.error({ tag: 'ADMIN_CB', err: errPago.message, pagoId }, 'No se pudo leer la solicitud');
    return { answer: 'No pude leer la solicitud. Reintenta el botón.' };
  }
  if (!pago) return { answer: 'Solicitud no encontrada' };
  if (pago.estado !== 'pendiente') return { answer: 'Ya procesado (' + pago.estado + ')' };
  const { data: usuario, error: errUsuario } = await supabase.from('usuarios')
    .select('*').eq('id', pago.usuario_id).maybeSingle();
  if (errUsuario) {
    log.error({ tag: 'ADMIN_CB', err: errUsuario.message, pagoId, usuarioId: pago.usuario_id }, 'No se pudo leer el usuario de la solicitud');
    return { answer: 'No pude leer el usuario. Reintenta el botón.' };
  }
  if (!usuario) return { answer: 'Usuario no encontrado' };
  return { pago, usuario };
}

/**
 * Relee el estado tras perder el claim. Un fallo de lectura acá NO puede volver a decir
 * "Solicitud no encontrada": la fila estaba viva y pendiente dos líneas antes.
 */
async function estadoTrasPerderClaim(pagoId) {
  const { data: ex, error } = await supabase.from('pagos').select('estado').eq('id', pagoId).maybeSingle();
  if (error) {
    log.error({ tag: 'ADMIN_CB', err: error.message, pagoId }, 'No se pudo releer el estado tras perder el claim');
    return 'Ya procesado (no pude leer el estado final)';
  }
  return ex ? 'Ya procesado (' + ex.estado + ')' : 'Solicitud no encontrada';
}

/**
 * Procesa un tap de botón inline de Telegram (callback_query) sobre una solicitud Pro.
 * Formatos de `data`: `pro:approve:mensual:<pagoId>` | `pro:approve:anual:<pagoId>` | `pro:reject:<pagoId>`.
 *
 * Idempotente: si el pago ya no está `pendiente`, no re-actúa (evita doble-tap).
 * La autorización (chat del admin) la valida el caller, igual que procesarComandoAdmin.
 *
 * @param {string} data - callback_data.
 * @returns {Promise<{answer:string, edit?:string}|null>} null si no es un callback Pro.
 */
async function procesarCallbackAdmin(data) {
  const raw = String(data || '');
  if (!raw.startsWith('pro:')) return null;
  const parts = raw.split(':'); // ['pro', accion, ...]
  const accion = parts[1];
  try {
    if (accion === 'approve') {
      const tipoPlan = parts[2] === 'anual' ? 'anual' : 'mensual';
      const pagoId = parts[3];
      // Todo lo que puede fallar, falla antes del claim. Ver `resolverSolicitudPro`.
      const resuelto = await resolverSolicitudPro(pagoId);
      if (resuelto.answer) return { answer: resuelto.answer };
      const usuario = resuelto.usuario;
      // Claim atómico: solo un tap gana la fila. Un segundo tap / reintento del callback
      // recibe null y no re-activa (antes se apilaba un mes extra + fila duplicada).
      // `reclamarPagoPendiente` LANZA a propósito cuando no puede distinguir "otro tap ganó" de
      // un fallo de infraestructura (`lib/pro-payment.js`), y ese throw caía en el catch genérico:
      // el admin leía "Error procesando" sin ninguna de las dos indicaciones. Acá no se reclamó
      // nada, así que el botón sirve.
      let claimed;
      try {
        claimed = await reclamarPagoPendiente({ pagoId, aprobadoPor: 'admin:telegram' });
      } catch (e) {
        log.error({ tag: 'ADMIN_CB', err: e.message, pagoId }, 'Falló el claim del pago');
        return { answer: 'No pude reclamar la solicitud. Reintenta el botón.' };
      }
      if (!claimed) return { answer: await estadoTrasPerderClaim(pagoId) };
      let venceStr;
      try {
        ({ venceStr } = await activarPro({ usuario, tipoPlan, aprobadoPor: 'admin:telegram', pagoId: claimed.id, esConversionPagada: true }));
      } catch (e) {
        log.error({ tag: 'ADMIN_CB', err: e.message, pagoId, usuarioId: usuario.id }, 'Pago aprobado pero Pro no se activó');
        // **No se puede prescribir la recuperación a ciegas, y la primera versión de esto lo
        // hacía mal en las dos mitades.** Decía "la fila quedó en aprobado, corre /activar", y
        // las dos afirmaciones son falsas para el fallo dominante:
        //
        //  · `activarPro` DEVUELVE el pago a `pendiente` cuando falla su escritura crítica
        //    (`lib/pro-payment.js`), y si ni el rollback entra avisa al admin por su cuenta. O sea
        //    que casi siempre alcanza con volver a tocar Aprobar.
        //  · `/activar` es el camino de CORTESÍA: registra el pago en **S/0** (`cajaDelMes` suma
        //    esa columna), no le paga el mes al referrer y le manda al usuario el copy de
        //    "sin costo" habiendo pagado. Mandar ahí a alguien que transfirió S/10 sub-registra
        //    ingreso — la misma clase de B10, indicada por el mensaje de error.
        //
        // Así que se LEE en qué estado quedó y se dice eso.
        const { data: tras, error: errTras } = await supabase.from('pagos').select('estado').eq('id', pagoId).maybeSingle();
        // **TRES ramas, no dos.** La primera versión mandaba el fallo de LECTURA al mensaje que
        // afirma "NO volvió a pendiente" — o sea aseguraba un estado que no pudo leer, que es
        // exactamente la falacia que `estadoTrasPerderClaim` evita cincuenta líneas más arriba,
        // en este mismo commit. Y muerde justo cuando más importa: el mismo hipo de red tumba la
        // escritura de `activarPro` (que sí revierte) y la relectura, y el admin termina metiendo
        // SQL a mano sobre `pagos` — la causa acotada del incidente del 2026-08-01.
        if (errTras) {
          return { answer: '⚠️ No se activó Pro y no pude leer cómo quedó la solicitud. Revisa la fila — NO uses /activar (registra S/0).' };
        }
        if (tras && tras.estado === 'pendiente') {
          return { answer: '⚠️ No se activó Pro. La solicitud volvió a pendiente: toca Aprobar otra vez.' };
        }
        return { answer: '⚠️ No se activó Pro y la solicitud NO volvió a pendiente. Revisar a mano — NO uses /activar (registra S/0).' };
      }
      return { answer: 'Aprobado ✅', edit: '✅ Aprobado (' + tipoPlan + ') — ' + (usuario.nombre || usuario.whatsapp) + '\nVence: ' + venceStr };
    }
    if (accion === 'reject') {
      const pagoId = parts[2];
      // Mismo orden que en approve, y por el mismo motivo: el rechazo también es un claim que no
      // se repite, y con la lectura del usuario después, un fallo dejaba la solicitud en
      // `rechazado` sin que `rechazarSolicitudPro` corriera — o sea sin que nadie le avisara nada
      // a quien pagó, y con el reintento contestando "Ya procesado".
      const resuelto = await resolverSolicitudPro(pagoId);
      if (resuelto.answer) return { answer: resuelto.answer };
      const usuario = resuelto.usuario;
      // Claim atómico también en rechazo: evita doble mensaje "no pudimos validar" por doble-tap.
      // Lee su `error`: sin eso, un rechazo de la DB es indistinguible de "otro tap ganó la fila"
      // y el admin veía "Ya procesado" sobre un pago que seguía pendiente. Es el mismo par de
      // síntomas que `reclamarPagoPendiente` documenta para la aprobación.
      const { data: claimed, error: errClaimRechazo } = await supabase.from('pagos')
        .update({ estado: 'rechazado' }).eq('id', pagoId).eq('estado', 'pendiente').select('usuario_id').maybeSingle();
      if (errClaimRechazo) {
        log.error({ tag: 'ADMIN_CB', err: errClaimRechazo.message, pagoId }, 'Falló el claim del rechazo');
        return { answer: 'No pude rechazarlo. Reintenta el botón.' };
      }
      if (!claimed) return { answer: await estadoTrasPerderClaim(pagoId) };
      const resRechazo = await rechazarSolicitudPro({ pagoId, usuario, motivo: 'No pudimos validar el comprobante.' });
      // El rechazo puede completarse dejando al usuario TRABADO: si no se pudo limpiar
      // `pago_pendiente`, no va a poder reenviar comprobante por ningún canal y el claim no se
      // vuelve a ganar nunca (ver `rechazarSolicitudPro`). Contestar 'Rechazado' a secas sería
      // afirmar que quedó cerrado algo que dejó a alguien sin poder pagar. El `edit` también lo
      // dice: es lo que queda escrito en el chat cuando el popup ya no está.
      //
      // La comparación es explícita contra `false` y no `!resRechazo.claimLimpio` a propósito:
      // los tests que mockean esta función devuelven `undefined`, y un `!undefined` los haría
      // gritar sobre rechazos sanos.
      if (resRechazo && resRechazo.claimLimpio === false) {
        return {
          answer: '⚠️ Rechazado, pero quedó trabado: pon `pago_pendiente` en false a mano o no podrá volver a pagar.',
          edit: '❌ Rechazado — ' + (usuario.nombre || usuario.whatsapp) + '\n⚠️ pago_pendiente quedó trabado: límpialo a mano.',
        };
      }
      return { answer: 'Rechazado', edit: '❌ Rechazado — ' + (usuario.nombre || usuario.whatsapp) };
    }
    return { answer: 'Acción no reconocida' };
  } catch (e) {
    log.error({ tag: 'ADMIN_CB', err: e.message }, 'Error procesando callback admin');
    return { answer: 'Error procesando' };
  }
}

module.exports = { procesarComandoAdmin, procesarCallbackAdmin };
