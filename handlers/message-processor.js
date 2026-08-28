const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { subcategoriaUtil } = require('../lib/subcategoria');
const { hoyPeru, ayerPeru, ultimoDiaMes } = require('../lib/dates');
const fechaHoyPeru = () => hoyPeru();
const fechaAyerPeru = () => ayerPeru();
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP, WEBAPP_URL } = require('../lib/constants');
const { validarMonto, normalizarCategoria } = require('../lib/validators');
const { ADMIN_NUMBER } = require('../lib/config');
const { esVerUltimoMovimiento, extraerGastoSinIA } = require('../lib/nlp-guards');
const { getEmojiCategoria, formatearResumen, formatearCategoriasMsg, barraProgreso, generarRefCode, formatFecha } = require('../lib/formatters');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { obtenerTipoCambio, guardarTransaccion, obtenerGastosMes, obtenerGastosSemana, obtenerUltimaTransaccion, recategorizarTransaccion, corregirTransaccionEspecifica, guardarReglaComercio, retroaplicarRegla } = require('../services/transactions');
const { guardarPresupuesto, obtenerPresupuestosMes, verificarAlertaPresupuesto, formatearEstadoPresupuesto } = require('../services/budget');
const { parsearCorreoBancario, parsearRegistroManual, parsearCorreccionesMultiples } = require('../services/parsers');
const { detectarMultiGasto, detectarIngresoMasGastos } = require('../services/multi-gasto-detector');
const { notificarAdmin, notificarErrorAdmin } = require('../lib/admin-notify');
const { registrarError, esOpenAISinCreditos } = require('../lib/error-monitor');
const { obtenerCuentasGmail } = require('../gmail');
const { generarRecomendaciones, construirDatosUsuario, generarMiniRecomendacion } = require('../services/recommendations');
const { registrarDeuda, obtenerDeudas, abonarDeuda, marcarDeudaPagada, formatearResumenDeudas, consolidarDeudasPorContraparte, saldarTodasDeudas } = require('../services/debts');
const { obtenerMetas: obtenerMetasService, abonarMeta: abonarMetaService, calcularRitmoAhorro, registrarLogro, obtenerLogros, verificarRachaAportes } = require('../services/metas');
const { obtenerCategoriasUsuario, detectarCategoriaIA, crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario, asegurarCategoriaUsuario } = require('../services/categories');
const { redactarConNETO } = require('../services/neto-gpt');
const { escanearGmailYRegistrar } = require('../services/gmail-scanner');
const { guardarMensaje, obtenerHistorial, getUserPlanConfig, getHistoryDateLimit } = require('../helpers/db-helpers');
const { dispatchIntent } = require('./intent-registry');
const { NETO_TOOLS, mapToolToIntent } = require('./neto-tools');
const { construirNetoPrompt } = require('../lib/neto-prompt');
const { obtenerSesionAbierta, registrarMensajeTicket } = require('../lib/support-tickets');
const { colaConfirmacionGasto } = require('../lib/trial');

/**
 * Salvage sin IA: cuando OpenAI está caído (429) el pipeline normal no puede clasificar,
 * pero no queremos perder el registro del usuario (caso Ricardo: "4.10 pastillas" nunca se
 * guardó). Guarda en categoría genérica lo que `extraerGastoSinIA` haya podido reconstruir.
 * Best-effort: si el mensaje no es un registro reconocible, devuelve null y el flujo cae al
 * mensaje de reintento.
 *
 * Esta función ya NO decide qué es un gasto: eso vive en `lib/nlp-guards.js`, que es puro y
 * se prueba solo. Acá queda persistir y redactar.
 *
 * El monto no se valida acá a propósito: `guardarTransaccion` llama a `validarMonto` y lanza
 * si no pasa, así que duplicar el techo en este archivo crea dos topes que pueden divergir.
 * `extraerGastoSinIA` ya descarta lo que no es un número usable.
 */
async function salvarGastoSinIA(msg, usuario) {
  try {
    const extraido = extraerGastoSinIA(msg);
    if (!extraido) return null;
    const { monto, moneda, tipo, comercio } = extraido;
    const fecha = fechaHoyPeru();
    const datos = {
      monto, moneda, comercio: comercio || 'Sin comercio',
      categoria: tipo === 'ingreso' ? 'Finanzas' : 'Otros', subcategoria: 'sin_categoria',
      tipo, fecha, descripcion_original: (msg || '').trim().substring(0, 200),
    };
    await guardarTransaccion(usuario.id, datos);
    // El símbolo sigue a la moneda detectada. Antes decía "S/" siempre, así que un gasto
    // en dólares se confirmaba con el símbolo equivocado además de guardarse mal.
    const simbolo = moneda === 'USD' ? '$' : 'S/';
    return '✅ ' + simbolo + monto.toFixed(2) + ' en ' + datos.categoria + (comercio ? ' · ' + comercio : '') + ' · ' + formatFecha(fecha) +
      '\n\n_Lo registré al toque porque estábamos con mucho tráfico. Si la categoría no es "' + datos.categoria + '", dime y la corrijo._';
  } catch (e) {
    log.warn({ tag: 'SALVAGE_TX', err: e.message }, 'No se pudo salvar gasto sin IA');
    return null;
  }
}

