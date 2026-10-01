const log = require('../../lib/logger');
const { PRO_PRECIOS, lineaPrecioPro, descuentoReferidoVigente, precioProEfectivo } = require('../../lib/config');
const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');
const { formatFecha } = require('../../lib/formatters');
const { enTrial, estaEnMuro, esProPagado, enlaceApp, mensajeConectarEnLaApp, TRIAL_DIAS } = require('../../lib/trial');

const AYUDA_GENERICA = 'Puedo ayudarte con tus gastos, presupuestos y reportes. Escribe como quieras: _"cuanto gaste esta semana"_, _"como va mi delivery"_, _"dame mi reporte"_.';

// "Lo que se cierra" en el muro, con las mismas palabras en todos los temas que lo nombran.
// La regla vive en app/CLAUDE.md ("Modelo comercial"): escribir nunca se corta; lo que se
// cobra es leer. Sobrevive el total del mes pegado a cada confirmación (`nudgeMuro`).
const LO_QUE_SE_CIERRA = 'Lo que se cierra es ver el detalle: gráficos, historial, reportes y las consultas por acá.';

function finDePrueba(usuario) {
  if (!enTrial(usuario) || !usuario.trial_vence) return null;
  return formatFecha(String(usuario.trial_vence).slice(0, 10));
}

/**
 * La respuesta fija de cada tema de ayuda (`TEMAS_AYUDA` en `handlers/neto-tools.js`).
 * PURA: no lee ni escribe nada, así que se prueba sin base. El único tema con efecto
 * (`no_quiero_pro`, que cierra una espera de comprobante abierta) lo hace el handler.
 *
 * Cada afirmación se verificó contra el código el 30-sep-2026, y el lugar va al lado. Si
 * cambia el producto, el texto de acá miente: por eso el motivo está pegado a cada línea.
 *
 * `se_registro` no está acá: `mapToolToIntent` lo manda a `ver_ultima_transaccion`.
 * Un tema desconocido (o ninguno) cae en `otro`.
 *
 * @param {string|undefined} tema
 * @param {object} usuario  fila de usuarios (plan, trial_estado, trial_vence, premium_vence, supabase_auth_id)
 * @returns {string}
 */
