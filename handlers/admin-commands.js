const { supabase } = require('../lib/db');
const { activarPro, rechazarSolicitudPro, reclamarPagoPendiente } = require('../lib/pro-payment');
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
 * @returns {Promise<string|null>} respuesta para el admin, o null si no es un comando admin.
 *
 * IMPORTANTE: la autorización (¿quién es admin?) la decide el caller, no esta función.
 * Los side effects (update en usuarios, registro de pago, aviso al usuario final por
 * WhatsApp) viven aquí porque son correctos sin importar por qué canal aprobó el admin.
 */
async function procesarComandoAdmin(cmd) {
  // /activar <numero_whatsapp> — activa Pro 1 mes (sin link OAuth)
  if (cmd.startsWith('/activar ')) {
    const numeroActivar = cmd.replace('/activar ', '').trim().replace(/\+/g, '');
    const { data: usuarioActivar } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroActivar).single();
    if (!usuarioActivar) {
      return '❌ No encontre un usuario con el numero: ' + numeroActivar;
    }
    if (usuarioActivar.plan === 'premium') {
      return '⚠️ ' + (usuarioActivar.nombre || numeroActivar) + ' ya tiene Premium activo.';
    }
    // Activación rápida: 1 mes, sin link OAuth (fuente única en activarPro).
    const { venceStr } = await activarPro({ usuario: usuarioActivar, tipoPlan: 'mensual', aprobadoPor: 'admin:/activar', enviarOAuth: false });
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
    await activarPro({ usuario: usuarioPago, tipoPlan, aprobadoPor: 'admin:/pago', enviarOAuth: true, resetOnboarding: true });
    return '✅ Pago confirmado para ' + (usuarioPago.nombre || numeroPago) + ' (' + (tipoPlan === 'anual' ? 'anual' : 'mensual') + '). Link OAuth enviado.';
  }

  // /usuarios | /admin | /panel — panel resumen
  if (cmd === '/usuarios' || cmd === '/admin' || cmd === '/panel') {
    const { data: todos } = await supabase.from('usuarios').select('whatsapp, nombre, plan, pago_pendiente, estado_pago, created_at').order('created_at', { ascending: false }).limit(20);
    if (!todos || todos.length === 0) return 'No hay usuarios registrados.';
    const premium = todos.filter(u => u.plan === 'premium').length;
    const pendientes = todos.filter(u => u.pago_pendiente).length;
    let msg = '*Panel NETO*\n---------------\n';
    msg += 'Total: ' + todos.length + ' usuarios\n';
    msg += 'Premium: ' + premium + ' | Free: ' + (todos.length - premium) + '\n';
    if (pendientes > 0) msg += '⚠️ Pagos pendientes: ' + pendientes + '\n';
    msg += '\n*Ultimos usuarios:*\n';
    todos.slice(0, 10).forEach(u => {
      const plan = u.plan === 'premium' ? '⭐' : '🟢';
      const pend = u.pago_pendiente ? ' 💸' : '';
      const estado = u.estado_pago === 'pagado' ? '' : (u.estado_pago === 'pendiente' ? ' ⏳' : '');
      msg += plan + ' ' + (u.nombre || u.whatsapp) + pend + estado + '\n';
    });
    msg += '\n_Comandos:_\n/pago <num> <mensual|anual>\n/activar <num>';
    return msg;
  }

  return null;
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
      // Claim atómico: solo un tap gana la fila. Un segundo tap / reintento del callback
      // recibe null y no re-activa (antes se apilaba un mes extra + fila duplicada).
      const claimed = await reclamarPagoPendiente({ pagoId, aprobadoPor: 'admin:telegram' });
      if (!claimed) {
        const { data: ex } = await supabase.from('pagos').select('estado').eq('id', pagoId).maybeSingle();
        return { answer: ex ? 'Ya procesado (' + ex.estado + ')' : 'Solicitud no encontrada' };
      }
      const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', claimed.usuario_id).single();
      if (!usuario) return { answer: 'Usuario no encontrado' };
      const { venceStr } = await activarPro({ usuario, tipoPlan, aprobadoPor: 'admin:telegram', pagoId: claimed.id });
      return { answer: 'Aprobado ✅', edit: '✅ Aprobado (' + tipoPlan + ') — ' + (usuario.nombre || usuario.whatsapp) + '\nVence: ' + venceStr };
    }
    if (accion === 'reject') {
      const pagoId = parts[2];
      // Claim atómico también en rechazo: evita doble mensaje "no pudimos validar" por doble-tap.
      const { data: claimed } = await supabase.from('pagos')
        .update({ estado: 'rechazado' }).eq('id', pagoId).eq('estado', 'pendiente').select('usuario_id').maybeSingle();
      if (!claimed) {
        const { data: ex } = await supabase.from('pagos').select('estado').eq('id', pagoId).maybeSingle();
        return { answer: ex ? 'Ya procesado (' + ex.estado + ')' : 'Solicitud no encontrada' };
      }
      const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', claimed.usuario_id).single();
      if (!usuario) return { answer: 'Usuario no encontrado' };
      await rechazarSolicitudPro({ pagoId, usuario, motivo: 'No pudimos validar el comprobante.' });
      return { answer: 'Rechazado', edit: '❌ Rechazado — ' + (usuario.nombre || usuario.whatsapp) };
    }
    return { answer: 'Acción no reconocida' };
  } catch (e) {
    log.error({ tag: 'ADMIN_CB', err: e.message }, 'Error procesando callback admin');
    return { answer: 'Error procesando' };
  }
}

module.exports = { procesarComandoAdmin, procesarCallbackAdmin };
