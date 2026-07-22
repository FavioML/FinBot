const log = require('../../lib/logger');

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

      // Antes decia "Dejame revisar" y la IA prometia verificar el registro: nadie revisa nada.
      // Se responde con el canal real de soporte y sin prometer una accion que no ocurre.
      case 'queja':
        return 'Gracias por avisar. Escríbenos al 970398192 con el detalle y lo resolvemos.';

      case 'chiste_finanzas': {
        const ctxChiste = 'El usuario quiere un chiste o dato curioso sobre finanzas. Cuenta un chiste corto y gracioso relacionado con dinero, ahorro o finanzas personales. Usa humor peruano si puedes. Máximo 3 líneas.';
        const respChiste = await redactarConNETO(netoPrompt, ctxChiste, msg, historialConv);
        return respChiste || '¿Sabes cuál es el banco favorito de los peces? 🐟\n\n¡El banco de arena! 😄\n\n_Ahora sí, ¿revisamos tus gastos?_';
      }

      // Onboarding: el texto fijo mantiene los 3 pasos numerados y escaneables. La IA los
      // aplanaba a un parrafo corrido por el limite de 6 lineas del redactor.
      case 'como_empezar':
        return '¡Bienvenido a Neto! 🎉\n\n*3 pasos para empezar:*\n\n1️⃣ Registra un gasto → _"gasté 50 en taxi"_\n2️⃣ Envía una foto Yape/Plin 📸\n3️⃣ Ve tu resumen → _"mis gastos del mes"_\n\n📊 Dashboard: https://app.neto.pe\n⭐ *Pro (S/10/mes):* Neto lee tus correos bancarios automáticamente\n\n_¿Empezamos? Dime tu primer gasto._';

      case 'feedback': {
        // Guardar feedback para revisión admin
        supabase.from('nlp_errors').insert({
          usuario_id: usuario.id, whatsapp: from,
          mensaje: msg.substring(0, 500), intencion: 'feedback',
          error_tipo: 'feedback', error_detalle: 'Sugerencia del usuario'
        }).then(() => {}).catch(() => {});
        return '💡 *¡Gracias por tu sugerencia!*\n\nLa recibimos y la vamos a evaluar. Tu feedback nos ayuda a mejorar Neto.\n\n_Si quieres contarnos más, escríbenos al 970398192._';
      }
    }
  }
};