/**
 * ¿NETO puede decir que lee correos bancarios? El token puede estar en `usuarios` (legacy) o
 * solo en `gmail_cuentas` (multi-cuenta), hay que mirar ambos.
 *
 * El token legacy corta primero y sin ir a la DB. Igual el round-trip a `gmail_cuentas` es el
 * caso COMÚN (3 de 102 usuarios tienen Gmail), y por eso esta función viaja en el Promise.all
 * del arranque en vez de estar sola en el camino crítico: un round-trip para un booleano que
 * casi siempre sale false.
 */
async function resolverCorreoConectado(usuario) {
  if (usuario.gmail_access_token) return true;
  try {
    return (await obtenerCuentasGmail(usuario.id)).length > 0;
  } catch (e) {
    log.warn({ tag: 'NETO_PROMPT', err: e.message }, 'No se pudo verificar Gmail; asumo sin correo');
    return false;
  }
}

async function procesarMensajeLibre(msg, usuario, from) {
  try {
    // Las tres lecturas del arranque son independientes entre sí y antes costaban tres
    // round-trips EN SERIE sobre el camino de cada mensaje entrante.
    //
    // El INSERT del turno actual (`guardarMensaje`, más abajo) NO entra acá y no es un olvido:
    // tiene que ocurrir DESPUÉS de que `obtenerHistorial` resolvió, o el mensaje del usuario
    // aparecería dos veces en el contexto del LLM (una en el historial, otra como último turno).
    const [sesionSoporte, correoConectado, historialConv] = await Promise.all([
      obtenerSesionAbierta(usuario.id),
      resolverCorreoConectado(usuario),
      obtenerHistorial(usuario.id),
    ]);

    // === Modo soporte: si hay una sesión abierta, TODO mensaje va al admin (no al bot) ===
    // La sesión se abre por "quiero hablar con soporte" (NLP) o /soporte, y sigue abierta
    // hasta que se cierre (/salir del usuario, /cerrar del admin, botón del panel, o
    // autocierre por 48h de inactividad). Ver lib/support-tickets.
    if (sesionSoporte) {
      const esPrimerMensaje = sesionSoporte.estado === 'esperando_mensaje';
      // El hilo + la columna de último mensaje, por un solo escritor (migración 079). Antes
      // era un UPDATE suelto que PISABA el mensaje anterior: de una conversación de cinco
      // turnos sobrevivía uno, así que el panel no podía mostrar lo que se dijo.
      await registrarMensajeTicket({
        ticketId: sesionSoporte.id, rol: 'usuario', mensaje: msg,
        patchExtra: { estado: 'pendiente' },
      });

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
    // `correoConectado` se resolvió arriba, en el Promise.all del arranque.
    const netoPrompt = construirNetoPrompt({
      nombre: usuario.nombre,
      plan: planUsuario,
      mesesHistorial: 3,
      correoConectado,
      ultimaSync: usuario.updated_at ? new Date(usuario.updated_at).toLocaleDateString('es-PE') : 'hoy',
    });

    // Guardar mensaje del usuario en historial. Va DESPUÉS de que `obtenerHistorial` resolvió
    // (arriba, en el Promise.all): al revés, el turno actual entraría dos veces en el contexto
    // que se le manda al LLM.
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
      // NO se guarda la respuesta acá: el único escritor de la fila 'neto' es
      // `handlers/webhook.js`, que guarda lo que esta función devuelve. Los cuatro
      // `guardarMensaje` que había en este archivo producían la fila DOS veces (P′9: el
      // 7.2% de las filas 'neto' eran duplicados a menos de 5s). No era solo ruido en la
      // tabla — `obtenerHistorial` lee las últimas 6 y se las manda al clasificador, así
      // que cada turno duplicado le comía la mitad del contexto.
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
      let conteoTxIE = 0;   // el conteo del último insert = total del usuario
      // El trial lo arranca el PRIMER insert del fanout, no el último: hay que
      // acarrear la señal o la cola anunciaría el muro sobre un trial recién dado.
      let txTrialIE = null;
      try {
        const datosIngreso = {
          monto: ingresoMasGastos.income.monto, moneda: 'PEN', comercio: 'Ingreso',
          categoria: 'Finanzas', subcategoria: 'sin_categoria',
          tipo: 'ingreso', fecha: fechaTx,
          descripcion_original: msg.substring(0, 200),
        };
        const txIngIE = await guardarTransaccion(usuario.id, datosIngreso);
        if (txIngIE && txIngIE.trialIniciado) txTrialIE = txIngIE;
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
          // El árbol del usuario crece también por acá (B26). Sin esto, el MISMO gasto dicho
          // como lista ("gasté 20 en taxi y 30 en cine") clasifica bien pero no deja la
          // categoría en `/categorias` ni en el selector de presupuestos, mientras dicho suelto
          // sí — el árbol quedaba distinto según cómo se escribió el mensaje.
          asegurarCategoriaUsuario(usuario.id, datosTx.categoria)
            .then(() => (subcategoriaUtil(datosTx.subcategoria)
              ? crearSubcategoriaLibreUsuario(usuario.id, datosTx.categoria, datosTx.subcategoria) : null))
            .catch(() => {});
          const txIE = await guardarTransaccion(usuario.id, datosTx);
          if (txIE && txIE.conteoTx) conteoTxIE = txIE.conteoTx;
          if (txIE && txIE.trialIniciado) txTrialIE = txIE;
          // Categoría/subcategoría normalizadas por guardarTransaccion, no la salida cruda del parser.
          const catIE = (txIE && txIE.categoria) || datosTx.categoria;
          const subIE = subcategoriaUtil((txIE && txIE.subcategoria) || datosTx.subcategoria);
          let lineResp = '✅ S/' + g.monto.toFixed(2) + ' en ' + catIE + (subIE ? ' > ' + subIE : '') + ' · ' + formatFecha(fechaTx);
          try {
            const alerta = await verificarAlertaPresupuesto(usuario, datosTx.categoria, datosTx.subcategoria);
            if (alerta) lineResp += '\n' + alerta;
          } catch(eAlert) { /* alert is best-effort */ }
          respuestasIE.push(lineResp);
        } catch(e) {
          log.warn({ tag: 'INCOME_PLUS_EXPENSES', err: e.message, item: g }, 'Falló item de gasto');
        }
      }
      if (respuestasIE.length > 0) {
        let respFull = respuestasIE.join('\n');
        const nudgeIE = await colaConfirmacionGasto(usuario, txTrialIE, conteoTxIE);
        if (nudgeIE) respFull += nudgeIE;
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
      let conteoTxMG = 0;   // el conteo del último insert = total del usuario
      let txTrialMG = null; // el trial lo arranca el primer insert, no el último
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
          // Igual que en el fanout de ingreso+gastos: el árbol crece también por acá (B26).
          asegurarCategoriaUsuario(usuario.id, datosTx.categoria)
            .then(() => (subcategoriaUtil(datosTx.subcategoria)
              ? crearSubcategoriaLibreUsuario(usuario.id, datosTx.categoria, datosTx.subcategoria) : null))
            .catch(() => {});
          const txMG = await guardarTransaccion(usuario.id, datosTx);
          if (txMG && txMG.conteoTx) conteoTxMG = txMG.conteoTx;
          if (txMG && txMG.trialIniciado) txTrialMG = txMG;
          // Categoría/subcategoría normalizadas por guardarTransaccion, no la salida cruda del parser.
          const catMG = (txMG && txMG.categoria) || datosTx.categoria;
          const subMG = subcategoriaUtil((txMG && txMG.subcategoria) || datosTx.subcategoria);
          let lineResp = '✅ S/' + g.monto.toFixed(2) + ' en ' + catMG + (subMG ? ' > ' + subMG : '') + ' · ' + formatFecha(fechaGasto);
          try {
            const alerta = await verificarAlertaPresupuesto(usuario, datosTx.categoria, datosTx.subcategoria);
            if (alerta) lineResp += '\n' + alerta;
          } catch(eAlert) { /* alert is best-effort */ }
          respuestas.push(lineResp);
        } catch(e) {
          log.warn({ tag: 'MULTI_GASTO', err: e.message, item: g }, 'Falló item de multi-gasto');
        }
      }
      if (respuestas.length > 0) {
        let respFull = respuestas.join('\n');
        const nudgeMG = await colaConfirmacionGasto(usuario, txTrialMG, conteoTxMG);
        if (nudgeMG) respFull += nudgeMG;
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
      obtenerCategoriasUsuario, detectarCategoriaIA, crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario, asegurarCategoriaUsuario,
      redactarConNETO, escanearGmailYRegistrar,
      guardarMensaje, obtenerHistorial, getUserPlanConfig, getHistoryDateLimit,
    };

    // === Dispatch (con el muro de lectura adentro) ========================
    // El gate del muro NO vive acá: vive en `dispatchIntent`, que es el único camino por
    // el que un intent se convierte en una llamada al handler. Estaba inline en este
    // punto y por eso se evaluaba UNA vez, con la intención del LLM maestro, mientras la
    // continuación de abajo y los redirects de `registrar_manual` despachaban OTRA
    // intención sin pasar por él (hallazgo M21). Ver handlers/muro-gate.js.
    const d1 = await dispatchIntent({ intencion, msg, datos, usuario, from, ctx });
    if (d1.manejado) {
      const r1 = d1.respuesta;
      // Multi-intent heterogéneo: si el msg tiene conjunción y la parte2 representa
      // un intent distinto (query/edit/register), dispatchearlo vía el registry.
      // Cubre mlt-003/004/005. Ver services/multi-intent-splitter.js
      //
      // Dos motivos para NO despachar la continuación:
      //
      //  · `d1.muro` — la primera parte murió en el muro; encadenarle otro handler solo
      //    repetiría el mismo mensaje. Hoy es inalcanzable (las tres intenciones que
      //    producen continuación están fijadas como LIBRES por `intents-acceso.test.js`)
      //    pero está cubierto igual, con el splitter mockeado, porque el día que deje de
      //    serlo el síntoma es una lectura de más, no un error.
      //  · `ctx.redirigidoAQuery` — el handler de la primera parte YA resolvió el mensaje
      //    entero como query (los redirects de `registrar_manual`). La parte 2 está adentro
      //    de esa query, así que la continuación la resolvería de nuevo: mismo handler dos
      //    veces, dos filas en `conversaciones` y —en el muro— dos mensajes del muro pegados.
      //    Se descubrió en la revisión adversarial de este mismo fix.
      if (!d1.muro && !ctx.redirigidoAQuery) try {
        const { detectarContinuacion } = require('../services/multi-intent-splitter');
        const cont = detectarContinuacion(msg, intencion);
        if (cont) {
          log.info({ tag: 'MULTI_INTENT_CONT', from: intencion, to: cont.intencion, parte2: cont.parte2.substring(0, 80) }, 'Compound continuation');
          // `usuario` se leyó al entrar al pipeline, o sea ANTES de que la parte 1 escribiera
          // nada. Si esa escritura arrancó el trial, la fila en memoria sigue diciendo
          // plan='free' y `estaEnMuro` la da por amurallada, así que la parte 2 recibiría el
          // muro que esta misma persona acaba de dejar atrás. Se sincronizan las DOS columnas
          // porque `enTrial()` exige las dos y mirar una sola es cómo se construyen las
          // pantallas que se contradicen (ver lib/trial.js).
          if (ctx.trialRecienIniciado) {
            // Las CUATRO columnas que escribe `iniciarTrialSiCorresponde` y que algún
            // predicado lee, no solo las dos que deciden el muro. Dejar `trial_vence` sin
            // poner arma justo la fila parcial que este repo prohíbe: `enTrial()` daría true
            // con `trial_vence` en null, y `diasRestantesTrial()` devuelve null sobre eso.
            // Hoy ningún destino de la continuación lo lee, pero "hoy no es alcanzable" es
            // como se construyen las filas que mienten mañana.
            usuario.plan = 'premium';
            usuario.trial_estado = 'activo';
            usuario.trial_vence = ctx.trialRecienIniciado.vence;
            usuario.premium_vence = null;   // invariante de la migración 052
          }
          const d2 = await dispatchIntent({ intencion: cont.intencion, msg: cont.parte2, datos: cont.datos, usuario, from, ctx });
          // Cuando la parte 2 muere en el muro, la respuesta queda con la confirmación del
          // gasto (que para alguien amurallado ya trae `nudgeMuro`: total del mes + link) y
          // encima el `mensajeMuro` con precio y el mismo link. Es redundante y se evaluó
          // suprimir el segundo cartel. NO se hizo, y conviene dejar escrito por qué:
          //
          //  · suprimirlo solo es correcto SI la confirmación trae el nudge, o sea que la
          //    corrección de este archivo pasaría a depender de una rama de `lib/trial.js`
          //    que nadie fuerza desde acá. El día que ese nudge cambie, esto se traga el
          //    "no" del muro en silencio, que es el modo de falla que este repo ya conoce.
          //  · el argumento fuerte para suprimir era que a la rama dominante del muro
          //    (`trial_estado` null) el texto le promete "14 días gratis, se activan cuando
          //    registres tu próximo gasto" justo a quien acaba de registrar uno. Con la
          //    sincronización de arriba ese caso ya no llega hasta acá: su gasto arrancó el
          //    trial y `d2.muro` es false. Los que sí llegan son 'vencido' y 'convertido',
          //    a quienes el mensaje les dice algo verdadero y útil.
          //
          // O sea que lo que quedaba era una redundancia cosmética en un camino que en
          // producción no ocurrió nunca, contra acoplar el gate de ingresos a otro archivo.
          // NO se compara `d2.respuesta` con `r1` para "no repetir": una continuación
          // register+register con las dos mitades idénticas produce la misma confirmación
          // a propósito, y esconderla deja al usuario con DOS gastos guardados y UN ✅
          // — o sea reenviando el mensaje y triplicando.
          if (d2.manejado && d2.respuesta && typeof d2.respuesta === 'string') {
            return (r1 || '') + '\n\n' + d2.respuesta;
          }
        }
      } catch(eCont) { log.warn({ tag: 'MULTI_INTENT_CONT', err: eCont.message }, 'Continuation failed'); }
      return r1;
    }

    // === Default/fallback (no handler found) ===
    if (/\d/.test(msg) && msg.length > 8) {
      try {
        let categoriasCustomFb = null;
        // Degradar al arbol canonico esta bien —el fallback igual clasifica— pero el catch
        // era mudo, y desde este commit `obtenerCategoriasUsuario` lanza cuando la lectura
        // cae: sin el log, ese fallo entraba por la misma puerta que "este usuario no tiene
        // arbol propio", que es justo la confusion que se vino a cerrar.
        try { categoriasCustomFb = await require('../services/categories').obtenerCategoriasUsuario(usuario.id); }
        catch(e) { log.warn({ tag: 'CATEGORIAS', usuarioId: usuario.id, err: e.message }, 'No se pudo leer el arbol: el fallback clasifica solo con las canonicas'); }
        const resultado = await parsearCorreoBancario(msg, undefined, categoriasCustomFb);
        if (resultado.monto && resultado.monto > 0) {
          const txFb = await guardarTransaccion(usuario.id, resultado);
          const catFb = (txFb && txFb.categoria) || resultado.categoria;
          let resp = '\uD83D\uDCB3 *Transaccion registrada*\n' + (resultado.tipo === 'gasto' ? 'Gasto' : 'Ingreso') + ': S/ ' + resultado.monto + '\nComercio: ' + (resultado.comercio || 'No detectado') + '\nCategoria: ' + (catFb || 'Sin categoria');
          if (resultado.tipo === 'gasto' && resultado.categoria) { const alerta = await verificarAlertaPresupuesto(usuario, resultado.categoria, null); if (alerta) resp += '\n\n' + alerta; }
          resp += '\n\n_Escribe "mis gastos del mes" para ver el resumen._';
          const nudgeFb = await colaConfirmacionGasto(usuario, txFb, txFb && txFb.conteoTx);
          if (nudgeFb) resp += nudgeFb;
          return resp;
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
      const sinCreditos = esOpenAISinCreditos(errMsg);
      log.warn({ tag: 'NLP_RATE_LIMIT', salvado: !!salvado, sinCreditos, whatsapp: from }, 'OpenAI 429 en NLP');
      if (salvado) return salvado;
      // El texto depende de la CAUSA, no del código: los dos casos son 429 (ver
      // `esOpenAISinCreditos`). Con la cuenta sin saldo, "reenvía en unos segundos" es una
      // promesa imposible: `salvarGastoSinIA` es pura y determinista, así que el mismo texto
      // reenviado cae en la misma rama, y OpenAI no vuelve hasta que alguien pague. Mandar a
      // alguien a reintentar para siempre es peor que decirle que la falla es nuestra.
      //
      // La webapp SÍ es una salida real acá y no otra promesa vacía: se verificó que
      // `webapp/src/app/api/transactions/route.ts` no llama a OpenAI, así que anotar a mano
      // funciona con la IA caída.
      if (sinCreditos) {
        return 'Ahora mismo no puedo leer tu mensaje. Es un problema nuestro, no tuyo, y reintentar no lo va a resolver. Ya quedó registrado de nuestro lado.\n\nSi quieres anotarlo ya, puedes hacerlo desde https://app.neto.pe';
      }
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
