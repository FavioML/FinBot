// Maquina de estados del onboarding (alta de usuarios) de Neto por WhatsApp.
//
// Extraida de handlers/webhook.js para aislar el flujo mas critico del producto
// (el alta) de la cascada de despacho de comandos. El estado vive en la columna
// usuarios.onboarding_paso; los valores en uso son: -1 (desconexion/wipe),
// 0 (idle/completado), 1 (elige Free/Pro), 2 (elige plan / espera comprobante),
// 10 (categorias), 20 (presupuesto opcional), 100 (pide nombre), 101 (pide email).
// El marcador de "alta completa" es la columna booleana onboarding_completado,
// no un valor de paso: al terminar, onboarding_paso vuelve a 0.
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
const { obtenerCuentasGmail } = require('../gmail');
const { crearCategoriasDesdeIndices } = require('../services/categories');
const { interpretarComandoPresupuesto } = require('../services/parsers');
const { guardarPresupuesto } = require('../services/budget');
const analytics = require('../lib/analytics');

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

  // ─── Paso 100: Recoger nombre del usuario ──────────────────────────────────
  if (usuario.onboarding_paso === 100 && !cmd.startsWith('/')) {
    // Extraer nombre inteligentemente: "Mi nombre es Annie" → "Annie", "Soy Juan Carlos" → "Juan Carlos"
    let nombreInput = msg.trim();
    const nombreMatch = nombreInput.match(/(?:me llamo|mi nombre es|soy|es)\s+(.+)/i);
    if (nombreMatch) nombreInput = nombreMatch[1].trim();
    // Limpiar posibles puntos, comas al final
    nombreInput = nombreInput.replace(/[.,!]+$/, '').trim();
    if (nombreInput.length < 2 || nombreInput.length > 50 || /^\d+$/.test(nombreInput)) {
      return 'Dime tu nombre real. Ej: _"María"_ o _"Juan Carlos"_.';
    }
    const nombreLimpio = nombreInput.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    await supabase.from('usuarios').update({ nombre: nombreLimpio, onboarding_paso: 101 }).eq('id', usuario.id);
    return '¡Mucho gusto, *' + nombreLimpio + '*! 🤝\n\n¿Cuál es tu correo electrónico?\n\n_Lo usaremos solo para contactarte si necesitas soporte._';
  }

  // ─── Paso 101: Recoger email del usuario ───────────────────────────────────
  if (usuario.onboarding_paso === 101 && !cmd.startsWith('/')) {
    // Extraer email inteligentemente: "Mi correo es juan@gmail.com" → "juan@gmail.com"
    const emailRegex = /[^\s@]+@[^\s@]+\.[^\s@]+/;
    const emailMatch = msg.trim().toLowerCase().match(emailRegex);
    const emailInput = emailMatch ? emailMatch[0].replace(/[.,;:!?]+$/, '') : '';
    if (!emailInput || !emailRegex.test(emailInput)) {
      return 'Eso no parece un correo válido. Escribe tu email, ej: _"juan@gmail.com"_.';
    }
    // El correo debe ser único: lo usaremos para vincular tu cuenta cuando pases a Pro.
    const { data: emailEnUso } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', emailInput)
      .neq('id', usuario.id)
      .limit(1);
    if (emailEnUso && emailEnUso.length > 0) {
      return 'Ese correo ya está registrado con otra cuenta. 🤔\n\nEscríbeme otro, porfa. Es importante que sea válido y tuyo porque lo usaremos para vincularte cuando quieras pasar a *Pro*.';
    }
    const { error: emailUpdErr } = await supabase.from('usuarios').update({ email: emailInput, onboarding_paso: 1 }).eq('id', usuario.id);
    if (emailUpdErr) {
      // 23505 = unique_violation: otro usuario tomó ese correo en la ventana
      // entre el chequeo de arriba y este update (índice usuarios_email_lower_unique).
      if (emailUpdErr.code === '23505') {
        return 'Ese correo ya está registrado con otra cuenta. 🤔\n\nEscríbeme otro, porfa. Es importante que sea válido y tuyo porque lo usaremos para vincularte cuando quieras pasar a *Pro*.';
      }
      throw emailUpdErr;
    }
    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
    return '📧 ¡Perfecto' + (primerNombre ? ', ' + primerNombre : '') + '!\n\nAhora, elige tu plan:\n\n' +
      '📊 *¿Qué hace Neto?*\n' +
      '• Te dice en qué gastas tu plata por WhatsApp\n' +
      '• Dashboard con gráficos, metas y reportes\n' +
      '• Funciona con BCP, BBVA, Interbank, Yape, Plin y más\n\n' +
      '🆓 *Plan Free* — S/0\n' +
      '• Registra gastos manual o por foto\n' +
      '• Presupuestos y metas ilimitados\n' +
      '• Dashboard del mes actual\n\n' +
      '⭐ *Plan Pro* — S/10/mes\n' +
      '• Lectura automática de correos bancarios\n' +
      '• Historial completo + reportes PDF\n' +
      '• Resumen diario + consejos IA\n\n' +
      'Escribe *free* para empezar gratis o *pro* para activar Pro.';
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
      return '👍 Sin problema. Si cambias de opinión, escribe *hola* cuando quieras.';
    }
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
        // Primero pedir el nombre
        await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', usuario.id);
        return '👋 ¡Hola! Soy *NETO*, tu asistente financiero por WhatsApp.\n\n' +
          'Antes de empezar, ¿cómo te llamas?';
      }
      // Ya tiene nombre → directo a la selección Free/Pro
      await supabase.from('usuarios').update({ onboarding_paso: 1 }).eq('id', usuario.id);
      return '👋 Hola, ' + usuario.nombre.split(' ')[0] + '. Soy *NETO*, tu asistente financiero.\n\n' +
        '📊 *¿Qué hace Neto?*\n' +
        '• Te dice en qué gastas tu plata por WhatsApp\n' +
        '• Dashboard con gráficos, metas y reportes\n' +
        '• Funciona con BCP, BBVA, Interbank, Yape, Plin y más\n\n' +
        '🆓 *Plan Free* — S/0\n' +
        '• Registra gastos manual o por foto\n' +
        '• Presupuestos y metas ilimitados\n' +
        '• Dashboard del mes actual\n\n' +
        '⭐ *Plan Pro* — S/10/mes\n' +
        '• Lectura automática de correos bancarios\n' +
        '• Historial completo + reportes PDF\n' +
        '• Resumen diario + consejos IA\n\n' +
        'Escribe *free* para empezar gratis o *pro* para activar Pro.';
    }
    // Usuario ya onboardeado o con Gmail → NO es alta. El saludo normal (con
    // total del mes) lo maneja webhook.js.
    return null;
  }

  if (cmd === '/manual') {
    // Onboarding sin Gmail — modo free
    await supabase.from('usuarios').update({ plan: 'free', onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
    analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'manual' });
    return '✍️ *Modo Free activado*\n\nRegistra gastos así:\n📝 _"gasté 50 en taxi"_\n📸 Envía una foto de Yape o Plin\n\n📊 Configura tus presupuestos en tu dashboard:\nhttps://app.neto.pe/dashboard/presupuestos\n\n¿Por dónde empezamos?';
  }

  if (esUsuarioNuevo && !cmd.startsWith('/')) {
    await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', usuario.id);
    return '👋 ¡Hola! Soy *NETO*, tu asistente financiero.\n\nPara empezar, ¿cómo te llamas?';
  }

  // El mensaje no pertenece al alta.
  return null;
}

module.exports = { manejarOnboarding };
