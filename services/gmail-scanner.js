const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { registrarError } = require('../lib/error-monitor');
const { notificarErrorAdmin } = require('../lib/admin-notify');
const { hoyPeru } = require('../lib/dates');
const { leerCorreosBancarios } = require('../gmail');
const { parsearCorreoBancario } = require('./parsers');
const { guardarTransaccion } = require('./transactions');
const { obtenerCategoriasUsuario } = require('./categories');
const { esProPagado, linkPanelPro } = require('../lib/trial');
const { notificarUsuario, CANALES } = require('../lib/notify-user');

// Lazy-loaded to avoid circular dependency
let _enviarAlertaTransaccion = null;
function getEnviarAlertaTransaccion() {
  if (!_enviarAlertaTransaccion) {
    _enviarAlertaTransaccion = require('./notifications').enviarAlertaTransaccion;
  }
  return _enviarAlertaTransaccion;
}

// Throttle de notificaciones de auth expirada: máx 1 vez cada 24h por usuario
const authErrorNotifiedAt = new Map();

// Pool de concurrencia simple (sin dependencia externa). Corre `fn` sobre `items`
// con a lo más `concurrency` en vuelo a la vez. JS es single-thread: los contadores
// que mutan las tareas (registradas/ignoradas/resumen) son seguros entre awaits.
async function mapPool(items, concurrency, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));
}

// Cuántos correos parsear en paralelo por sweep. Cada correo hace SELECT dedup +
// 1 llamada GPT-4o-mini + insert; en serie, 100 correos ≈ 100s. Con 5 en vuelo el
// wall-clock cae ~5x sin subir el número de llamadas OpenAI.
const CONCURRENCIA_SWEEP = 5;

async function notificarAuthExpirada(usuario) {
  const last = authErrorNotifiedAt.get(usuario.id) || 0;
  if (Date.now() - last < 24 * 60 * 60 * 1000) return; // ya notificado hoy
  authErrorNotifiedAt.set(usuario.id, Date.now());
  log.warn({ tag: 'AUTH', usuarioId: usuario.id }, 'Gmail desconectado — notificando usuario');
  // Por los dos canales: se rompió la ingesta automática, o sea que el usuario va a dejar
  // de ver gastos sin haber hecho nada. Un aviso que solo vive en WhatsApp no llega a quien
  // justamente confió en que Neto anotaba solo y por eso no escribe hace días.
  // Reconectar es web-only, así que el aviso lleva el enlace en vez de pedir un comando de
  // WhatsApp que ya no conecta nada. El deeplink in-app también cambió: /dashboard/configuracion
  // no tiene una sola línea de Gmail, o sea que el aviso aterrizaba en una pantalla sin botón.
  const linkReconectar = linkPanelPro(usuario);
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id,
    whatsapp: usuario.whatsapp || null,
    tipo: 'gmail_auth_expirada',
    mensaje: '⚠️ *Tu Gmail se desconectó*\n\n' +
      'Neto ya no puede leer tus correos bancarios para registrar tus gastos automáticamente.\n\n' +
      (linkReconectar ? 'Reconéctalo acá y todo vuelve a funcionar:\n' + linkReconectar : 'Reconéctalo desde tu app para que todo vuelva a funcionar.'),
    titulo: 'Tu Gmail se desconectó',
    cuerpo: 'Neto ya no puede leer tus correos bancarios. Reconéctalo para que todo vuelva a funcionar.',
    tipoInApp: 'alerta',
    link: '/dashboard/pro',
  });
}

