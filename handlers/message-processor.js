const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { hoyPeru, ayerPeru, ultimoDiaMes } = require('../lib/dates');
const fechaHoyPeru = () => hoyPeru();
const fechaAyerPeru = () => ayerPeru();
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP, WEBAPP_URL } = require('../lib/constants');
const { validarMonto, normalizarCategoria } = require('../lib/validators');
const { ADMIN_NUMBER } = require('../lib/config');
const { esVerUltimoMovimiento } = require('../lib/nlp-guards');
const { getEmojiCategoria, formatearResumen, formatearCategoriasMsg, barraProgreso, generarRefCode, formatFecha } = require('../lib/formatters');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { obtenerTipoCambio, guardarTransaccion, obtenerGastosMes, obtenerGastosSemana, obtenerUltimaTransaccion, recategorizarTransaccion, corregirTransaccionEspecifica, guardarReglaComercio, retroaplicarRegla } = require('../services/transactions');
const { guardarPresupuesto, obtenerPresupuestosMes, verificarAlertaPresupuesto, formatearEstadoPresupuesto } = require('../services/budget');
const { parsearCorreoBancario, parsearRegistroManual, parsearCorreccionesMultiples } = require('../services/parsers');
const { detectarMultiGasto, detectarIngresoMasGastos } = require('../services/multi-gasto-detector');
const { notificarAdmin, notificarErrorAdmin } = require('../lib/admin-notify');
const { registrarError } = require('../lib/error-monitor');
const { obtenerCuentasGmail } = require('../gmail');
const { generarRecomendaciones, construirDatosUsuario, generarMiniRecomendacion } = require('../services/recommendations');
const { registrarDeuda, obtenerDeudas, abonarDeuda, marcarDeudaPagada, formatearResumenDeudas, consolidarDeudasPorContraparte, saldarTodasDeudas } = require('../services/debts');
const { obtenerMetas: obtenerMetasService, abonarMeta: abonarMetaService, calcularRitmoAhorro, registrarLogro, obtenerLogros, verificarRachaAportes } = require('../services/metas');
const { obtenerCategoriasUsuario, detectarCategoriaIA, crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario } = require('../services/categories');
const { redactarConNETO } = require('../services/neto-gpt');
const { escanearGmailYRegistrar } = require('../services/gmail-scanner');
const { guardarMensaje, obtenerHistorial, getUserPlanConfig, getHistoryDateLimit } = require('../helpers/db-helpers');
const { getHandler } = require('./intent-registry');
const { NETO_TOOLS, mapToolToIntent } = require('./neto-tools');
const { construirNetoPrompt } = require('../lib/neto-prompt');
const { obtenerSesionAbierta } = require('../lib/support-tickets');

/**
 * Salvage sin IA: cuando OpenAI está caído (429) el pipeline normal no puede clasificar,
 * pero no queremos perder el registro del usuario (caso Ricardo: "4.10 pastillas" nunca se
 * guardó). Extrae un gasto/ingreso simple por regex y lo guarda en categoría genérica.
 * Best-effort: si no hay monto claro, devuelve null y el flujo cae al mensaje de reintento.
 */
