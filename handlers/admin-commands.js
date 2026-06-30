const { supabase } = require('../lib/db');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { registrarPagoAprobado } = require('../lib/pro-payment');
const { generarUrlAutorizacion } = require('../gmail');

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
    const hoy = new Date();
    const vence = new Date(hoy.getFullYear(), hoy.getMonth() + 1, hoy.getDate()).toISOString().split('T')[0];
    const desde = hoy.toISOString().split('T')[0];
    await supabase.from('usuarios').update({
      plan: 'premium',
      pago_pendiente: false,
      esperando_comprobante: false,
      premium_desde: desde,
      premium_vence: vence
    }).eq('id', usuarioActivar.id);
    await registrarPagoAprobado(usuarioActivar.id, { tipoPlan: usuarioActivar.tipo_plan || 'mensual', premiumDesde: desde, premiumVence: vence, aprobadoPor: 'admin:/activar' });
    await enviarWhatsapp(usuarioActivar.whatsapp,
      '⭐ *¡Bienvenido a NETO Pro!*\n\n' +
      'Tu pago fue confirmado. Ya tienes acceso completo.\n\n' +
      'Registra gastos así:\n' +
      '📝 _"gasté 50 en taxi"_\n' +
      '📸 Envía una foto de Yape o Plin\n\n' +
      '📊 Configura tus presupuestos en tu dashboard:\nhttps://app.neto.pe/dashboard/presupuestos\n\n' +
      '¿Por dónde empezamos?'
    );
    return '✅ Premium activado para ' + (usuarioActivar.nombre || numeroActivar) + '\nVence: ' + vence;
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
    const hoy = new Date();
    const mesesAdd = tipoPlan === 'anual' ? 12 : 1;
    const vence = new Date(hoy.getFullYear(), hoy.getMonth() + mesesAdd, hoy.getDate());
    const desdePago = hoy.toISOString().split('T')[0];
    const vencePago = vence.toISOString().split('T')[0];
    await supabase.from('usuarios').update({
      plan: 'premium',
      estado_pago: 'pagado',
      tipo_plan: tipoPlan,
      fecha_pago: hoy.toISOString(),
      fecha_vencimiento: vence.toISOString(),
      premium_desde: desdePago,
      premium_vence: vencePago,
      pago_pendiente: false,
      esperando_comprobante: false,
      onboarding_paso: 0
    }).eq('id', usuarioPago.id);
    await registrarPagoAprobado(usuarioPago.id, { tipoPlan, premiumDesde: desdePago, premiumVence: vencePago, aprobadoPor: 'admin:/pago' });
    const urlOAuth = generarUrlAutorizacion(usuarioPago.whatsapp);
    await enviarWhatsapp(usuarioPago.whatsapp,
      '✅ *¡Pago confirmado!*\n\n' +
      'Plan: *' + (tipoPlan === 'anual' ? 'Anual (S/99/año)' : 'Mensual (S/10/mes)') + '*\n' +
      'Vence: ' + vence.toISOString().split('T')[0] + '\n\n' +
      'Conecta tu Gmail para que Neto lea tus correos bancarios automáticamente:\n\n' +
      '🔗 ' + urlOAuth + '\n\n' +
      '_Solo leemos notificaciones bancarias. Sin contraseñas bancarias._'
    );
    return '✅ Pago confirmado para ' + (usuarioPago.nombre || numeroPago) + ' (' + tipoPlan + '). Link OAuth enviado.';
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

module.exports = { procesarComandoAdmin };
