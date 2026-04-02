const log = require('../../lib/logger');

module.exports = {
  intents: ['saludo', 'ayuda', 'agradecimiento', 'queja', 'chiste_finanzas', 'como_empezar', 'feedback'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase, hoyPeru, netoPrompt, historialConv, redactarConNETO, obtenerGastosMes, obtenerConsultasPendientes } = ctx;

    switch (intencion) {
      case 'saludo': {
        const gastosSaludo = await obtenerGastosMes(usuario.id);
        const totalSaludo = gastosSaludo.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const _partsSaludo = hoyPeru().split('-');
        const { data: ingresosSaludo } = await supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', _partsSaludo[0] + '-' + _partsSaludo[1] + '-01');
        const totalIngresosSaludo = (ingresosSaludo || []).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const pendSaludo = await obtenerConsultasPendientes(usuario.id);
        const ctxSaludo = 'El usuario saluda. Contexto: este mes lleva S/ ' + totalSaludo.toFixed(0) + ' en gastos (' + gastosSaludo.length + ' movimientos)' + (totalIngresosSaludo > 0 ? ', S/ ' + totalIngresosSaludo.toFixed(0) + ' en ingresos registrados, balance S/ ' + (totalIngresosSaludo - totalSaludo).toFixed(0) : ', sin ingresos registrados') + '.' +
          (pendSaludo.length > 0 ? ' Tiene ' + pendSaludo.length + ' gasto(s) sin identificar.' : ' Sin pendientes.');
        const respSaludo = await redactarConNETO(netoPrompt, ctxSaludo, msg, historialConv);
        return respSaludo || ('\uD83D\uDC4B Hola' + (usuario.nombre ? ', ' + usuario.nombre.split(' ')[0] : '') + '. Soy NETO.\n\nEste mes llevas *S/ ' + totalSaludo.toFixed(0) + '* en ' + gastosSaludo.length + ' movimientos.\n\n\u00bfQue revisamos?');
      }
      case 'ayuda': {
        const ctxAyu = 'El usuario pregunta que puede hacer NETO o como funciona. Explica brevemente las capacidades: ver gastos, resumen semanal y mensual, presupuestos, reporte PDF, corregir categorias. Todo en tono NETO.';
        const respAyu = await redactarConNETO(netoPrompt, ctxAyu, msg, historialConv);
        return respAyu || 'Puedo ayudarte con tus gastos, presupuestos y reportes. Escribe como quieras: _"cuanto gaste esta semana"_, _"como va mi delivery"_, _"dame mi reporte"_. \u00bfPor donde empezamos?';
      }

      case 'agradecimiento': {
        const ctxAgr = 'El usuario agradece o felicita a NETO. Responde breve y motivacional, mencionando algun dato positivo de sus finanzas si lo tienes. No hagas preguntas.';
        const gastosMesAgr = await obtenerGastosMes(usuario.id);
        const totalAgr = gastosMesAgr.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const ctxAgrDatos = ctxAgr + ' Contexto: lleva S/' + totalAgr.toFixed(0) + ' en ' + gastosMesAgr.length + ' movimientos este mes.';
        const respAgr = await redactarConNETO(netoPrompt, ctxAgrDatos, msg, historialConv);
        return respAgr || '¡De nada! Aquí andamos cuidando tu bolsillo. 💪';
      }

      case 'queja': {
        const ctxQueja = 'El usuario reporta un problema o se queja de algo que no funciona. Empatiza brevemente, ofrece verificar y da el contacto de soporte: WhatsApp 970398192. No te disculpes de más, se directo.';
        const respQueja = await redactarConNETO(netoPrompt, ctxQueja, msg, historialConv);
        return respQueja || 'Entendido. Déjame revisar.\n\nSi el problema persiste, escríbenos al 970398192 y lo resolvemos.';
      }

      case 'chiste_finanzas': {
        const ctxChiste = 'El usuario quiere un chiste o dato curioso sobre finanzas. Cuenta un chiste corto y gracioso relacionado con dinero, ahorro o finanzas personales. Usa humor peruano si puedes. Máximo 3 líneas.';
        const respChiste = await redactarConNETO(netoPrompt, ctxChiste, msg, historialConv);
        return respChiste || '¿Sabes cuál es el banco favorito de los peces? 🐟\n\n¡El banco de arena! 😄\n\n_Ahora sí, ¿revisamos tus gastos?_';
      }

      case 'como_empezar': {
        const ctxEmpezar = 'El usuario es nuevo o quiere saber cómo empezar. Guíalo paso a paso de forma amigable: 1) Registrar gastos manualmente ("gasté 50 en taxi"), enviar fotos de comprobantes Yape/Plin, o cargar un Excel, 2) Ver su resumen con "mis gastos del mes" o entrar a https://app.neto.pe, 3) Menciona que con el Plan Pro (S/10/mes) puede conectar su Gmail y Neto lee sus correos bancarios automáticamente. Máximo 8 líneas, tono motivador.';
        const respEmpezar = await redactarConNETO(netoPrompt, ctxEmpezar, msg, historialConv);
        return respEmpezar || '¡Bienvenido a Neto! 🎉\n\n*3 pasos para empezar:*\n\n1️⃣ Registra un gasto → _"gasté 50 en taxi"_\n2️⃣ Envía una foto Yape/Plin 📸\n3️⃣ Ve tu resumen → _"mis gastos del mes"_\n\n📊 Dashboard: https://app.neto.pe\n⭐ *Pro (S/10/mes):* Neto lee tus correos bancarios automáticamente\n\n_¿Empezamos? Dime tu primer gasto._';
      }

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
