const fs = require('fs');
const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { hoyPeru, ayerPeru, ultimoDiaMes } = require('../lib/dates');
const fechaHoyPeru = () => hoyPeru();
const fechaAyerPeru = () => ayerPeru();
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP, WEBAPP_URL } = require('../lib/constants');
const { validarMonto, normalizarCategoria } = require('../lib/validators');
const { ADMIN_NUMBER } = require('../lib/config');
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
const { obtenerCategoriasUsuario, detectarCategoriaIA, crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario } = require('../services/categories');
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

    // === Detector de operaciones complejas/bulk → sugerir dashboard ===
    const msgLower = msg.toLowerCase();
    const BULK_PATTERNS = [
      // "cambia estos N gastos" / "actualiza estos N"
      /cambia\s+estos\s+\d+/,
      /actualiza\s+estos\s+\d+/,
      /corrige\s+estos\s+\d+/,
      // lista de varios ítems separados por coma/y (3+)
      /(?:cambia|mueve|pon|pasa|recategoriza|corrige)(?:[^.]{0,80}(?:,|\sy\s)){2,}/,
      // "los últimos N gastos" + verbo de edición
      /(?:los?\s+)?[úu]ltimos?\s+\d{1,2}\s+gastos?.{0,50}(?:cambia|mueve|pon|pasa|recategoriza|corrige)/,
      /(?:cambia|mueve|pon|pasa|recategoriza|corrige).{0,50}(?:los?\s+)?[úu]ltimos?\s+\d{1,2}\s+gastos?/,
      // "todos los gastos de X" + verbo
      /todos\s+los\s+(?:gastos?\s+)?de\s+\w.{0,60}(?:cambia|mueve|pon|pasa|a\s+\w)/,
      // corregir/cambiar varios comercios de una vez (más de 2 en mismo msg)
      /(?:cambia|pon|mueve|pasa)\s+(?:el\s+de\s+\w+.{0,40}){3,}/,
    ];
    const esBulk = BULK_PATTERNS.some(p => p.test(msgLower));
    if (esBulk) {
      log.info({ tag: 'DASHBOARD_SUGGEST', msg: msg.substring(0, 120) }, 'Bulk op detected, suggesting dashboard');
      const sugerencia = '💡 Para cambios múltiples es mucho más rápido usar el dashboard:\n\n'
        + '👉 ' + WEBAPP_URL + '/dashboard/transacciones\n\n'
        + 'Desde ahí puedes filtrar, seleccionar varios gastos y editarlos de una vez.\n'
        + '_¿Quieres que te ayude con algo más puntual por acá?_';
      await guardarMensaje(usuario.id, 'neto', sugerencia.substring(0, 500));
      return sugerencia;
    }

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
            + 'Si quiere ELIMINAR un gasto (action=delete), DEBES extraer el monto exacto que mencione el usuario (y el comercio si aparece). El usuario suele referenciar con "el de S/18.70" o "el gasto de 41": en ambos casos pasa monto=18.70 o monto=41. Si solo hay comercio sin monto, pasa comercio; nunca inventes montos. '
            + 'Si dice "deshacer", "deshazlo", "deshacer último", "ctrl z", "cancela lo último", "revierte", usa manage_transaction con action=undo. '
            + 'Si dice "restaura", "restablece", "devuélvemelo", "trae de vuelta el gasto", "recupera el gasto", usa manage_transaction con action=restore (NO delete, NO undo). Extrae monto/comercio si los menciona. '
            + 'NUNCA uses action=delete, action=undo ni action=restore si el mensaje termina en signo de pregunta ("?"): eso es una consulta, no una orden — usa social_response o financial_query. '
            + 'Si responde con "si", "no", "dale", "ok" a algo que preguntaste antes, usa social_response con action=greeting (se manejara como continuacion). '
            + 'Extrae montos, fechas, comercios y categorias del lenguaje natural del usuario. '
            + 'Para fechas relativas: "ayer" = restar 1 dia a hoy, "el lunes" = calcular fecha correcta.\n'
            + 'REGLAS EXTRA:\n'
            + '- "Soy Pro o Free", "que plan tengo", "soy premium" = manage_account action=account_status (NO view_premium).\n'
            + '- "Me clavaron", "me bajaron", "me cobraron", "me descuadre" + monto = gasto → register_transaction.\n'
            + '- "Me cayeron", "me pagaron", "gane", "recibi" + monto = ingreso → register_transaction con es_ingreso=true.\n'
            + '- "Le pague X a Y ya esta limpio/saldado/quedamos a mano" = manage_debts action=mark_paid (NO register).\n'
            + '- "Ya le pague TODO a [X]", "le pague todo lo que le debia a [X]" = manage_debts action=settle_all. SOLO settle_all cuando hay verbo de pago + "todo" + persona. "Junta/consolida/agrupa todas las deudas con [X]" = action=consolidate (NO settle_all).\n'
            + '- "Cuanto va el mes" (sin categoria) = query_expenses action=total.\n'
            + '- "Cuanto me queda este mes", "cuanto me sobra", "cuanto tengo disponible", "supere mi presupuesto?" = manage_budget action=balance (NO query_expenses).\n'
            + '- "Como estuvo [mes] vs [mes]", "[mes] vs el anterior", "comparar [mes] con [mes]" = query_analytics action=compare_months.\n'
            + '- "Mandame el resumen de [mes]", "reporte de [mes]" = generate_report action=report (NO share_summary).\n'
            + '- "Es viable ahorrar X en Y meses/tiempo", "puedo ahorrar X en Y" = manage_goals action=viability.\n'
            + '- "Saca el gasto de X", "borra el de X", "quita el de X", "gasto duplicado" = manage_transaction action=delete.\n'
            + '- "causa" en mensajes = jerga peruana para "porque/ya que", no cambia el intent. Ej: "elimina ese gasto causa estaba mal" = manage_transaction action=delete.\n'
            + '- "Eran X no Y", "son X no Y", "fueron X no Y" = correccion de monto → manage_transaction action=edit_amount (NO register_transaction).\n'
            + '- "Cambialo/ponlo a X soles" sin mencion de cambio de moneda = manage_transaction action=edit_amount (NO edit_amount_currency). Solo edit_amount_currency cuando hay cambio explicito de moneda ("fueron dolares no soles").\n'
            + '- "El gasto de [X] ponlo en [Y]", "el gasto de [X] va en [Y]", "pon lo de [X] en [Y]", "mueve el de [X] a [Y]" = manage_transaction action=recategorize (cambiar categoria de transaccion especifica, NO set_category_rule).\n'
            + '- "Cambia todos los de [X] a [Y]", "todos los de [X] pasalos a [Y]", "los [X] cambia a [Y]" = manage_transaction action=batch_recategorize (NO set_category_rule).\n'
            + '- "Asocia [X] a [Y]", "siempre que vaya a [X] ponlo en [Y]" = manage_transaction action=set_category_rule (regla permanente para comercio).\n'
            + '- "Sugiere donde recortar gastos", "en que puedo recortar", "que recorto para ahorrar" = manage_goals action=suggest_cuts.\n'
            + '- "me preste" en mensajes = jerga peruana para "pague/gaste" (ej: "me preste 30 taxi" = gaste 30 en taxi) → register_transaction.\n'
            + '- "[Gasto] fue [fecha]", "fue ayer no hoy", "fue el viernes", "fue antier" = manage_transaction action=edit_date.\n'
            + '- "Cambia eso a dolares", "fueron X dolares no soles" = manage_transaction action=edit_amount_currency.\n'
            + '- "El comercio es X", "ponle comercio X" = manage_transaction action=edit_store.\n'
            + '- "Le pague X a Y de lo que le debia", "le di X a Y de lo que debo" = manage_debts action=pay (abonar deuda, NO registrar nueva).\n'
            + '- "Que gastos puedo eliminar para llegar a mi meta" = manage_goals action=view (NO financial_query).\n'
            + '- "Que incluye el plan", "cuanto cuesta Pro" = manage_account action=view_premium.\n'
            + '- "Comparte mi resumen" = generate_report action=share_summary.\n'
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

    // Safety net: nunca ejecutar acciones destructivas si el mensaje es una pregunta
    const DESTRUCTIVE_INTENTS = new Set(['eliminar_transaccion', 'deshacer_ultimo', 'eliminar_meta', 'eliminar_presupuesto']);
    const msgTrim = (msg || '').trim();
    const esPregunta = msgTrim.endsWith('?') || msgTrim.endsWith('¿');
    if (esPregunta && DESTRUCTIVE_INTENTS.has(intencion)) {
      log.warn({ tag: 'NLP_GUARD', intencion, msg: msgTrim.slice(0, 120) }, 'Blocked destructive intent on question');
      intencion = 'desconocido';
      datos = {};
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
      obtenerCategoriasUsuario, detectarCategoriaIA, crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario,
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
        let categoriasCustomFb = null;
        try { categoriasCustomFb = await require('../services/categories').obtenerCategoriasUsuario(usuario.id); }
        catch(e) { /* fall back to canonical */ }
        const resultado = await parsearCorreoBancario(msg, undefined, categoriasCustomFb);
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
