// Maquina de estados del onboarding (alta de usuarios) de Neto por WhatsApp.
//
// Extraida de handlers/webhook.js para aislar el flujo mas critico del producto
// (el alta) de la cascada de despacho de comandos. El estado vive en la columna
// usuarios.onboarding_paso; los valores en uso son: -1 (desconexion/wipe),
// 0 (idle/completado), 1 (elige Free/Pro), 2 (elige plan / espera comprobante),
// 10 (categorias), 20 (presupuesto opcional), 30 (elige bancos al conectar Gmail),
// 31 (edita bancos con /bancos), 100 (pide nombre).
// El marcador de "alta completa" es la columna booleana onboarding_completado,
// no un valor de paso: al terminar, onboarding_paso vuelve a 0.
//
// El alta termina en el paso 100: nombre (salteable) y listo. Los pasos 1 y 2
// (Free/Pro y comprobante) siguen vivos porque los usa /premium y el flujo de
// pago Yape, pero el alta ya NO enruta hacia ellos. El paso 101 (email) se
// retiro: era el punto de fuga mas caro y su unica razon de ser era vincular la
// cuenta web, cosa que ahora resuelve el link firmado de lib/activacion.js.
//
// Contrato: manejarOnboarding devuelve el texto a enviar si el mensaje pertenece
// al alta, o null si no (para que webhook.js siga a su cascada de comandos y NLP).
// Los efectos de DB (updates a usuarios, deletes del wipe) y analytics ocurren
// aqui dentro; el envio por WhatsApp lo hace webhook con el string devuelto.
//
// Precedencia (identica a la del webhook original): primero las guardas por
// onboarding_paso (solo cuando el mensaje NO es un /comando — un "/x" siempre
// escapa la maquina de estados), y solo si ninguna aplica, los triggers de
// entrada (hola / usuario nuevo / /manual). Un "hola" de usuario ya onboardeado
// NO es alta: devuelve null y webhook maneja el saludo normal.

const { supabase } = require('../lib/db');
const { CATEGORIAS_SUGERIDAS } = require('../lib/constants');
const { parsearIndicesRespuesta } = require('../lib/formatters');
const { obtenerCuentasGmail, generarUrlAutorizacion, BANCOS_CATALOGO, describirSeleccion } = require('../gmail');
const { crearCategoriasDesdeIndices } = require('../services/categories');
const { interpretarComandoPresupuesto } = require('../services/parsers');
const { guardarPresupuesto } = require('../services/budget');
const analytics = require('../lib/analytics');

const REPROMPT_BANCOS = 'No entendí. 🤔\n\nResponde con los números de tus bancos separados por coma (ej: *1,3,5*) o escribe *todos*.';

// Telemetría del alta. Hasta ahora solo se capturaba el inicio (wa_user_registered)
// y el final (wa_onboarding_completed), así que los pasos intermedios — donde se cae
// la mayor parte de la gente — solo se podían mirar a mano con SQL. Estos dos eventos
// cierran el embudo en PostHog.
//
// NUNCA mandar el contenido del mensaje: el motivo y el paso alcanzan para
// diagnosticar, y el texto literal ya queda en `conversaciones`.
function stepOk(usuario, paso, siguiente, via) {
  const props = { paso, siguiente };
  if (via) props.via = via;
  analytics.capture(usuario.id, 'wa_onboarding_step_ok', props);
}
function stepFailed(usuario, paso, motivo) {
  analytics.capture(usuario.id, 'wa_onboarding_step_failed', { paso, motivo });
}

// ─── Alta reordenada: el valor antes que la identidad ────────────────────────
// El alta pedía nombre → email → plan y recién ahí dejaba registrar un gasto.
// 21 de 82 usuarios se caían antes de haber usado Neto una sola vez. Ahora lo
// único previo es el nombre (y es salteable); todo lo demás — vincular la cuenta
// web, elegir plan — pasa después, cuando la persona ya vio para qué sirve esto.

