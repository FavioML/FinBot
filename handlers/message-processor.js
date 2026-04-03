const fs = require('fs');
const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { hoyPeru, ayerPeru, ultimoDiaMes } = require('../lib/dates');
const fechaHoyPeru = () => hoyPeru();
const fechaAyerPeru = () => ayerPeru();
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('../lib/constants');
const { validarMonto, normalizarCategoria } = require('../lib/validators');
const { getEmojiCategoria, formatearResumen, formatearPendientes, formatearCategoriasMsg, barraProgreso, generarRefCode, formatFecha } = require('../lib/formatters');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { obtenerTipoCambio, guardarTransaccion, obtenerGastosMes, obtenerGastosSemana, obtenerUltimaTransaccion, recategorizarTransaccion, corregirTransaccionEspecifica, guardarReglaComercio, retroaplicarRegla, obtenerConsultasPendientes } = require('../services/transactions');
const { guardarPresupuesto, obtenerPresupuestosMes, verificarAlertaPresupuesto, formatearEstadoPresupuesto } = require('../services/budget');
const { parsearCorreoBancario, parsearRegistroManual, parsearCorreccionesMultiples } = require('../services/parsers');
const { notificarErrorAdmin } = require('../lib/admin-notify');
const { registrarError } = require('../lib/error-monitor');
const { obtenerCuentasGmail } = require('../gmail');
const { generarRecomendaciones, construirDatosUsuario, generarMiniRecomendacion } = require('../services/recommendations');
const { registrarDeuda, obtenerDeudas, abonarDeuda, marcarDeudaPagada, formatearResumenDeudas, consolidarDeudasPorContraparte, saldarTodasDeudas } = require('../services/debts');
const { obtenerMetas: obtenerMetasService, abonarMeta: abonarMetaService, calcularRitmoAhorro, registrarLogro, obtenerLogros, verificarRachaAportes } = require('../services/metas');
const { obtenerCategoriasUsuario, detectarCategoriaIA, crearCategoriaLibreUsuario } = require('../services/categories');
const { redactarConNETO } = require('../services/neto-gpt');
const { escanearGmailYRegistrar } = require('../services/gmail-scanner');
const { generarYEnviarReporte } = require('../services/reports');
const { guardarMensaje, obtenerHistorial, getUserPlanConfig, getHistoryDateLimit } = require('../helpers/db-helpers');
const { getHandler } = require('./intent-registry');
const { NETO_TOOLS, mapToolToIntent } = require('./neto-tools');