// opts:
//   scanOpts      → ventana/caps del scan (se pasa tal cual a leerCorreosBancarios)
//   enviarAlertas → si false, NO manda la tarjeta WhatsApp por transacción (para el
//                   barrido histórico, donde 30 días = decenas de correos y sería spam)
//   historico     → cambia el mensaje de resumen final
async function escanearGmailYRegistrar(usuario, opts = {}) {
  const { scanOpts = {}, enviarAlertas = true, historico = false } = opts;
  const { error, mensajes } = await leerCorreosBancarios(usuario.id, scanOpts);
  if (error === 'no_auth') return null;
  if (error === 'AUTH_EXPIRED') return { authError: true };
  if (!mensajes.length) return null;
  let registradas = 0; let ignoradas = 0; let resumen = '';
  // Fetch categorías custom una sola vez por batch (no por correo)
  let categoriasCustom = null;
  try { categoriasCustom = await obtenerCategoriasUsuario(usuario.id); }
  catch(e) { log.warn({ tag: 'CATS', err: e.message }, 'No se pudieron cargar categorías custom'); }
  // Procesa hasta CONCURRENCIA_SWEEP correos en paralelo (P1: antes era serial, 30d
  // podía tomar ~100s). Cada correo es independiente (distinto msg.id); el pool no
  // introduce race porque el insert va protegido por el índice único de gmail_msg_id.
  await mapPool(mensajes, CONCURRENCIA_SWEEP, async function(msg) {
    try {
      const textoParseo = msg.texto || msg.snippet;
      const claveDedup = msg.id;
      // Pre-check barato por descripcion_original: evita gastar una llamada OpenAI en un
      // correo ya registrado (cubre también filas viejas sin gmail_msg_id). NO es la
      // garantía contra la race de doble barrido — esa la da el índice único parcial
      // (usuario_id, gmail_msg_id) que atrapa dos inserts concurrentes del mismo correo.
      const { data: existente } = await supabase.from('transacciones').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).single();
      if (existente) { ignoradas++; return; }
      const { data: excluido } = await supabase.from('gmail_excluidos').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).single();
      if (excluido) { ignoradas++; return; }
      const resultado = await parsearCorreoBancario(textoParseo, msg.asunto, categoriasCustom);
      if (!resultado.monto) return;
      // esGmail: true → guardarTransaccion salta su dedup de ventana (10s) y el conteo de
      // activación. gmail_msg_id → clave del índice único que cierra la race de doble barrido
      // (sweep 30d + cron 15min solapados) sin poder poner unique sobre descripcion_original.
      // dedupAvisoGmail: solo en el escaneo incremental. En el barrido histórico dos compras
      // legítimas del mismo día se procesan con segundos de diferencia y colapsarían mal.
      const txGuardada = await guardarTransaccion(usuario.id, { ...resultado, fecha: msg.fecha || resultado.fecha, descripcion_original: claveDedup, gmail_msg_id: claveDedup, esGmail: true, dedupAvisoGmail: !historico, recibidoEnMs: msg.recibidoEnMs });
      if (!txGuardada) { ignoradas++; return; } // segundo aviso del mismo cargo
      registradas++;
      resumen += '- ' + (resultado.tipo === 'ingreso' ? 'Ingreso' : 'Gasto') + ': ' + (resultado.comercio || resultado.banco || 'Sin nombre') + ' S/ ' + resultado.monto + '\n';
      // En el barrido histórico se registran en silencio: nada de una tarjeta por correo.
      if (enviarAlertas) {
        setTimeout(async function() {
          try { await getEnviarAlertaTransaccion()(usuario, txGuardada, resultado); } catch(e) { log.error({ tag: 'ALERTA', err: e.message }, 'Error alerta transacción'); }
        }, 5000);
      }
      // El premio de referidos ya NO se dispara por uso (correos): el modelo dos-lados
      // premia al referrer recién cuando el referido PAGA Pro (ver lib/pro-payment:activarPro).
    } catch (e) { log.error({ tag: 'CORREO', err: e.message }, 'Error procesando correo'); registrarError('CORREO', e.message, { stack: e.stack, usuarioId: usuario.id }); }
  });
  if (registradas === 0) {
    if (historico) return null;
    if (ignoradas > 0) return '*Sin correos nuevos*\n\n' + ignoradas + ' correo(s) ya estaban registrados.';
    return null;
  }
  if (historico) {
    // Un solo mensaje de resumen (sin volcar la lista completa: pueden ser decenas).
    return '\uD83D\uDCE5 *\u00A1Listo! Import\u00E9 tus \u00FAltimos 30 d\u00EDas*\n\n' + registradas + ' movimiento(s) agregados a tu dashboard.\n\n\uD83D\uDC49 M\u00EDralos en https://app.neto.pe';
  }
  return '\uD83D\uDCEC Revise tu Gmail \u2014 *' + registradas + ' movimiento(s) nuevo(s)*:\n\n' + resumen + '\n\u00bfLo revisamos?';
}

// Ventana y caps del barrido hist\u00F3rico \u00FAnico (30 d\u00EDas). Caps altos para poblar el
// dashboard pero acotados para no golpear la cuota de Gmail (~2 list + hasta 100 get).
const HISTORICO_SCAN_OPTS = { windowDays: 30, filterDays: 30, maxPerQuery: 100, maxProcess: 50 };

