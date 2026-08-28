const log = require('../../lib/logger');
const { PRO_PRECIOS } = require('../../lib/config');
const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');

module.exports = {
  intents: ['saludo', 'ayuda', 'agradecimiento', 'queja', 'chiste_finanzas', 'como_empezar', 'feedback'],
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
      case 'ayuda':
        return 'Puedo ayudarte con tus gastos, presupuestos y reportes. Escribe como quieras: _"cuanto gaste esta semana"_, _"como va mi delivery"_, _"dame mi reporte"_.';

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
      case 'como_empezar':
        return '¡Bienvenido a Neto! 🎉\n\n*3 pasos para empezar:*\n\n1️⃣ Registra un gasto → _"gasté 50 en taxi"_\n2️⃣ Envía una foto Yape/Plin 📸\n3️⃣ Ve tu resumen → _"mis gastos del mes"_\n\n📊 Dashboard: https://app.neto.pe\n⭐ *Pro (S/' + PRO_PRECIOS.mensual + '/mes):* Neto lee tus correos bancarios automáticamente\n\n_¿Empezamos? Dime tu primer gasto._';

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