function textoAyuda(tema, usuario) {
  const u = usuario || {};
  switch (tema) {
    // Precio: sale de PRO_PRECIOS (lib/config.js), nunca escrito a mano. "No te cobro nada
    // automático" es cierto porque Pro se paga por Yape con captura (lib/pro-payment.js): no
    // hay tarjeta guardada ni cobro recurrente.
    case 'precio_despues_prueba': {
      // "pagado" NO va: `esProPagado` también es true para el mes de referido y la cortesía,
      // que no pagaron (revisión adversarial del 30-sep).
      if (esProPagado(u)) {
        const vence = u.premium_vence ? formatFecha(String(u.premium_vence).slice(0, 10)) : null;
        return 'Ya tienes *Neto Pro*' + (vence ? ' hasta el ' + vence : '') + '. Renovarlo cuesta:\n' + lineaPrecioPro();
      }
      const fin = finDePrueba(u);
      let r = 'Neto Pro cuesta:\n' + lineaPrecioPro();
      // El descuento del referido baja el primer mes (`precioProEfectivo`, lib/config.js): sin
      // esta línea se le cotizaba S/10 a quien paga S/5.
      if (descuentoReferidoVigente(u) > 0) r += '\nPor tu referido, tu primer mes sale a *S/' + precioProEfectivo(u, 'mensual') + '*.';
      if (fin) r += '\n\nTu prueba termina el ' + fin + '.';
      // `trial_estado` null = nunca tuvo prueba: arranca con el primer gasto (lib/trial.js).
      else if (u.trial_estado === null && u.plan !== 'premium') r += '\n\nTu prueba de ' + TRIAL_DIAS + ' días, con gráficos, historial y reportes abiertos, empieza con tu primer gasto.';
      return r + '\n\nNo te cobro nada automático: no tengo tu tarjeta. Si quieres seguir con Pro, lo pagas por Yape cuando lo decidas (escribe */premium* y te digo cómo).' +
        '\n\nSi no pagas, sigo anotando tus gastos gratis por acá. ' + LO_QUE_SE_CIERRA;
    }

    // Al vencer, `checkTrialExpiry` (cron/checks.js) solo baja el plan: no borra filas, y
    // ningún cron borra transacciones. El total del mes sigue pegado a cada confirmación.
    case 'que_pasa_si_no_pago': {
      if (esProPagado(u)) {
        // Al vencer, `checkPremiumExpiry` desconecta el Gmail (cron/checks.js): no se promete
        // "recuperas todo" sin decir que el correo se vuelve a conectar.
        return 'Si un día no renuevas Pro, no se borra nada. Sigo anotando tus gastos gratis por acá. ' +
          LO_QUE_SE_CIERRA + ' Al renovar recuperas el detalle, y si usabas tu Gmail lo vuelves a conectar.';
      }
      return 'No pierdes nada de lo que registraste. Cuando termina la prueba no se borra nada y no te cobro nada solo.\n\n' +
        'Sigo anotando todo lo que me mandes, gratis y para siempre, y con cada gasto te digo cuánto llevas en el mes. ' +
        LO_QUE_SE_CIERRA + '\n\n' +
        // Con descuento de referido el primer mes no cuesta lo de lista (`precioProEfectivo`).
        'Si después pagas Pro (' + (descuentoReferidoVigente(u) > 0
          ? '*S/' + precioProEfectivo(u, 'mensual') + '* el primer mes'
          : '*S/' + PRO_PRECIOS.mensual + '/mes*') + '), lo recuperas todo.';
    }

    // No hay app en tiendas: la webapp es una PWA (webapp/public/manifest.json, display
    // standalone). El link respeta la identidad: a quien no tiene cuenta web, `/dashboard` lo
    // dejaría en /login y "Continuar con Google" le crearía una cuenta huérfana (lib/trial.js).
    case 'app_movil': {
      const { url, requiereActivacion } = enlaceApp(u, '/dashboard');
      let r = '📱 No tengo app en Play Store ni en App Store. Lo tuyo pasa por este chat y por la web:\n\n🔗 ' + url;
      if (requiereActivacion) r += '\n\n_Un toque con tu Google y entras: es la misma cuenta, con tus gastos de acá._';
      r += '\n\nDesde el navegador del celular la puedes agregar a tu pantalla de inicio.';
      if (estaEnMuro(u)) {
        r += '\n\nLos gráficos y el historial son de *Neto Pro*. Anotar por acá es gratis siempre.';
        // `trial_estado` null: nunca tuvo prueba, y la abre su primer gasto (lib/trial.js).
        if (u.trial_estado === null) r += ' Y tu primer gasto te abre ' + TRIAL_DIAS + ' días de prueba.';
      }
      return r;
    }

    // No hay integración con bancos, tarjetas, Yape ni Uber. El método de pago sí se guarda
    // cuando entra por captura (`metodo_pago` del prompt de services/media-intake.js); el
    // parser de texto no lo extrae.
    case 'conexiones': {
      const r = 'No me conecto con bancos, tarjetas, Yape ni Uber: no veo tus cuentas ni guardo tarjetas.\n\n' +
        'Los gastos me los cuentas tú por acá (_"uber 15"_), o me mandas la captura del Yape, Plin o del voucher y lo leo. ' +
        'Si en la captura se ve con qué pagaste, eso también queda guardado.';
      // Para quien paga, el correo es la excepción real: decirle "me los cuentas tú" a quien
      // tiene el Gmail conectado sería falso.
      return esProPagado(u)
        ? r + '\n\nCon tu Pro también leo los correos de consumo de tu banco, si conectas tu Gmail: escríbeme *conecta mi gmail* y te paso el enlace.'
        : r;
    }

    // Gmail: Pro PAGADO, opt-in, complemento, y se conecta solo desde la web (app/CLAUDE.md,
    // "Conectar Gmail es la unica capability que exige Pro PAGADO" y "Conectar es WEB-ONLY").
    case 'gmail': {
      if (esProPagado(u)) {
        return 'Sí, como complemento de lo que anotas por acá: leo los correos de consumo que te manda tu banco.\n\n' +
          mensajeConectarEnLaApp(u);
      }
      let r = '📧 Puedo leer los correos de consumo que te manda tu banco, pero es una función beta de *Neto Pro pagado* y es opcional. ' +
        'Se conecta solo desde la web, no desde este chat.';
      // Mismo motivo que `mensajeGmailProPagado`: a quien prueba Pro le suena a error que
      // falte algo, así que se le dice por qué esta es la excepción.
      if (enTrial(u)) r += '\n\nEs lo único que tu prueba no incluye: cada conexión nos cuesta un cupo con Google y los tenemos contados.';
      return r + '\n\nEs un complemento: lo que no te llega por correo lo sigues anotando por acá, como ahora.\n\n' +
        lineaPrecioPro() + '\n_Escribe */premium* y te digo cómo pagarlo._';
    }

    // El mensaje de las 9pm es el cierre de los días 0-2 de la prueba (lib/cierre-dia-prueba.js)
    // o Manos Libres: un resumen, no un corte. La fecha de un gasto es `hoyPeru()` al
    // registrarlo, y el mes es calendario (obtenerGastosMes, services/transactions.js).
    case 'periodo_del_mes':
      return 'Si te llega un mensaje a las 9 de la noche, es un resumen de lo que llevas anotado en el día; no cierra nada. ' +
        'Si anotas algo después de las 9, igual queda en ese día.\n\n' +
        'Tu mes va del 1 al último día, en hora de Perú.';

    // Categoría `Trabajo_Negocio` (lib/constants.js); moverla es `corregir_categoria`.
    case 'uso_negocio':
      return 'Neto está pensado para tus finanzas personales, pero puedes anotar los gastos de tu negocio igual que los tuyos. ' +
        'Si alguno no queda en *Trabajo_Negocio*, pídeme que lo mueva a esa categoría. Ojo que el total del mes los suma con los tuyos.\n\n' +
        'No emito facturas ni llevo contabilidad.';

    // No hay "reiniciar" en WhatsApp. Borrar un gasto es `eliminar_transaccion` con sujeto, y
    // "borrar mi cuenta" abre el menú del paso -1, que confirma con FRASE_BORRAR_CUENTA
    // (handlers/onboarding.js). El borrado de varios a la vez existe en la webapp
    // (/dashboard/transacciones), que el muro cierra: solo se ofrece a quien la puede abrir.
    case 'reiniciar_o_borrar': {
      let r = 'Por acá no tengo un botón para reiniciar.\n\n' +
        'Un gasto suelto lo borras diciéndome cuál, por ejemplo _"borra el de S/15"_.';
      if (u.supabase_auth_id && !estaEnMuro(u)) r += ' En app.neto.pe, en Transacciones, puedes seleccionar varios y borrarlos juntos.';
      return r + '\n\nSi lo que quieres es borrar tu cuenta con todos tus datos, escríbeme *borrar mi cuenta* y te explico cómo confirmarlo.';
    }

    // NO abre la espera del comprobante (`solicitarComprobante`), que es lo que hace
    // `ver_premium` en el muro (handlers/intents/premium.js).
    case 'no_quiero_pro': {
      let r = 'No hay problema, no tienes que pagar nada. Pro no se cobra solo: se paga por Yape y solo si tú decides.\n\n' +
        'Sigo anotando tus gastos gratis por acá, y eso no cambia.';
      // Quien ya tiene Pro lo conserva hasta su vencimiento: no renovar no le quita nada antes.
      if (esProPagado(u) && u.premium_vence) r += '\n\nTu Pro sigue hasta el ' + formatFecha(String(u.premium_vence).slice(0, 10)) + '.';
      const fin = finDePrueba(u);
      if (fin) r += '\n\nTu prueba termina el ' + fin + '. ' + LO_QUE_SE_CIERRA;
      return r;
    }

    default:
      return AYUDA_GENERICA + '\n\n_Si tu pregunta es sobre otra cosa, escribe */soporte* y te responde una persona del equipo._';
  }
}