// ¿El mensaje trae un monto? Un nombre no lleva números. Es el mismo regex de
// salvarGastoSinIA (message-processor.js): barato, local y determinista — un
// discriminador NO puede costar una llamada a OpenAI en cada nombre que entra.
function pareceTransaccion(msg) {
  const texto = (msg || '').trim();
  if (/(\d+(?:[.,]\d{1,2})?)/.test(texto)) return true;
  return /\b(gast[eé]|pagu[eé]|compr[eé]|almuerzo|taxi|soles?|s\/)\b/i.test(texto);
}

function esSkipNombre(cmd) {
  return /^(saltar|omitir|luego|despu[eé]s|paso|skip|no|prefiero no|nada)$/i.test((cmd || '').trim());
}

// Cierra el alta. El marcador real es onboarding_completado; onboarding_paso
// vuelve a 0. `via` alimenta el embudo de PostHog.
async function completarAlta(usuario, via) {
  await supabase.from('usuarios').update({ onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
  stepOk(usuario, 100, 0, via);
  analytics.capture(usuario.id, 'wa_onboarding_completed', { via });
}

// El único mensaje del alta que importa: pedir el primer gasto. Nada de plan,
// nada de email. El link de activación llega DESPUÉS de ese gasto, no antes.
function mensajePrimerGasto(nombre) {
  const primerNombre = nombre ? nombre.split(' ')[0] : '';
  return (primerNombre ? '¡Listo, *' + primerNombre + '*! 🤝' : '¡Listo! 🤝') + '\n\n' +
    'Anótame tu primer gasto y te muestro cómo funciono:\n\n' +
    '📝 _"gasté 20 en taxi"_\n' +
    '📸 O mándame la foto de un Yape o Plin\n\n' +
    '_Lo que sea, del monto que sea._';
}

// Parsea la respuesta del selector de bancos (pasos 30 y 31). Devuelve
// { ok, ids } donde ids es un array de ids del catálogo, o null para "todos".
// ok=false si no se reconoció ningún número válido ni "todos".
function interpretarSeleccionBancos(cmd) {
  const cmdLower = cmd.trim().toLowerCase();
  if (cmdLower === 'todos' || cmdLower === 'todas' || cmdLower === 'all') return { ok: true, ids: null };
  const indices = [...new Set(
    cmd.split(/[\s,]+/).map(Number)
      .filter(n => Number.isInteger(n) && n >= 1 && n <= BANCOS_CATALOGO.length)
  )];
  if (indices.length === 0) return { ok: false, ids: undefined };
  return { ok: true, ids: indices.map(n => BANCOS_CATALOGO[n - 1].id) };
}

/**
 * @param {object} args
 * @param {object} args.usuario  fila de usuarios (incluye onboarding_paso, nombre, ...)
 * @param {string} args.msg      texto crudo del mensaje entrante
 * @param {string} args.cmd      msg.toLowerCase().trim()
 * @param {string} args.from     numero de WhatsApp (para contexto; el envio lo hace webhook)
 * @returns {Promise<string|null>} texto a enviar, o null si no es parte del alta
 */
async function manejarOnboarding({ usuario, msg, cmd, from }) {
  // ─── Flujo desconectar cuenta / wipe (paso -1) ─────────────────────────────
  if (usuario.onboarding_paso === -1 && !cmd.startsWith('/')) {
    const respDesc = parseInt(cmd.trim());
    const cuentasActivas = await obtenerCuentasGmail(usuario.id);
    const numCuentas = cuentasActivas.length;

    if (numCuentas > 1) {
      // Multi-cuenta: 1..N = desconectar individual, N+1 = todas, N+2 = eliminar todo
      if (respDesc >= 1 && respDesc <= numCuentas) {
        const cuentaTarget = cuentasActivas[respDesc - 1];
        await supabase.from('gmail_cuentas').update({ activa: false }).eq('id', cuentaTarget.id);
        await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
        return '✅ *' + cuentaTarget.email + ' desconectado*\n\nTus otras cuentas siguen activas. Tu historial se mantiene intacto.';
      } else if (respDesc === numCuentas + 1) {
        await supabase.from('gmail_cuentas').update({ activa: false }).eq('usuario_id', usuario.id);
        await supabase.from('usuarios').update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, onboarding_paso: 0 }).eq('id', usuario.id);
        return '✅ *Todas las cuentas Gmail desconectadas*\n\nTu historial de gastos se mantiene intacto. Puedes volver a conectar escribiendo _"conectar gmail"_.';
      } else if (respDesc === numCuentas + 2) {
        await supabase.from('transacciones').delete().eq('usuario_id', usuario.id);
        await supabase.from('categorias_usuario').delete().eq('usuario_id', usuario.id);
        await supabase.from('presupuestos').delete().eq('usuario_id', usuario.id);
        await supabase.from('gmail_cuentas').delete().eq('usuario_id', usuario.id);
        await supabase.from('usuarios').update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, email: null, onboarding_paso: 0, onboarding_completado: false }).eq('id', usuario.id);
        return '🗑️ *Cuenta limpia*\n\nTodos tus datos han sido eliminados. Si quieres volver, escribe _"hola"_ y empezamos de cero.';
      }
    } else if (numCuentas === 1) {
      if (respDesc === 1) {
        await supabase.from('gmail_cuentas').update({ activa: false }).eq('usuario_id', usuario.id);
        await supabase.from('usuarios').update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, onboarding_paso: 0 }).eq('id', usuario.id);
        return '✅ *Gmail desconectado*\n\nTu historial de gastos se mantiene intacto. Puedes volver a conectar cuando quieras escribiendo _"conectar gmail"_.';
      } else if (respDesc === 2) {
        await supabase.from('transacciones').delete().eq('usuario_id', usuario.id);
        await supabase.from('categorias_usuario').delete().eq('usuario_id', usuario.id);
        await supabase.from('presupuestos').delete().eq('usuario_id', usuario.id);
        await supabase.from('gmail_cuentas').delete().eq('usuario_id', usuario.id);
        await supabase.from('usuarios').update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, email: null, onboarding_paso: 0, onboarding_completado: false }).eq('id', usuario.id);
        return '🗑️ *Cuenta limpia*\n\nTodos tus datos han sido eliminados. Si quieres volver, escribe _"hola"_ y empezamos de cero.';
      }
    } else {
      // Sin cuentas Gmail, solo opción de eliminar datos
      if (respDesc === 1) {
        await supabase.from('transacciones').delete().eq('usuario_id', usuario.id);
        await supabase.from('categorias_usuario').delete().eq('usuario_id', usuario.id);
        await supabase.from('presupuestos').delete().eq('usuario_id', usuario.id);
        await supabase.from('usuarios').update({ email: null, onboarding_paso: 0, onboarding_completado: false }).eq('id', usuario.id);
        return '🗑️ *Datos eliminados*\n\nSi quieres volver, escribe _"hola"_.';
      }
    }
    // Respuesta no válida → cancelar
    await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
    return 'Cancelado. Tu cuenta sigue igual. 👍';
  }

  // ─── Paso 30: Elegir bancos antes de conectar Gmail (Pro) ──────────────────
  // Se entra aquí desde el flujo de conexión (/conectar en webhook, intent
  // agregar_gmail en consultas). Guardamos la selección en bancos_seleccionados
  // y recién ahí entregamos el enlace de OAuth. "todos" → null (= set completo,
  // backward-compatible y auto-incluye bancos que agreguemos luego).
  if (usuario.onboarding_paso === 30 && !cmd.startsWith('/')) {
    const sel = interpretarSeleccionBancos(cmd);
    if (!sel.ok) return REPROMPT_BANCOS;
    await supabase.from('usuarios').update({ bancos_seleccionados: sel.ids, onboarding_paso: 0 }).eq('id', usuario.id);
    const cuantos = sel.ids
      ? (sel.ids.length === 1 ? 'ese banco' : 'esos ' + sel.ids.length + ' bancos')
      : 'todos los bancos';
    return '✅ Listo, leeré ' + cuantos + '.\n\nAhora conecta tu Gmail acá:\n\n' + generarUrlAutorizacion(from) + '\n\n_Solo leemos notificaciones bancarias. Sin contraseñas._';
  }

  // ─── Paso 31: Editar bancos en cualquier momento (comando /bancos) ─────────
  // Igual que el paso 30 pero standalone: no entrega OAuth, solo confirma el
  // cambio. Deja al usuario activar/desactivar bancos cuando quiera.
  if (usuario.onboarding_paso === 31 && !cmd.startsWith('/')) {
    const sel = interpretarSeleccionBancos(cmd);
    if (!sel.ok) return REPROMPT_BANCOS;
    await supabase.from('usuarios').update({ bancos_seleccionados: sel.ids, onboarding_paso: 0 }).eq('id', usuario.id);
    return '✅ Actualizado. Ahora leo: *' + describirSeleccion(sel.ids) + '*.\n\nPuedes cambiarlo cuando quieras con */bancos*.';
  }

  // ─── Paso 100: Recoger nombre del usuario ──────────────────────────────────
  // Ya NO es un bucle. Tenía una sola salida (dar un nombre que pasara el
  // validador) y ahí se caían 10 de 82 usuarios, con una vida mediana de 5
  // minutos. Ahora tiene tres, y ninguna deja a nadie atrapado: el nombre es lo
  // único que se pide antes de que Neto sea útil, y ni siquiera es obligatorio.
  if (usuario.onboarding_paso === 100 && !cmd.startsWith('/')) {
    // El usuario quiere empezar a usar Neto ya, no presentarse.
    if (esSkipNombre(cmd)) {
      await completarAlta(usuario, 'saltado');
      return mensajePrimerGasto(null);
    }
    // Escribió un gasto en vez de su nombre. Antes esto se guardaba COMO nombre
    // ("Gasté 20 En Taxi"): el validador acepta cualquier cosa de 2-50 chars, así
    // que el primer gasto de la persona se perdía y encima quedaba de nombre.
    // Ahora el alta se cierra y el mensaje cae al pipeline normal, que lo registra.
    if (pareceTransaccion(msg)) {
      await completarAlta(usuario, 'primer_gasto');
      return null;   // ← fall-through: lo procesa message-processor como siempre
    }
    let nombreInput = msg.trim();
    const nombreMatch = nombreInput.match(/(?:me llamo|mi nombre es|soy|es)\s+(.+)/i);
    if (nombreMatch) nombreInput = nombreMatch[1].trim();
    nombreInput = nombreInput.replace(/[.,!]+$/, '').trim();
    if (nombreInput.length < 2 || nombreInput.length > 50 || /^\d+$/.test(nombreInput)) {
      stepFailed(usuario, 100, 'nombre_invalido');
      // Se repregunta UNA sola vez. Al segundo intento fallido el nombre deja de
      // importar: vale más un usuario activo sin nombre que uno trabado con él.
      if (usuario.nombre_intentos >= 1) {
        await completarAlta(usuario, 'saltado');
        return mensajePrimerGasto(null);
      }
      await supabase.from('usuarios').update({ nombre_intentos: (usuario.nombre_intentos || 0) + 1 }).eq('id', usuario.id);
      return 'No pillé tu nombre. 🤔\n\nEscríbelo solito (ej: _"María"_) o dime *saltar* y empezamos de una.';
    }
    const nombreLimpio = nombreInput.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    await supabase.from('usuarios').update({ nombre: nombreLimpio }).eq('id', usuario.id);
    await completarAlta(usuario, 'nombre');
    return mensajePrimerGasto(nombreLimpio);
  }

  // ─── Paso 101 (retirado): pedía el email ───────────────────────────────────
  // El email era el peor punto de fuga del alta (7 de 82) y no tenía razón de
  // producto: se pedía para vincular la cuenta web, y eso ahora lo resuelve el
  // link de activación firmado (lib/activacion.js), que ya lleva la identidad.
  // Esta rama solo desatasca a quien quedó en 101 con el flujo viejo: data en
  // vuelo al momento del deploy, o alguien que vuelve meses después.
  if (usuario.onboarding_paso === 101 && !cmd.startsWith('/')) {
    await completarAlta(usuario, 'desatascado_101');
    if (pareceTransaccion(msg)) return null;   // si escribió un gasto, que se registre
    return mensajePrimerGasto(usuario.nombre);
  }

  // ─── Paso 1: Usuario elige Free/Pro ────────────────────────────────────────
  if (usuario.onboarding_paso === 1 && !cmd.startsWith('/')) {
    const resp1 = cmd.trim().toLowerCase();
    if (resp1 === 'free' || resp1 === 'gratis' || resp1 === 'manual') {
      await supabase.from('usuarios').update({
        plan: 'free',
        onboarding_paso: 0,
        onboarding_completado: true
      }).eq('id', usuario.id);
      analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'free' });
      return '🆓 *¡Bienvenido a Neto Free!*\n\n' +
        'Registra gastos así:\n\n' +
        '📝 _"gasté 50 en taxi"_\n' +
        '📸 Envía una foto de Yape o Plin\n\n' +
        '📊 Configura tus presupuestos en tu dashboard:\nhttps://app.neto.pe/dashboard/presupuestos\n\n' +
        '¿Por dónde empezamos?';
    }
    if (resp1 === 'pro' || resp1 === 'si' || resp1 === 'sí' || resp1 === 'yes' || resp1 === 'dale' || resp1 === 'va' || resp1 === 'quiero') {
      await supabase.from('usuarios').update({ onboarding_paso: 2 }).eq('id', usuario.id);
      stepOk(usuario, 1, 2);
      return '🎉 *¡Genial!*\n\n' +
        'Elige tu plan:\n\n' +
        '1️⃣ *Mensual* — S/10/mes\n' +
        '2️⃣ *Anual* — S/99/año (2 meses gratis)\n\n' +
        '📲 *Yapea al:* 970398192\n' +
        '👤 *A nombre de:* Favio Mendoza\n\n' +
        'Después envíame la captura del Yape aquí. 📸';
    }
    if (resp1 === 'no' || resp1 === 'no gracias') {
      await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
      stepFailed(usuario, 1, 'rechaza_plan');
      return '👍 Sin problema. Si cambias de opinión, escribe *hola* cuando quieras.';
    }
    stepFailed(usuario, 1, 'plan_no_reconocido');
    return 'Escribe *free* para empezar gratis o *pro* para activar el plan Pro.';
  }

  // ─── Paso 2: Esperando selección de plan o comprobante de pago ─────────────
  // (La captura de pago por imagen la maneja el handler de IMAGEN en webhook.js
  //  vía esperaComprobante(), que lee onboarding_paso === 2.)
  if (usuario.onboarding_paso === 2 && !cmd.startsWith('/')) {
    if (cmd === '1' || cmd.trim().toLowerCase() === 'mensual') {
      await supabase.from('usuarios').update({ tipo_plan: 'mensual' }).eq('id', usuario.id);
      return '✅ Plan *mensual* (S/10/mes).\n\n📲 Yapea S/10 al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸';
    } else if (cmd === '2' || cmd.trim().toLowerCase() === 'anual') {
      await supabase.from('usuarios').update({ tipo_plan: 'anual' }).eq('id', usuario.id);
      return '✅ Plan *anual* (S/99/año — 2 meses gratis).\n\n📲 Yapea S/99 al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸';
    }
    return 'Elige tu plan:\n\n1️⃣ *Mensual* — S/10\n2️⃣ *Anual* — S/99\n\nO envíame la captura de tu Yape si ya pagaste. 📸';
  }

  // ─── Paso 10: Selección de categorías ──────────────────────────────────────
  // Sin índices válidos NO retorna: cae a los triggers de entrada de abajo
  // (comportamiento heredado del webhook original).
  if (usuario.onboarding_paso === 10 && !cmd.startsWith('/')) {
    const idxResp = parsearIndicesRespuesta(msg, CATEGORIAS_SUGERIDAS.length);
    if (idxResp.length > 0) {
      await crearCategoriasDesdeIndices(usuario.id, idxResp);
      const nombresAct = idxResp.map(function(i){ return CATEGORIAS_SUGERIDAS[i-1].emoji+' '+CATEGORIAS_SUGERIDAS[i-1].nombre; }).join(', ');
      const rspCat = '🎉 *Categorias activadas:*\n' + nombresAct + '\n\nCada una tiene subcategorias sugeridas.\n\n*¿Quieres configurar un presupuesto mensual?* 💰\n\nEj: _"limite de 500 soles en Comida"_\n\nO escribe *listo* para empezar con NETO.';
      await supabase.from('usuarios').update({ onboarding_paso: 20, onboarding_completado: true }).eq('id', usuario.id);
      analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'categorias' });
      return rspCat;
    }
  }

  // ─── Paso 20: Presupuesto opcional ─────────────────────────────────────────
  // Texto no reconocido como presupuesto NO retorna: cae a los triggers de abajo.
  if (usuario.onboarding_paso === 20 && !cmd.startsWith('/')) {
    const cmdLower20 = cmd.trim().toLowerCase();
    if (cmdLower20 === 'listo' || cmdLower20 === 'no' || cmdLower20 === 'omitir' || cmdLower20 === 'saltar') {
      await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
      const primerNombre20 = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
      return (primerNombre20 ? 'Listo, ' + primerNombre20 + '.' : 'Listo.') + ' Ya estoy trabajando por ti.\n\nEscribeme como quieras:\n_"cuanto gaste esta semana"_\n_"como va mi delivery"_\n_"dame mi reporte"_\n\n¿Por donde empezamos?';
    }
    try {
      const interpPres20 = await interpretarComandoPresupuesto(msg);
      if (interpPres20.es_presupuesto && interpPres20.categoria && interpPres20.monto) {
        await guardarPresupuesto(usuario.id, interpPres20.categoria, interpPres20.monto);
        return '✅ Presupuesto de *' + interpPres20.categoria + '*: *S/ ' + parseFloat(interpPres20.monto).toFixed(2) + '/mes*\n\n¿Alguna otra categoria? O escribe *listo* para terminar.';
      }
    } catch (e) {}
  }

  // ─── Triggers de entrada al alta ───────────────────────────────────────────
  const esUsuarioNuevo = !usuario.gmail_access_token && !usuario.onboarding_completado;
  if (cmd === 'hola' || cmd === 'hi' || cmd === 'inicio') {
    const tieneGmail = !!usuario.gmail_access_token;
    if (!tieneGmail && !usuario.onboarding_completado) {
      if (!usuario.nombre) {
        await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', usuario.id);
        return '👋 ¡Hola! Soy *NETO*, tu asistente financiero por WhatsApp.\n\n' +
          '¿Cómo te llamas?\n\n_O dime *saltar* si prefieres ir directo._';
      }
      // Ya tiene nombre → no queda nada que preguntar. El plan ya no se elige en
      // el alta: el modelo es probar primero y pagar después, así que invitar a
      // Pro el día 1 (antes de que la persona registre un solo gasto) no aplica.
      await completarAlta(usuario, 'nombre');
      return mensajePrimerGasto(usuario.nombre);
    }
    // Usuario ya onboardeado o con Gmail → NO es alta. El saludo normal (con
    // total del mes) lo maneja webhook.js.
    return null;
  }

  if (cmd === '/manual') {
    await supabase.from('usuarios').update({ plan: 'free' }).eq('id', usuario.id);
    await completarAlta(usuario, 'manual');
    return mensajePrimerGasto(usuario.nombre);
  }

  if (esUsuarioNuevo && !cmd.startsWith('/')) {
    // El primer mensaje YA es un gasto. Se cierra el alta en silencio y se deja
    // pasar: que la primera respuesta de Neto sea el gasto registrado (con el
    // link de activación al pie) y no un formulario es el punto de todo esto.
    if (pareceTransaccion(msg)) {
      await completarAlta(usuario, 'primer_gasto');
      return null;
    }
    await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', usuario.id);
    return '👋 ¡Hola! Soy *NETO*, tu asistente financiero.\n\n' +
      '¿Cómo te llamas?\n\n_O dime *saltar* y empezamos de una._';
  }

  // El mensaje no pertenece al alta.
  return null;
}

module.exports = { manejarOnboarding };