async function salvarGastoSinIA(msg, usuario) {
  try {
    const texto = (msg || '').trim();
    const m = texto.match(/(\d+(?:[.,]\d{1,2})?)/); // primer número con hasta 2 decimales
    if (!m) return null;
    const monto = parseFloat(m[1].replace(',', '.'));
    if (!isFinite(monto) || monto <= 0 || monto > 999999) return null;
    const esIngreso = /\b(cobr[eé]|me\s+pagaron|me\s+pag[oó]|sueldo|salario|dep[oó]sito|recib[ií]|abono)\b/i.test(texto);
    let comercio = texto
      .replace(m[0], ' ')
      .replace(/\b(gast[eé]|pagu[eé]|compr[eé]|me\s+prest[eé]|en|de|por|soles?|s\/\.?|pen)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    if (comercio.length > 40) comercio = comercio.slice(0, 40);
    const fecha = fechaHoyPeru();
    const datos = {
      monto, moneda: 'PEN', comercio: comercio || 'Sin comercio',
      categoria: esIngreso ? 'Finanzas' : 'Otros', subcategoria: 'sin_categoria',
      tipo: esIngreso ? 'ingreso' : 'gasto', fecha, descripcion_original: texto.substring(0, 200),
    };
    await guardarTransaccion(usuario.id, datos);
    return '✅ S/' + monto.toFixed(2) + ' en ' + datos.categoria + (comercio ? ' · ' + comercio : '') + ' · ' + formatFecha(fecha) +
      '\n\n_Lo registré al toque porque estábamos con mucho tráfico. Si la categoría no es "' + datos.categoria + '", dime y la corrijo._';
  } catch (e) {
    log.warn({ tag: 'SALVAGE_TX', err: e.message }, 'No se pudo salvar gasto sin IA');
    return null;
  }
}

async function procesarMensajeLibre(msg, usuario, from) {
  try {
    // === Modo soporte: si hay una sesión abierta, TODO mensaje va al admin (no al bot) ===
    // La sesión se abre por "quiero hablar con soporte" (NLP) o /soporte, y sigue abierta
    // hasta que se cierre (/salir del usuario, /cerrar del admin, botón del panel, o
    // autocierre por 48h de inactividad). Ver lib/support-tickets.
    const sesionSoporte = await obtenerSesionAbierta(usuario.id);
    if (sesionSoporte) {
      const esPrimerMensaje = sesionSoporte.estado === 'esperando_mensaje';
      await supabase.from('tickets_soporte').update({
        mensaje_usuario: msg.substring(0, 1000),
        estado: 'pendiente',
        updated_at: new Date().toISOString(),
      }).eq('id', sesionSoporte.id);

      const encabezado = esPrimerMensaje ? '🎫 *Nuevo ticket de soporte*' : '💬 *Mensaje en conversación de soporte*';
      const textoAdmin = encabezado + '\n\n'
        + '👤 ' + (usuario.nombre || 'Sin nombre') + '\n'
        + '📱 ' + from + '\n'
        + '📋 Plan: ' + (usuario.tipo_plan || usuario.plan || 'free') + '\n\n'
        + '💬 *Mensaje:*\n' + msg.substring(0, 500) + '\n\n'
        + '_Responde con:_\n/responder ' + from + ' [tu mensaje]\n'
        + '_Cerrar la conversación:_\n/cerrar ' + from;
      await notificarAdmin(textoAdmin);

      return esPrimerMensaje
        ? '✅ *Recibido.*\n\nTu mensaje llegó al equipo de Neto. Te responderemos por este mismo chat.\n\n_Escribe */salir* cuando quieras volver al asistente, o escríbenos a 📧 hola@neto.pe_'
        : '📨 *Enviado al equipo.*\n\nSeguimos en tu conversación de soporte, te responderemos pronto.\n\n_Escribe */salir* para terminar y volver al asistente._';
    }

    const hoyParts = hoyPeru().split('-');
    const mesActual = parseInt(hoyParts[1], 10);
    const anioActual = parseInt(hoyParts[0], 10);
    const planUsuario = usuario.plan || 'free';
    const mE = ['','Enero','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    // Cargar NETO system prompt con datos del usuario (docs/NETO_system_prompt.txt, cacheado).
    // El correo conectado decide si NETO puede decir que lee correos bancarios: el token puede
    // estar en `usuarios` (legacy) o solo en `gmail_cuentas` (multi-cuenta), hay que mirar ambos.
    let correoConectado = !!usuario.gmail_access_token;
    if (!correoConectado) {
      try { correoConectado = (await obtenerCuentasGmail(usuario.id)).length > 0; }
      catch(e) { log.warn({ tag: 'NETO_PROMPT', err: e.message }, 'No se pudo verificar Gmail; asumo sin correo'); }
    }
    const netoPrompt = construirNetoPrompt({
      nombre: usuario.nombre,
      plan: planUsuario,
      mesesHistorial: 3,
      correoConectado,
      ultimaSync: usuario.updated_at ? new Date(usuario.updated_at).toLocaleDateString('es-PE') : 'hoy',
    });

    // Cargar historial de conversacion del usuario
    const historialConv = await obtenerHistorial(usuario.id);

    // Guardar mensaje del usuario en historial
    await guardarMensaje(usuario.id, 'usuario', msg);

    // Medición (T2): si el usuario responde dentro de 7d de un mensaje proactivo, marcar
    // ese survey_event como respondido. Fire-and-forget: nunca bloquea el flujo entrante.
    require('../services/survey-triggers').marcarRespuestaProactiva(usuario.id, msg).catch(() => {});

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

    // === Detector de ingreso + lista de gastos (str-006) ===
    // Cubre el patrón "Ingresé/gané/cobré/recibí NUMBER ..., gasté X en A, Y en B y Z en C".
    // Fanout: 1 ingreso + N gastos. Si el detector retorna null, sigue al detector de
    // multi-gasto homogéneo y al pipeline normal de OpenAI.
    const ingresoMasGastos = detectarIngresoMasGastos(msg);
    if (ingresoMasGastos) {
      log.info({ tag: 'INCOME_PLUS_EXPENSES', expenses: ingresoMasGastos.expenses.length, income: ingresoMasGastos.income.monto, msg: msg.substring(0, 80) }, 'Ingreso + gastos detectado, fanout');
      const fechaTx = /\bayer\b/i.test(msg) ? fechaAyerPeru() : fechaHoyPeru();
      const respuestasIE = [];
      try {
        const datosIngreso = {
          monto: ingresoMasGastos.income.monto, moneda: 'PEN', comercio: 'Ingreso',
          categoria: 'Finanzas', subcategoria: 'sin_categoria',
          tipo: 'ingreso', fecha: fechaTx,
          descripcion_original: msg.substring(0, 200),
        };
        await guardarTransaccion(usuario.id, datosIngreso);
        respuestasIE.push('✅ S/' + ingresoMasGastos.income.monto.toFixed(2) + ' en Ingresos · ' + formatFecha(fechaTx));
      } catch(e) {
        log.warn({ tag: 'INCOME_PLUS_EXPENSES', err: e.message }, 'Falló registro de ingreso');
      }
      for (const g of ingresoMasGastos.expenses) {
        try {
          const detCat = await detectarCategoriaIA('gasté ' + g.monto + ' en ' + g.comercio, usuario.id);
          const datosTx = {
            monto: g.monto, moneda: 'PEN', comercio: g.comercio,
            categoria: detCat.categoria || 'Otros',
            subcategoria: detCat.subcategoria || 'sin_categoria',
            tipo: 'gasto', fecha: fechaTx,
            descripcion_original: msg.substring(0, 200),
          };
          const txIE = await guardarTransaccion(usuario.id, datosTx);
          // Categoría/subcategoría normalizadas por guardarTransaccion, no la salida cruda del parser.
          const catIE = (txIE && txIE.categoria) || datosTx.categoria;
          const subIE = (txIE && txIE.subcategoria) || datosTx.subcategoria;
          let lineResp = '✅ S/' + g.monto.toFixed(2) + ' en ' + catIE + ' > ' + subIE + ' · ' + formatFecha(fechaTx);
          try {
            const alerta = await verificarAlertaPresupuesto(usuario.id, datosTx.categoria, datosTx.subcategoria);
            if (alerta) lineResp += '\n' + alerta;
          } catch(eAlert) { /* alert is best-effort */ }
          respuestasIE.push(lineResp);
        } catch(e) {
          log.warn({ tag: 'INCOME_PLUS_EXPENSES', err: e.message, item: g }, 'Falló item de gasto');
        }
      }
      if (respuestasIE.length > 0) {
        const respFull = respuestasIE.join('\n');
        await guardarMensaje(usuario.id, 'neto', respFull.substring(0, 500));
        return respFull;
      }
      // Si todos fallaron, dejar continuar al pipeline normal de OpenAI
    }

    // === Detector de multi-gasto explícito (mlt-001/002) ===
    // Si el msg lista 2+ gastos con verbo + (monto + en/de/por + sustantivo) + separador,
    // los registramos secuencialmente sin pasar por OpenAI Function Calling
    // (que solo procesa tool_calls[0] y descarta el resto).
    const multiGastos = detectarMultiGasto(msg);
    if (multiGastos && multiGastos.length >= 2) {
      log.info({ tag: 'MULTI_GASTO', count: multiGastos.length, msg: msg.substring(0, 80) }, 'Multi-gasto detectado, fanout');
      const fechaGasto = /\bayer\b/i.test(msg) ? fechaAyerPeru() : fechaHoyPeru();
      const respuestas = [];
      for (const g of multiGastos) {
        try {
          const detCat = await detectarCategoriaIA('gasté ' + g.monto + ' en ' + g.comercio, usuario.id);
          const datosTx = {
            monto: g.monto, moneda: 'PEN', comercio: g.comercio,
            categoria: detCat.categoria || 'Otros',
            subcategoria: detCat.subcategoria || 'sin_categoria',
            tipo: 'gasto', fecha: fechaGasto,
            descripcion_original: msg.substring(0, 200),
          };
          const txMG = await guardarTransaccion(usuario.id, datosTx);
          // Categoría/subcategoría normalizadas por guardarTransaccion, no la salida cruda del parser.
          const catMG = (txMG && txMG.categoria) || datosTx.categoria;
          const subMG = (txMG && txMG.subcategoria) || datosTx.subcategoria;
          let lineResp = '✅ S/' + g.monto.toFixed(2) + ' en ' + catMG + ' > ' + subMG + ' · ' + formatFecha(fechaGasto);
          try {
            const alerta = await verificarAlertaPresupuesto(usuario.id, datosTx.categoria, datosTx.subcategoria);
            if (alerta) lineResp += '\n' + alerta;
          } catch(eAlert) { /* alert is best-effort */ }
          respuestas.push(lineResp);
        } catch(e) {
          log.warn({ tag: 'MULTI_GASTO', err: e.message, item: g }, 'Falló item de multi-gasto');
        }
      }
      if (respuestas.length > 0) {
        const respFull = respuestas.join('\n');
        await guardarMensaje(usuario.id, 'neto', respFull.substring(0, 500));
        return respFull;
      }
      // Si todos los items fallaron, dejar continuar al pipeline normal de OpenAI
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
            + 'Si dice "el último movimiento", "mi último gasto/movimiento", "cuál fue lo último que registré", "muéstrame la última transacción" (SIN verbo de borrar) = query_analytics action=last_movement. Es SOLO mostrar el último registro. NUNCA lo interpretes como deshacer/eliminar aunque diga "último". '
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
            + '- "Cuanto pago/gasto en suscripciones (al mes)", "mis suscripciones", "ver suscripciones", "cuanto me cuestan mis pagos recurrentes" = query_analytics action=subscriptions. El detector de fugas (spending_alerts action=view) es SOLO para "en que se me va la plata", "detecta fugas", "donde estoy botando/perdiendo plata", alertas o anomalias de gasto — NUNCA para consultar cuanto paga en suscripciones.\n'
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

    // Guard "último movimiento": ver el último movimiento es SOLO lectura. Antes "el último
    // movimiento" se clasificaba como deshacer_ultimo y borraba el gasto (caso Edgar, 23-jun:
    // pidió ver, Neto le borró Deysi S/9.90 y lo perdió como usuario). Si el mensaje pide ver
    // el último movimiento/transacción y NO trae verbo de borrado, forzar el intent de ver.
    if (esVerUltimoMovimiento(msg) && DESTRUCTIVE_INTENTS.has(intencion)) {
      log.warn({ tag: 'NLP_GUARD', intencion, msg: msgTrim.slice(0, 120) }, 'Redirected "último movimiento" from destructive to read-only view');
      intencion = 'ver_ultima_transaccion';
      datos = {};
    }

    log.info({ tag: 'NLP', intencion, datos }, 'Intención clasificada');


    // === Intent dispatch via registry ===
    const ctx = {
      supabase, openai, log, hoyPeru, fechaHoyPeru, fechaAyerPeru, formatFecha, ultimoDiaMes, mesActual, anioActual, mE,
      netoPrompt, historialConv, planUsuario,
      enviarWhatsapp, notificarErrorAdmin, registrarError,
      CATEGORIAS_VALIDAS, CATEGORIA_MAP, validarMonto, normalizarCategoria,
      getEmojiCategoria, formatearResumen, formatearCategoriasMsg,
      barraProgreso, generarRefCode,
      obtenerTipoCambio, guardarTransaccion, obtenerGastosMes, obtenerGastosSemana,
      obtenerUltimaTransaccion, recategorizarTransaccion, corregirTransaccionEspecifica,
      guardarReglaComercio, retroaplicarRegla,
      guardarPresupuesto, obtenerPresupuestosMes, verificarAlertaPresupuesto, formatearEstadoPresupuesto,
      parsearCorreoBancario, parsearRegistroManual, parsearCorreccionesMultiples,
      obtenerCuentasGmail,
      generarRecomendaciones, construirDatosUsuario, generarMiniRecomendacion,
      registrarDeuda, obtenerDeudas, abonarDeuda, marcarDeudaPagada,
      formatearResumenDeudas, consolidarDeudasPorContraparte, saldarTodasDeudas,
      obtenerMetasService, abonarMetaService, calcularRitmoAhorro,
      registrarLogro, obtenerLogros, verificarRachaAportes,
      obtenerCategoriasUsuario, detectarCategoriaIA, crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario,
      redactarConNETO, escanearGmailYRegistrar,
      guardarMensaje, obtenerHistorial, getUserPlanConfig, getHistoryDateLimit,
    };

    const handler = getHandler(intencion);
    if (handler) {
      const r1 = await handler({ intencion, msg, datos, usuario, from, ctx });
      // Multi-intent heterogéneo: si el msg tiene conjunción y la parte2 representa
      // un intent distinto (query/edit/register), dispatchearlo vía el registry.
      // Cubre mlt-003/004/005. Ver services/multi-intent-splitter.js
      try {
        const { detectarContinuacion } = require('../services/multi-intent-splitter');
        const cont = detectarContinuacion(msg, intencion);
        if (cont) {
          const handlerCont = getHandler(cont.intencion);
          if (handlerCont) {
            log.info({ tag: 'MULTI_INTENT_CONT', from: intencion, to: cont.intencion, parte2: cont.parte2.substring(0, 80) }, 'Compound continuation');
            const r2 = await handlerCont({ intencion: cont.intencion, msg: cont.parte2, datos: cont.datos, usuario, from, ctx });
            if (r2 && typeof r2 === 'string') return (r1 || '') + '\n\n' + r2;
          }
        }
      } catch(eCont) { log.warn({ tag: 'MULTI_INTENT_CONT', err: eCont.message }, 'Continuation failed'); }
      return r1;
    }

    // === Default/fallback (no handler found) ===
    if (/\d/.test(msg) && msg.length > 8) {
      try {
        let categoriasCustomFb = null;
        try { categoriasCustomFb = await require('../services/categories').obtenerCategoriasUsuario(usuario.id); }
        catch(e) { /* fall back to canonical */ }
        const resultado = await parsearCorreoBancario(msg, undefined, categoriasCustomFb);
        if (resultado.monto && resultado.monto > 0) {
          const txFb = await guardarTransaccion(usuario.id, resultado);
          const catFb = (txFb && txFb.categoria) || resultado.categoria;
          let resp = '\uD83D\uDCB3 *Transaccion registrada*\n' + (resultado.tipo === 'gasto' ? 'Gasto' : 'Ingreso') + ': S/ ' + resultado.monto + '\nComercio: ' + (resultado.comercio || 'No detectado') + '\nCategoria: ' + (catFb || 'Sin categoria');
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
    // No decimos "no entendi": casi siempre se entendio y el mensaje simplemente esta fuera
    // de ambito. Se acota el alcance y se dan ejemplos copiables, sin redactar con IA.
    return 'Eso se me escapa. Lo mío son tus gastos.\n\nPrueba con _"gasté 40 en el mercado"_, _"cuanto gaste esta semana"_ o _"dame mi reporte"_.';
  } catch(e) {
    const errMsg = e && e.message ? e.message : String(e);
    // Un 429 de OpenAI NO es un error de NLP: es saturación temporal de la organización.
    // Antes se perdía el gasto del usuario y encima inflaba la métrica de NLP con 163 filas.
    // Ahora: (1) salvar el gasto con parser local sin IA, (2) loguear como 'rate_limit'
    // (separado de NLP real), (3) NO notificar al admin (era spam de 163 alertas en la ráfaga).
    const isRateLimit = /rate limit|rate_limit|\b429\b|too many requests/i.test(errMsg);
    if (isRateLimit) {
      const salvado = usuario ? await salvarGastoSinIA(msg, usuario) : null;
      supabase.from('nlp_errors').insert({
        usuario_id: usuario ? usuario.id : null, whatsapp: from,
        mensaje: msg.substring(0, 500), intencion: null,
        error_tipo: 'rate_limit', error_detalle: errMsg
      }).then(() => {}).catch(() => {});
      log.warn({ tag: 'NLP_RATE_LIMIT', salvado: !!salvado, whatsapp: from }, 'OpenAI 429 en NLP');
      if (salvado) return salvado;
      return 'Estamos con mucho tráfico ahora mismo. Reenvía tu mensaje en unos segundos y lo registro. 🙏';
    }

    log.error({ tag: 'NLP', err: errMsg }, 'Error en procesamiento NLP'); notificarErrorAdmin('NLP', errMsg); registrarError('NLP', errMsg, { stack: e.stack, whatsapp: from });
    // Log NLP error para revisión admin
    supabase.from('nlp_errors').insert({
      usuario_id: usuario ? usuario.id : null, whatsapp: from,
      mensaje: msg.substring(0, 500), intencion: null,
      error_tipo: 'error', error_detalle: errMsg
    }).then(() => {}).catch(() => {});
    return 'Tuve un problema. Intenta de nuevo.';
  }
}

module.exports = { procesarMensajeLibre };