async function procesarMensajeLibre(msg, usuario, from) {
  try {
    // === Interceptar tickets de soporte pendientes ===
    const { data: ticketPendiente } = await supabase.from('tickets_soporte').select('*')
      .eq('usuario_id', usuario.id).eq('estado', 'esperando_mensaje')
      .order('created_at', { ascending: false }).limit(1);
    if (ticketPendiente && ticketPendiente.length > 0) {
      const ticket = ticketPendiente[0];
      // Guardar el mensaje del usuario como descripción del ticket
      await supabase.from('tickets_soporte').update({
        mensaje_usuario: msg.substring(0, 1000),
        estado: 'pendiente',
        updated_at: new Date().toISOString()
      }).eq('id', ticket.id);
      // Notificar al admin con contexto completo
      const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
      const textoAdmin = '🎫 *Nuevo ticket de soporte*\n\n'
        + '👤 ' + (usuario.nombre || 'Sin nombre') + '\n'
        + '📱 ' + from + '\n'
        + '📋 Plan: ' + (usuario.tipo_plan || usuario.plan || 'free') + '\n\n'
        + '💬 *Mensaje:*\n' + msg.substring(0, 500) + '\n\n'
        + '_Responde con:_\n/responder ' + from + ' [tu mensaje]';
      await enviarWhatsapp(ADMIN_NUMBER, textoAdmin);
      return '✅ *Recibido.*\n\nTu mensaje fue enviado al equipo de Neto. Te responderemos lo antes posible por este mismo chat.\n\n_Si prefieres, también puedes escribirnos a 📧 hola@neto.pe_';
    }

    // === Interceptar tickets respondidos (usuario replica) ===
    const { data: ticketRespondido } = await supabase.from('tickets_soporte').select('*')
      .eq('usuario_id', usuario.id).eq('estado', 'respondido')
      .order('updated_at', { ascending: false }).limit(1);
    if (ticketRespondido && ticketRespondido.length > 0) {
      // Verificar si fue respondido en las últimas 2 horas (ventana de seguimiento)
      const ticketResp = ticketRespondido[0];
      const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      if (ticketResp.updated_at > hace2h) {
        // El usuario responde después de recibir respuesta del admin — reabrir como nuevo ticket
        await supabase.from('tickets_soporte').update({ estado: 'cerrado' }).eq('id', ticketResp.id);
        await supabase.from('tickets_soporte').insert({
          usuario_id: usuario.id, whatsapp: from,
          nombre_usuario: usuario.nombre || null,
          mensaje_usuario: msg.substring(0, 1000),
          estado: 'pendiente'
        });
        const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
        const textoReopen = '🔄 *Seguimiento de ticket*\n\n'
          + '👤 ' + (usuario.nombre || 'Sin nombre') + ' (' + from + ')\n\n'
          + '💬 *Respuesta del usuario:*\n' + msg.substring(0, 500) + '\n\n'
          + '📌 _El usuario no quedó conforme. Mensaje anterior:_\n'
          + (ticketResp.mensaje_usuario || '').substring(0, 200) + '\n\n'
          + '_Responde con:_\n/responder ' + from + ' [tu mensaje]';
        await enviarWhatsapp(ADMIN_NUMBER, textoReopen);
        return '📨 *Recibido.*\n\nTu mensaje fue reenviado al equipo. Si prefieres, también puedes contactarnos a:\n\n📧 hola@neto.pe\n\n_Te responderemos pronto._';
      }
    }

    const hoyParts = hoyPeru().split('-');
    const mesActual = parseInt(hoyParts[1], 10);
    const anioActual = parseInt(hoyParts[0], 10);
    const planUsuario = usuario.plan || 'free';
    const mE = ['','Enero','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    // Cargar NETO system prompt con datos del usuario
    let netoPrompt = 'Eres NETO, asistente financiero por WhatsApp. Hablas en espanol peruano, eres directo y siempre terminas con una accion o pregunta.';
    try {
      const rawPrompt = fs.readFileSync(require('path').join(__dirname, 'NETO_system_prompt.txt'), 'utf8');
      const parsersActivos = ['BCP','Interbank','BBVA','Scotiabank','Yape','Plin'].join(', ');
      const ultimaSync = usuario.updated_at ? new Date(usuario.updated_at).toLocaleDateString('es-PE') : 'hoy';
      netoPrompt = rawPrompt
        .replace(/\{NOMBRE_USUARIO\}/g, usuario.nombre || 'amigo')
        .replace(/\{PLAN_USUARIO\}/g, planUsuario)
        .replace(/\{MESES_HISTORIAL\}/g, '3')
        .replace(/\{PARSERS_ACTIVOS\}/g, parsersActivos)
        .replace(/\{ULTIMA_SYNC\}/g, ultimaSync);
    } catch(e) { log.error({ tag: 'NETO', err: e.message }, 'Error cargando system prompt'); }

    // Cargar historial de conversacion del usuario
    const historialConv = await obtenerHistorial(usuario.id);

    // Guardar mensaje del usuario en historial
    await guardarMensaje(usuario.id, 'usuario', msg);

    // === OpenAI Function Calling — NLP inteligente ===
    const nlpResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Eres NETO, asistente financiero por WhatsApp para peruanos. '
            + 'El mes actual es ' + mE[mesActual] + ' ' + anioActual + '. Hoy es ' + hoyPeru() + '. '
            + 'El usuario se llama ' + (usuario.nombre || 'amigo') + ' (plan: ' + planUsuario + ').\n\n'
            + 'Analiza el mensaje del usuario y usa la herramienta mas adecuada. '
            + 'Si el mensaje es conversacional (saludo, agradecimiento, queja, etc), usa social_response. '
            + 'Si el usuario quiere registrar un gasto o ingreso nuevo, usa register_transaction y extrae monto, moneda, comercio, categoria. '
            + 'Si menciona dividir un gasto con personas (ej: "pague la cena de 100 con Annie y Diego"), usa manage_debts con action=split_group. '
            + 'Si dice "debo X a Y" o "Y me debe X", usa manage_debts con action=register. '
            + 'Si quiere recategorizar un gasto, usa manage_transaction con action=recategorize. '
            + 'Si responde con "si", "no", "dale", "ok" a algo que preguntaste antes, usa social_response con action=greeting (se manejara como continuacion). '
            + 'Extrae montos, fechas, comercios y categorias del lenguaje natural del usuario. '
            + 'Para fechas relativas: "ayer" = restar 1 dia a hoy, "el lunes" = calcular fecha correcta.\n'
            + 'IMPORTANTE: Siempre usa una herramienta. Nunca respondas sin llamar una herramienta.\n'
            + 'CATEGORIAS VALIDAS: Alimentacion, Transporte, Vivienda, Salud, Entretenimiento, Compras, Educacion, Finanzas, Trabajo_Negocio, Otros.\n'
            + 'SUBCATEGORIAS: delivery, restaurante, supermercado, mercado, cafeteria, snacks, uber_cabify, taxi, bus_micro, gasolina, farmacia, medico, streaming, suscripciones, cine, ropa, electronico, hogar, belleza, prestamo, tarjeta_credito, herramientas, publicidad, sin_categoria.'
        },
        ...historialConv.slice(-4).map(h => ({
          role: h.rol === 'neto' ? 'assistant' : 'user',
          content: h.mensaje.substring(0, 200)
        })),
        { role: 'user', content: msg }
      ],
      tools: NETO_TOOLS,
      tool_choice: 'auto',
      temperature: 0
    });

    let intencion = null;
    let datos = {};

    const choice = nlpResponse.choices[0];

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      const toolCall = choice.message.tool_calls[0];
      const toolName = toolCall.function.name;
      let toolArgs = {};
      try { toolArgs = JSON.parse(toolCall.function.arguments); } catch(e) {}
      const mapped = mapToolToIntent(toolName, toolArgs);
      intencion = mapped.intencion;
      datos = mapped.datos;
    } else if (choice.message.content) {
      // GPT respondio con texto en vez de tool call — tratar como conversacional
      const respDirecta = choice.message.content;
      await guardarMensaje(usuario.id, 'neto', respDirecta.substring(0, 500));
      return respDirecta;
    } else {
      intencion = 'desconocido';
    }

    log.info({ tag: 'NLP', intencion, datos }, 'Intención clasificada');


    // === Intent dispatch via registry ===
    const ctx = {
      supabase, openai, log, hoyPeru, fechaHoyPeru, fechaAyerPeru, formatFecha, ultimoDiaMes, mesActual, anioActual, mE,
      netoPrompt, historialConv, planUsuario,
      enviarWhatsapp, notificarErrorAdmin, registrarError,
      CATEGORIAS_VALIDAS, CATEGORIA_MAP, validarMonto, normalizarCategoria,
      getEmojiCategoria, formatearResumen, formatearPendientes, formatearCategoriasMsg,
      barraProgreso, generarRefCode,
      obtenerTipoCambio, guardarTransaccion, obtenerGastosMes, obtenerGastosSemana,
      obtenerUltimaTransaccion, recategorizarTransaccion, corregirTransaccionEspecifica,
      guardarReglaComercio, retroaplicarRegla, obtenerConsultasPendientes,
      guardarPresupuesto, obtenerPresupuestosMes, verificarAlertaPresupuesto, formatearEstadoPresupuesto,
      parsearCorreoBancario, parsearRegistroManual, parsearCorreccionesMultiples,
      obtenerCuentasGmail,
      generarRecomendaciones, construirDatosUsuario, generarMiniRecomendacion,
      registrarDeuda, obtenerDeudas, abonarDeuda, marcarDeudaPagada,
      formatearResumenDeudas, consolidarDeudasPorContraparte, saldarTodasDeudas,
      obtenerMetasService, abonarMetaService, calcularRitmoAhorro,
      registrarLogro, obtenerLogros, verificarRachaAportes,
      obtenerCategoriasUsuario, detectarCategoriaIA, crearCategoriaLibreUsuario,
      redactarConNETO, escanearGmailYRegistrar, generarYEnviarReporte,
      guardarMensaje, obtenerHistorial, getUserPlanConfig, getHistoryDateLimit,
    };

    const handler = getHandler(intencion);
    if (handler) {
      return await handler({ intencion, msg, datos, usuario, from, ctx });
    }

    // === Default/fallback (no handler found) ===
    if (/\d/.test(msg) && msg.length > 8) {
      try {
        const resultado = await parsearCorreoBancario(msg);
        if (resultado.monto && resultado.monto > 0) {
          await guardarTransaccion(usuario.id, resultado);
          let resp = '\uD83D\uDCB3 *Transaccion registrada*\n' + (resultado.tipo === 'gasto' ? 'Gasto' : 'Ingreso') + ': S/ ' + resultado.monto + '\nComercio: ' + (resultado.comercio || 'No detectado') + '\nCategoria: ' + (resultado.categoria || 'Sin categoria');
          if (resultado.tipo === 'gasto' && resultado.categoria) { const alerta = await verificarAlertaPresupuesto(usuario.id, resultado.categoria, null); if (alerta) resp += '\n\n' + alerta; }
          return resp + '\n\n_Escribe "mis gastos del mes" para ver el resumen._';
        }
      } catch(e) { log.warn({ tag: 'FALLBACK_TX', err: e.message }, 'Error en fallback transaccion'); }
    }
    // Log NLP desconocido para revisión admin
    supabase.from('nlp_errors').insert({
      usuario_id: usuario.id, whatsapp: from,
      mensaje: msg.substring(0, 500), intencion: intencion || 'desconocido',
      error_tipo: 'desconocido', error_detalle: 'Mensaje no clasificado por NLP'
    }).then(() => {}).catch(() => {});
    const ctxDef = 'El usuario envio un mensaje que no encaja claramente con ninguna intencion: "' + msg + '". Responde en tono NETO: reconoce el mensaje, ofrece ayuda concreta con los gastos o finanzas del usuario.';
    const respDef = await redactarConNETO(netoPrompt, ctxDef, msg, historialConv);
    return respDef || 'No entendi bien, pero estoy aqui. Escribe _"cuanto gaste esta semana"_ o _"dame mi reporte"_ y arrancamos. ¿Que necesitas?';
  } catch(e) {
    log.error({ tag: 'NLP', err: e.message }, 'Error en procesamiento NLP'); notificarErrorAdmin('NLP', e.message); registrarError('NLP', e.message, { stack: e.stack, whatsapp: from });
    // Log NLP error para revisión admin
    supabase.from('nlp_errors').insert({
      usuario_id: usuario ? usuario.id : null, whatsapp: from,
      mensaje: msg.substring(0, 500), intencion: null,
      error_tipo: 'error', error_detalle: e.message
    }).then(() => {}).catch(() => {});
    return 'Tuve un problema. Intenta de nuevo.';
  }
}

module.exports = { procesarMensajeLibre };