module.exports = {
  intents: ['saludo', 'ayuda', 'agradecimiento', 'queja', 'chiste_finanzas', 'como_empezar', 'feedback'],
  textoAyuda,
  AYUDA_GENERICA,
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase, netoPrompt, historialConv, redactarConNETO, obtenerGastosMes } = ctx;

    switch (intencion) {
      // Los intents sociales responden con texto fijo a proposito: no hay dato que interpretar,
      // y pasarlos por redactarConNETO costaba ~1.4s y triplicaba el largo sin agregar
      // informacion (medido en qa-e2e/qa-lado-a-lado.mjs, 2026-07-21).
      case 'saludo': {
        const gastosSaludo = await obtenerGastosMes(usuario.id);
        const totalSaludo = gastosSaludo.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        return '\uD83D\uDC4B Hola' + (usuario.nombre ? ', ' + usuario.nombre.split(' ')[0] : '') + '. Soy NETO.\n\nEste mes llevas *S/ ' + totalSaludo.toFixed(0) + '* en ' + gastosSaludo.length + ' movimientos.';
      }
      case 'ayuda': {
        const tema = datos && datos.tema;
        // "No deseo el pro" después de un "¿cuánto cuesta Pro?": `ver_premium` le abrió al del
        // muro la espera del comprobante (48h). Desde el 14-ago el gasto de una foto se registra
        // igual (lo decide el contenido, handlers/webhook.js), pero mientras la espera siga
        // abierta cada Yape le contesta "Si esa era tu captura del pago a Neto… reenvíamela" a
        // quien acaba de decir que no quiere pagar. Se cierra. ACCESORIA: el texto no cambia si
        // no entra, y cero filas es esperable (la pudo cerrar `registrarSolicitudPro` en el medio).
        if (tema === 'no_quiero_pro' && usuario.esperando_comprobante) {
          await verificarEscritura(
            supabase.from('usuarios').update({ esperando_comprobante: false })
              .eq('id', usuario.id).eq('esperando_comprobante', true).select('id'),
            { sitio: 'no_quiero_pro', userId: usuario.id, campos: ['esperando_comprobante'], ceroFilas: 'esperado' });
        }
        return textoAyuda(tema, usuario);
      }

      case 'agradecimiento':
        return '¡De nada! Aquí andamos cuidando tu bolsillo. 💪';

      // La queja se GUARDA. Antes solo devolvia un texto con un numero al que escribir y no
      // dejaba ninguna fila: 0 quejas registradas en la vida del producto (medido 28-ago-2026),
      // o sea que la persona que peor la esta pasando era la unica que no aparecia en ningun
      // panel. Entra por la misma puerta que el feedback — nlp_errors es de hecho la bandeja
      // que el admin ya mira — y desde ahi se le puede responder.
      //
      // NO abre sesion de soporte sola: eso desviaria TODO mensaje siguiente al admin en vez
      // del bot (message-processor:104), asi que a quien solo queria quejarse se le romperia el
      // registro de gastos hasta el autocierre de 48h. Se OFRECE /soporte y decide la persona.
      case 'queja': {
        const vQueja = await verificarEscritura(
          supabase.from('nlp_errors').insert({
            usuario_id: usuario.id, whatsapp: from,
            mensaje: msg.substring(0, 500), intencion: 'queja',
            error_tipo: 'queja', error_detalle: 'Queja del usuario'
          }).select('id'),
          { sitio: 'queja', userId: usuario.id, campos: ['mensaje'] });
        if (!entro(vQueja)) {
          return 'Gracias por avisar, pero se me trabó anotándolo y no me quedó registrado. ' +
            'Escribe */soporte* y te atiende una persona del equipo por acá mismo.';
        }
        return 'Gracias por avisar. Lo anoté y lo va a revisar el equipo.\n\n' +
          '_Si quieres que te respondamos, escribe */soporte* y seguimos por acá._';
      }

      case 'chiste_finanzas': {
        const ctxChiste = 'El usuario quiere un chiste o dato curioso sobre finanzas. Cuenta un chiste corto y gracioso relacionado con dinero, ahorro o finanzas personales. Usa humor peruano si puedes. Máximo 3 líneas.';
        const respChiste = await redactarConNETO(netoPrompt, ctxChiste, msg, historialConv);
        return respChiste || '¿Sabes cuál es el banco favorito de los peces? 🐟\n\n¡El banco de arena! 😄\n\n_Ahora sí, ¿revisamos tus gastos?_';
      }

      // Onboarding: el texto fijo mantiene los 3 pasos numerados y escaneables. La IA los
      // aplanaba a un parrafo corrido por el limite de 6 lineas del redactor.
      // La línea de Pro no vende Gmail: es de Pro PAGADO, opcional y complemento, y no va en
      // superficies de conversión (products/neto/CLAUDE.md). Decía "Neto lee tus correos
      // bancarios automáticamente" hasta el 30-sep-2026.
      case 'como_empezar':
        return '¡Bienvenido a Neto! 🎉\n\n*3 pasos para empezar:*\n\n1️⃣ Registra un gasto → _"gasté 50 en taxi"_\n2️⃣ Envía una foto Yape/Plin 📸\n3️⃣ Ve tu resumen → _"mis gastos del mes"_\n\n📊 Dashboard: https://app.neto.pe\n⭐ *Pro (S/' + PRO_PRECIOS.mensual + '/mes):* gráficos, historial y reportes completos\n\n_¿Empezamos? Dime tu primer gasto._';

      case 'feedback': {
        // Guardar feedback para revisión admin.
        //
        // **La única del barrido que ni siquiera esperaba el resultado**: era un
        // `.then(() => {}).catch(() => {})`, o sea un descarte explícito de los dos desenlaces.
        // Y no es accesoria — guardar la sugerencia ES el intent. Si no entra, nadie evalúa
        // nada y la persona ya leyó *"La recibimos"*, que es la forma más barata de gastar la
        // buena voluntad de alguien que se tomó el trabajo de escribir. Ahora se espera: es
        // un insert, y la corrección vale más que los milisegundos que agrega a la respuesta.
        const vFeedback = await verificarEscritura(
          supabase.from('nlp_errors').insert({
            usuario_id: usuario.id, whatsapp: from,
            mensaje: msg.substring(0, 500), intencion: 'feedback',
            error_tipo: 'feedback', error_detalle: 'Sugerencia del usuario'
          }).select('id'),
          { sitio: 'feedback', userId: usuario.id, campos: ['mensaje'] });
        if (!entro(vFeedback)) {
          return '😕 Se me trabó guardando tu sugerencia, así que no me quedó anotada. ' +
            'Escribe */soporte* y me la cuentas de nuevo — gracias por tomarte el trabajo.';
        }
        return '💡 *¡Gracias por tu sugerencia!*\n\nLa recibimos y la vamos a evaluar. Tu feedback nos ayuda a mejorar Neto.\n\n_Si quieres contarnos más, escribe */soporte* y hablas con el equipo por acá._';
      }
    }
  }
};