// Barrido hist\u00F3rico \u00FAnico tras la primera conexi\u00F3n de Gmail. Registra en silencio los
// movimientos de los \u00FAltimos 30 d\u00EDas y marca usuarios.historico_importado para no repetir.
async function escanearHistoricoInicial(usuario) {
  if (usuario.historico_importado) return null;
  // Claim at\u00F3mico: pone historico_importado=true SOLO si estaba false y solo si esta ejecuci\u00F3n
  // gana la fila corremos el barrido. Un segundo callback OAuth concurrente (Google reintenta /
  // doble click) recibe null y no duplica los 30 d\u00EDas. Reservamos ANTES del scan; si la auth
  // falla, liberamos para que el usuario pueda reconectar y a\u00FAn merecer el barrido.
  const { data: claim } = await supabase.from('usuarios')
    .update({ historico_importado: true })
    .eq('id', usuario.id).eq('historico_importado', false)
    .select('id').maybeSingle();
  if (!claim) { log.info({ tag: 'HIST', usuarioId: usuario.id }, 'Barrido hist\u00F3rico ya reclamado, skip'); return null; }
  usuario.historico_importado = true;
  log.info({ tag: 'HIST', usuarioId: usuario.id }, 'Barrido hist\u00F3rico 30d iniciado');
  const resultado = await escanearGmailYRegistrar(usuario, {
    scanOpts: HISTORICO_SCAN_OPTS,
    enviarAlertas: false,
    historico: true,
  });
  if (resultado && resultado.authError) {
    await supabase.from('usuarios').update({ historico_importado: false }).eq('id', usuario.id);
    usuario.historico_importado = false;
    return resultado;
  }
  log.info({ tag: 'HIST', usuarioId: usuario.id }, 'Barrido hist\u00F3rico 30d completado');
  return resultado;
}

async function escaneoAutomatico() {
  log.info({ tag: 'AUTO' }, 'Escaneo automático iniciado');
  try {
    // Bug fix: incluir usuarios con token legacy Y usuarios con cuentas en gmail_cuentas
    const [{ data: usuariosLegacy }, { data: cuentasGmail }] = await Promise.all([
      supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null),
      supabase.from('gmail_cuentas').select('usuario_id').eq('activa', true),
    ]);

    const idsLegacy = new Set((usuariosLegacy || []).map(u => u.id));
    const idsSoloNuevos = [...new Set((cuentasGmail || []).map(c => c.usuario_id))].filter(id => !idsLegacy.has(id));

    let todosLosUsuarios = usuariosLegacy || [];
    if (idsSoloNuevos.length > 0) {
      const { data: usuariosNuevos } = await supabase.from('usuarios').select('*').in('id', idsSoloNuevos);
      todosLosUsuarios = [...todosLosUsuarios, ...(usuariosNuevos || [])];
    }

    if (!todosLosUsuarios.length) return;
    for (const usuario of todosLosUsuarios) {
      try {
        // La LECTURA sigue al mismo predicado que la conexión: si conectar Gmail exige Pro
        // pagado, leer también. El gate viejo era por plan, y durante el trial `plan` vale
        // 'premium' — o sea que a un usuario en prueba con una cuenta heredada (de antes del
        // gate, o de una baja que el barrido todavía no alcanzó) se le seguían leyendo los
        // correos del banco. Es la mitad silenciosa de la misma capability.
        if (!esProPagado(usuario)) continue;
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado && resultado.authError) {
          // Gmail desconectado — notificar al usuario (máx 1 vez/24h)
          await notificarAuthExpirada(usuario);
        } else if (resultado && typeof resultado === 'string' && resultado.includes('movimiento')) {
          await notificarUsuario({
            canales: CANALES.SOLO_IN_APP,
            motivo: 'un WhatsApp de resumen del escaneo era ruido: cada transacción detectada ya manda su propia tarjeta "Nuevo gasto" (enviarAlertaTransaccion, gateada por usuario.alertas_transaccion)',
            usuarioId: usuario.id,
            tipo: 'gmail_escaneo',
            titulo: 'Escaneo de correo completado',
            cuerpo: 'Se detectaron nuevos movimientos en tu correo bancario',
            link: '/dashboard/transacciones',
          });
        }
      } catch (e) { log.error({ tag: 'AUTO', whatsapp: usuario.whatsapp, err: e.message }, 'Error escaneo usuario'); }
    }
  } catch (e) { log.error({ tag: 'AUTO', err: e.message }, 'Error general escaneo'); notificarErrorAdmin('AUTO_SCAN', e.message); registrarError('AUTO_SCAN', e.message, { stack: e.stack }); }
}

module.exports = { escanearGmailYRegistrar, escaneoAutomatico, escanearHistoricoInicial };
