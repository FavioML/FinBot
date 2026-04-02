const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { hoyPeru, ultimoDiaMes } = require('../lib/dates');
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('../lib/constants');
const { validarMonto, normalizarCategoria } = require('../lib/validators');
const { getEmojiCategoria, formatearResumen, formatearPendientes, formatearCategoriasMsg, barraProgreso, generarRefCode } = require('../lib/formatters');
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

    // Construir contexto del historial para el clasificador
    const histCtx = historialConv.length > 0
      ? '\n\nHISTORIAL RECIENTE (ultimos mensajes de la conversacion):\n' +
        historialConv.slice(-4).map(h => (h.rol === 'neto' ? 'NETO: ' : 'Usuario: ') + h.mensaje.substring(0, 120)).join('\n')
      : '';

    const clasificacion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'Eres el clasificador de intenciones de NETO, bot de finanzas personales por WhatsApp para usuarios peruanos.\nEl mes actual es ' + mE[mesActual] + ' ' + anioActual + '.\n\nAnaliza el mensaje y devuelve SOLO JSON.\n\nINTENCIONES:\n1. "listar_gastos_mes" - ver resumen/lista de gastos del mes\n   Ej: "cuales son mis gastos", "que gaste este mes", "gastos registrados", "que tengo registrado", "mis compras", "transacciones"\n   Datos: mes (numero, default=mes_actual), anio\n\n2. "listar_gastos_semana" - gastos de los ultimos 7 dias\n   Ej: "que gaste esta semana", "gastos recientes", "mis compras de los ultimos dias"\n\n2b. "listar_gastos_dia" - gastos de HOY o de un dia especifico\n   Ej: "que gaste hoy", "gastos de hoy", "resumen de hoy", "resumen del dia", "que compre hoy", "movimientos de hoy", "gastos de ayer", "que gaste ayer"\n   Datos: fecha (null si dice "hoy" o "del dia" — el sistema calcula la fecha real. Solo poner fecha YYYY-MM-DD si el usuario menciona una fecha especifica como "el 15 de marzo").\n\n3. "listar_gastos_categoria" - gastos de UNA categoria especifica\n   Ej: "que hay en Otros", "gastos de Alimentación", "que esta en Transporte", "detalle de Hogar", "cuales estan en otros"\n   Datos: categoria (nombre exacto), mes (default=mes_actual)\n\n4. "ver_total_gastado" - saber el TOTAL numerico gastado\n   Ej: "cuanto gaste", "cuanto llevo gastado", "total de gastos"\n   Datos: periodo ("semana" o "mes"), categoria (o null)\n\n5. "ver_presupuesto" - ver estado del presupuesto\n   Ej: "como va mi presupuesto", "cuanto me queda", "mis limites"\n\n6. "configurar_presupuesto" - configurar limite de gasto\n   Ej: "pon limite de 500 en comida", "presupuesto de 300 para transporte"\n   Datos: categoria, monto\n\n7. "ver_categorias" - ver categorias configuradas del sistema\n   Ej: "que categorias hay", "muestra las categorias del sistema"\n   IMPORTANTE: Si el historial muestra que NETO estaba hablando de gastos por categoria, NO usar esta intencion\n\n8. "ver_reporte" - reporte PDF\n   Ej: "dame mi reporte", "informe mensual", "reporte de marzo", "genera pdf"\n   Datos: mes (default=mes_actual), anio\n\n9. "corregir_categoria" - cambiar categoria de un gasto\n   Ej: "netflix es streaming", "cambia uber a transporte", "ponlo en Hogar", "muevelo a Delivery", "este gasto es de Comida", "ponlo en la categoria NETO", "categorizalo en Trabajo", "muevelo a Herramientas", "regístralo en alimentación", "es alimentación porque compré pan", "ponlo en comida", "es de transporte"\n   IMPORTANTE: Usar cuando el usuario quiere mover/cambiar/reclasificar un gasto a cualquier categoria (incluso una categoría personalizada no canónica como "NETO", "Mascota", etc). comercio puede ser null. También usar cuando el historial muestra que NETO acaba de registrar un gasto (desde imagen o notificación) y el usuario corrige la categoría.\n   Datos: comercio (null si no se menciona), categoria_nueva (el nombre de la categoria), subcategoria_nueva (null si no se menciona, o el nombre exacto de la subcategoria)\n\n10. "ver_pendientes" - gastos sin identificar\n    Ej: "gastos pendientes", "que no identificaste", "gastos sin categoria"\n\n11. "escanear_gmail" - escanear correos\n    Ej: "escanea mi correo", "busca transacciones nuevas", "hay correos nuevos"\n\n12. "ver_premium" - info del plan premium\n    Ej: "cuanto cuesta premium", "que incluye el plan"\n\n13. "saludo" - saludo sin intencion especifica\n    Ej: "buenos dias", "que tal", "como estas"\n\n14. "ayuda" - pide ayuda\n    Ej: "que puedes hacer", "ayuda", "como funciona"\n\n15. "registrar_manual" - el usuario quiere registrar un gasto o ingreso NUEVO\n   Ej: "gaste 50 soles en farmacia", "anota S/120 en ropa", "mi sueldo fue S/4500", "cobré S/800 de honorarios", "registra un ingreso de S/3500", "pague 200 en gasolina ayer"\n   IMPORTANTE: NO usar si el historial muestra que NETO acaba de notificar un gasto existente y el usuario está corrigiendo su moneda o monto (ej: "el gasto es USD 95", "son dolares", "el importe es 25 USD" → usar corregir_monto_moneda).\n   Datos: ninguno (se parsea el mensaje completo)\n\n16. "desconocido" - no encaja con ninguna intencion clara, o es continuacion de conversacion\n    Usar cuando: el mensaje es "si", "no", "dale", "ok", "mas", o cualquier respuesta corta a algo que NETO pregunto\n\n17. "corregir_monto_moneda" - el usuario indica que la moneda o monto de un gasto YA REGISTRADO está incorrecto\n   Ej: "el gasto es en dolares", "es en USD no en soles", "corrígelo son $25", "el monto es USD 25", "son 25 dolares", "el importe es en dolares", "eso es en USD", "el gasto es USD 95.07", "cambiale la moneda a dolares", "es dolar no sol"\n   IMPORTANTE: Solo cuando el historial muestra que se habla de un gasto existente ya notificado por NETO.\n   Datos: monto (numero o null), moneda ("USD" o "PEN" o null)\n\n18. "corregir_multiple" - el usuario da 2 o más instrucciones de corrección de categoría en el mismo mensaje, cada una referenciando un comercio/gasto diferente\n   Ej: "Netflix pasalo a Entretenimiento · Uber a Transporte · BCP comision a Finanzas", "E S NEUQUEN pasalo a gasolina\\nEdita Pal menu\\nEdita Pal (18/03) pasalo a menu"\n   IMPORTANTE: Usar cuando hay CLARAMENTE múltiples correcciones distintas en el mensaje (2+). Si solo hay una, usar corregir_categoria.\n   Datos: ninguno (se parsea el mensaje completo)\n\n19. "agregar_gmail" - el usuario quiere conectar una cuenta Gmail adicional (ya tiene una conectada)\n   Ej: "quiero agregar otro correo", "conectar una segunda cuenta de gmail", "agregar otro gmail", "tengo otro correo que quiero añadir"\n   Datos: ninguno\n\n20. "cambiar_gmail" - el usuario quiere reemplazar/cambiar su cuenta Gmail actual\n   Ej: "quiero cambiar mi cuenta", "me equivoqué de correo", "cambiar el gmail", "reconectar mi correo", "el correo que puse está mal", "quiero usar otro gmail"\n   Datos: ninguno\n\n21. "preferencia_reporte_gmail" - el usuario quiere configurar si sus reportes son unificados o separados por cuenta Gmail\n   Ej: "quiero los reportes separados por cuenta", "unifica mis correos en un solo reporte", "muéstrame por separado cada gmail"\n   Datos: modo ("unificado" o "separado")\n\n22. "cargar_excel" - el usuario quiere cargar gastos historicos desde un archivo Excel o quiere la plantilla\n   Ej: "quiero cargar mis gastos", "como subo mi historial", "tengo un Excel con mis gastos", "plantilla de gastos", "cargar gastos antiguos", "importar gastos"\n   Datos: ninguno\n\n23. "desconectar_cuenta" - el usuario quiere desconectar su cuenta, eliminar sus datos o darse de baja\n   Ej: "quiero desconectar mi cuenta", "eliminar mi cuenta", "borrar mis datos", "quiero darme de baja", "desconectar gmail", "eliminar todo", "ya no quiero usar Neto", "quiero salir", "desactivar mi cuenta"\n   Datos: ninguno\n\n24. "ver_referidos" - el usuario quiere referir amigos, ver su link de referido, o preguntar por el programa de referidos\n   Ej: "quiero referir a alguien", "mi link de referido", "como invito amigos", "programa de referidos", "quiero invitar a un amigo", "como refiero", "compartir neto", "recomendar neto", "mis referidos", "ganar pro gratis", "referir amigos", "como gano meses gratis"\n   Datos: ninguno\n\n25. "ver_recomendaciones" - el usuario quiere consejos financieros, saber como mejorar, donde se excede, como subir su score, o recomendaciones\n   Ej: "como mejoro mis finanzas", "donde me estoy excediendo", "como subo mi score", "dame recomendaciones", "en que puedo mejorar", "que dias gasto mas", "donde puedo ahorrar", "analiza mis gastos", "que ajusto", "tips para ahorrar", "como estoy financieramente", "que puedo mejorar"\n   Datos: tipo ("score" si pregunta por score, "excesos" si pregunta donde se excede, "general" si pide recomendaciones generales, "patrones" si pregunta por dias/patrones)\n\n26. "comparar_meses" - el usuario quiere comparar gastos entre dos meses o con el mes anterior\n   Ej: "gaste mas este mes?", "compara marzo con febrero", "como voy vs el mes pasado", "comparacion de meses", "febrero vs marzo", "me fue mejor este mes?", "gasto mas o menos que antes"\n   Datos: mes1 (numero, default=mes_actual), mes2 (numero, default=mes_anterior), anio1, anio2\n\n27. "buscar_gasto" - el usuario busca gastos de un comercio o lugar especifico\n   Ej: "cuanto gaste en Uber", "busca mis pagos de Netflix", "gastos en Plaza Vea", "que pague en Rappi", "pagos a Movistar", "cuanto llevo en gasolina"\n   IMPORTANTE: Diferente de listar_gastos_categoria. Aqui el usuario menciona un COMERCIO o servicio especifico, no una categoria.\n   Datos: comercio (nombre del comercio/servicio), mes (default=mes_actual), anio\n\n28. "ver_ingresos" - el usuario quiere ver sus ingresos (sueldo, cobros, ventas)\n   Ej: "cuanto gane este mes", "mis ingresos", "cuanto me pagaron", "ingresos de marzo", "cuanto cobre", "mi sueldo", "entradas de dinero"\n   Datos: periodo ("mes" o "semana"), mes (default=mes_actual), anio\n\n29. "ver_balance" - el usuario quiere saber su balance (ingresos menos gastos)\n   Ej: "cuanto me queda", "estoy en rojo", "mi balance", "como estoy de plata", "me alcanza", "saldo del mes", "cuanto tengo disponible", "estoy bien o mal"\n   Datos: mes (default=mes_actual), anio\n\n30. "ver_suscripciones" - ver pagos recurrentes y suscripciones activas\n   Ej: "mis suscripciones", "que pago mensual", "servicios que pago", "pagos recurrentes", "cuanto gasto en suscripciones", "cuantas suscripciones tengo"\n   Datos: ninguno\n\n31. "ver_tipo_cambio" - consultar tipo de cambio USD/PEN\n   Ej: "a cuanto esta el dolar", "tipo de cambio", "precio del dolar", "cuanto esta el dolar hoy", "tc", "cambio de dolar a sol"\n   Datos: ninguno\n\n32. "editar_monto" - corregir el monto de un gasto ya registrado (sin cambiar moneda)\n   Ej: "el monto es 50 no 500", "corrige a S/120", "el monto real es 35", "no es 100 es 10", "el monto esta mal, son 80 soles"\n   IMPORTANTE: Diferente de corregir_monto_moneda (que cambia la MONEDA). Aqui solo se corrige el numero del monto en la misma moneda.\n   Datos: monto_nuevo (numero)\n\n33. "editar_fecha" - corregir la fecha de un gasto ya registrado\n   Ej: "ese gasto fue ayer", "cambialo al 15 de marzo", "la fecha es el 20", "no fue hoy, fue el viernes", "corrige la fecha al 10"\n   Datos: fecha_nueva (YYYY-MM-DD o "ayer" o dia del mes)\n\n34. "editar_comercio" - corregir el nombre del comercio de un gasto\n   Ej: "el comercio es Plaza Vea", "no es PV, es Plaza Vea", "el nombre correcto es Sodimac", "cambia el comercio a Wong"\n   Datos: comercio_nuevo (nombre correcto)\n\n35. "dividir_gasto" - dividir un gasto entre varias personas/partes\n   Ej: "divide entre 3", "mitad es mio", "split entre 2", "solo me toca la tercera parte", "dividelo entre 4 personas", "pagamos a medias"\n   Datos: partes (numero, ej: 2 para mitad, 3 para tercios)\n\n36. "duplicar_gasto" - registrar un gasto igual al ultimo\n   Ej: "registra otro igual", "lo mismo para hoy", "repite el ultimo gasto", "otro igual", "lo mismo pero de hoy"\n   Datos: fecha (YYYY-MM-DD o null para hoy)\n\n37. "ver_metas" - ver estado de las metas de ahorro\n   Ej: "como van mis metas", "mi meta de ahorro", "cuanto me falta para mi meta", "progreso de mis metas", "mis objetivos"\n   Datos: ninguno\n\n38. "crear_meta" - crear una nueva meta de ahorro\n   Ej: "quiero ahorrar 5000 para julio", "meta de ahorro de 2000 soles", "crear meta para viaje", "ahorrar para navidad 3000"\n   Datos: nombre (descripcion corta), monto (numero), fecha_limite (YYYY-MM-DD o mes/anio)\n\n39. "agradecimiento" - el usuario agradece o felicita a NETO\n   Ej: "gracias", "gracias neto", "eres crack", "genial", "excelente", "buenazo", "eres lo mejor", "que bueno", "perfecto gracias", "chevere"\n   Datos: ninguno\n\n40. "queja" - el usuario se queja o reporta un problema\n   Ej: "no funciona", "esto esta mal", "no me lee los correos", "hay un error", "no jala", "esta fallando", "no me registra", "no sirve", "tengo un problema"\n   IMPORTANTE: Solo cuando es claramente una queja sobre el funcionamiento. Si dice "no" como respuesta a una pregunta → usar "desconocido".\n   Datos: ninguno\n\n41. "chiste_finanzas" - el usuario pide humor o entretenimiento\n   Ej: "cuentame un chiste", "hazme reir", "dime algo gracioso", "un chiste de plata", "animate", "dime un dato curioso"\n   Datos: ninguno\n\n42. "exportar_datos" - el usuario quiere exportar/descargar sus datos\n   Ej: "quiero mis datos en excel", "exportar todo", "descargar mis gastos", "bajar mi historial", "quiero un backup de mis datos", "dame mis datos"\n   Datos: ninguno\n\n43. "cambiar_nombre" - el usuario quiere cambiar su nombre en el sistema\n   Ej: "mi nombre es Juan", "cambiame el nombre", "no me llamo asi", "ponme Pedro", "mi nombre correcto es Maria", "llamame Carlos"\n   IMPORTANTE: Solo cuando el usuario EXPLICITAMENTE dice su nombre o pide cambiarlo. No confundir con editar_comercio.\n   Datos: nombre_nuevo (el nombre correcto)\n\n44. "ver_gasto_mayor" - el gasto mas grande/caro del mes\n   Ej: "cual fue mi gasto mas grande", "mi gasto mas caro", "el mayor gasto del mes", "donde gaste mas"\n   Datos: mes (default=mes_actual), anio\n\n45. "ver_gasto_menor" - el gasto mas pequeño/barato del mes\n   Ej: "cual es mi gasto mas chiquito", "el menor gasto", "lo mas barato que compre", "mi gasto mas pequeño"\n   Datos: mes (default=mes_actual), anio\n\n46. "ver_promedio_diario" - promedio de gasto diario\n   Ej: "cuanto gasto al dia", "mi promedio diario", "gasto promedio", "cuanto gasto en promedio"\n   Datos: mes (default=mes_actual)\n\n47. "ver_frecuencia_comercio" - cuantas veces compro en un comercio especifico y total\n   Ej: "cuantas veces fui a Rappi", "cuantos pagos en Uber", "frecuencia de Netflix", "cuantas compras en Plaza Vea"\n   IMPORTANTE: Diferente de buscar_gasto (que lista gastos). Aqui pregunta por FRECUENCIA/CONTEO.\n   Datos: comercio (nombre del comercio)\n\n48. "ver_gastos_rango_fecha" - gastos en un rango de fechas especifico\n   Ej: "gastos del 1 al 15", "transacciones de la quincena", "gastos entre el 5 y el 20", "primera quincena", "segunda quincena"\n   Datos: fecha_inicio (YYYY-MM-DD), fecha_fin (YYYY-MM-DD)\n\n49. "ver_gastos_fin_de_semana" - cuanto gasta en fines de semana (sabado y domingo)\n   Ej: "cuanto gasto los fines de semana", "gastos de sabado y domingo", "fin de semana cuanto me sale", "mis gastos del finde"\n   Datos: mes (default=mes_actual)\n\n50. "deshacer_ultimo" - deshacer/cancelar el ultimo registro sin especificar cual\n   Ej: "deshaz eso", "cancela el ultimo", "me equivoque", "undo", "borra el ultimo", "quita eso"\n   IMPORTANTE: Diferente de eliminar_transaccion (que requiere comercio o especificacion). Este es genérico: "deshaz lo ultimo".\n   Datos: ninguno\n\n51. "editar_categoria_comercio" - crear una REGLA permanente para que un comercio siempre vaya a una categoria\n   Ej: "todo lo de Rappi siempre va en Delivery", "Netflix siempre es Entretenimiento", "cuando sea Uber ponlo en Transporte", "Rappi siempre delivery"\n   IMPORTANTE: Diferente de corregir_categoria (que corrige UNA transaccion). Aqui se crea una REGLA permanente.\n   Datos: comercio (nombre), categoria (categoria destino)\n\n52. "marcar_como_ingreso" - cambiar un gasto ya registrado a ingreso (o viceversa)\n   Ej: "eso no es gasto, es ingreso", "es un cobro no un pago", "marcalo como ingreso", "ese es ingreso", "no es gasto sino cobro", "es una venta"\n   Datos: tipo_nuevo ("ingreso" o "gasto")\n\n53. "eliminar_presupuesto" - eliminar/quitar un presupuesto existente\n   Ej: "quita el limite de comida", "borra el presupuesto de transporte", "elimina presupuesto de delivery", "ya no quiero limite en salud"\n   Datos: categoria (nombre de la categoria)\n\n54. "editar_meta" - modificar una meta de ahorro existente\n   Ej: "sube mi meta a 3000", "cambia la fecha de mi meta", "actualiza mi meta de viaje", "la meta ahora es 5000"\n   Datos: nombre (nombre de la meta, null si solo tiene una), monto_nuevo (numero o null), fecha_nueva (YYYY-MM-DD o null)\n\n55. "eliminar_meta" - eliminar una meta de ahorro\n   Ej: "borra la meta de viaje", "ya no quiero esa meta", "elimina mi meta", "quita la meta de navidad"\n   Datos: nombre (nombre de la meta, null si solo tiene una)\n\n56. "abonar_meta" - agregar dinero/abono a una meta de ahorro existente\n   Ej: "abone 500 a mi meta", "agrega 200 a mi ahorro", "deposite 1000 para mi viaje", "meti 300 a la meta", "ahorre 500"\n   IMPORTANTE: Diferente de registrar_manual. Aqui el dinero va a una META, no es un gasto ni ingreso.\n   Datos: monto (numero), nombre_meta (nombre de la meta o null si solo tiene una)\n\n57. "consulta_financiera" - pregunta sobre conceptos financieros peruanos\n   Ej: "que es un CTS", "como funciona una AFP", "me conviene un deposito a plazo", "que es la gratificacion", "como funciona la ONP", "que son los fondos mutuos", "que es TEA", "que significa TCEA"\n   Datos: ninguno\n\n58. "calcular_cuotas" - calcular cuanto pagaria en cuotas con intereses\n   Ej: "si pago 1500 en 12 cuotas cuanto sale", "cuanto de interes me cobran", "cuotas de 3000 soles", "quiero saber cuanto pago en 6 cuotas", "calcula las cuotas de 2000"\n   Datos: monto (numero), cuotas (numero de cuotas, default=12), tasa (TEA porcentaje o null, default=45)\n\n59. "recordatorio_pago" - quiere que le recuerden pagar algo en cierta fecha\n   Ej: "recuerdame pagar la luz el 15", "avisame del agua el 20", "recordatorio de pago", "no me dejes olvidar pagar el internet"\n   Datos: concepto (que pagar), dia (dia del mes)\n\n60. "convertir_moneda" - convertir un monto entre USD y PEN\n   Ej: "cuanto es 50 dolares en soles", "convierte 200 USD a PEN", "100 soles a dolares", "pasa 500 dolares a soles", "50 usd en pen"\n   IMPORTANTE: Diferente de ver_tipo_cambio (que solo muestra la tasa). Aqui el usuario quiere convertir un MONTO especifico.\n   Datos: monto (numero), moneda_origen ("USD" o "PEN"), moneda_destino ("PEN" o "USD")\n\n61. "feedback" - el usuario da sugerencias, ideas o feedback sobre Neto\n   Ej: "estaria bueno que", "podrias agregar", "sugiero que", "me gustaria que", "una idea", "deberian poner", "falta que"\n   Datos: ninguno\n\n62. "estado_cuenta" - el usuario pregunta por su cuenta, plan, o estado de suscripcion\n   Ej: "que plan tengo", "cuando vence mi pro", "mi cuenta", "estado de mi suscripcion", "soy free o pro", "cuanto me queda de pro", "mi perfil"\n   IMPORTANTE: Diferente de ver_premium (que muestra INFO del plan Pro). Aqui el usuario pregunta por SU estado actual.\n   Datos: ninguno\n\n63. "silenciar" - el usuario quiere desactivar recordatorios/notificaciones\n   Ej: "silencia", "no me mandes mensajes", "para los recordatorios", "deja de enviar", "no me escribas", "desactiva notificaciones", "no quiero recordatorios"\n   Datos: ninguno\n\n64. "reactivar_recordatorios" - el usuario quiere volver a recibir recordatorios\n   Ej: "activa los recordatorios", "vuelve a avisarme", "quiero recibir notificaciones", "reactiva los mensajes", "activa las alertas"\n   Datos: ninguno\n\n65. "como_empezar" - el usuario es nuevo y quiere saber como empezar\n   Ej: "soy nuevo", "como empiezo", "que hago primero", "recien empiezo", "acabo de registrarme", "por donde empiezo", "primera vez aqui"\n   IMPORTANTE: Diferente de ayuda (que lista comandos). Aqui es ONBOARDING para nuevos.\n   Datos: ninguno\n\n66. "ver_historial_cambios" - ver cambios/ediciones recientes hechas a sus transacciones\n   Ej: "que cambios hice hoy", "que corregi", "mis ultimas ediciones", "que modifique", "cambios recientes"\n   Datos: ninguno\n\n67. "compartir_resumen" - quiere compartir/enviar su resumen o reporte a alguien\n   Ej: "comparte mi resumen", "manda a mi esposa", "envia mi reporte a", "compartir mis gastos", "reenvia el reporte"\n   Datos: ninguno\n\n68. "hablar_con_humano" - quiere hablar con una persona real, soporte humano\n   Ej: "quiero hablar con alguien", "pasame con soporte", "necesito un humano", "atencion al cliente", "quiero hablar con una persona", "soporte tecnico"\n   IMPORTANTE: Diferente de queja (que reporta un problema). Aqui el usuario PIDE contacto humano directamente.\n   Datos: ninguno\n\n69. "registrar_deuda" - el usuario quiere registrar que debe dinero a alguien, o que alguien le debe dinero. Puede ser conversacional y natural.\n   Ej: "debo 200 a Juan", "le presté 500 a mi hermana", "Renzo me debe 150 por la cancha", "Annie me debe 100 soles y 10 dólares", "María me debe 50 lucas, tiene que pagarme el viernes", "le debo como 300 a Pedro por la cena del otro día"\n   Datos: tipo ("debo" si el usuario debe, "me_deben" si le deben), contraparte (nombre de la persona — SIEMPRE extraerlo del mensaje), monto (numero — si hay multiples montos en distintas monedas, usar el primer monto), moneda ("PEN" o "USD" — si hay multiples monedas, usar la del primer monto; el handler parsea el resto), descripcion (motivo, plazo o contexto adicional, o null)\n   REGLA: "debo X a Y" → tipo="debo". "Y me debe X" o "le presté X a Y" → tipo="me_deben"\n   IMPORTANTE: Extraer SIEMPRE contraparte y al menos un monto. El handler se encarga de parsear multiples montos/monedas del mensaje original. Si el usuario dice "me debe pagar en X días" o "tiene que pagarme el viernes", incluirlo en descripcion.\n\n70. "ver_deudas" - el usuario quiere ver sus deudas activas\n   Ej: "mis deudas", "cuánto debo", "quién me debe", "ver deudas", "resumen de deudas", "cuánto me deben"\n   Datos: ninguno\n\n71. "abonar_deuda" - el usuario registra un pago parcial o total de una deuda\n   Ej: "pagué 100 a Juan", "abono 50 a lo que le debo a Pedro", "le devolví 200 a mi hermana"\n   Datos: contraparte (nombre), monto (numero)\n   IMPORTANTE: Solo cuando habla de pagar una deuda existente. Gasto nuevo → "registrar_manual"\n\n72. "marcar_deuda_pagada" - la deuda quedó saldada completamente\n   Ej: "ya pagué a Juan", "saldé con Pedro", "quedó saldado", "me pagó Renzo", "ya nos arreglamos con Ana"\n   Datos: contraparte (nombre)\n\n73. "consolidar_deudas" - el usuario quiere saber cuanto debe o le deben EN TOTAL a una persona especifica (suma de todas las deudas con esa contraparte)\n   Ej: "cuanto le debo a Ana en total", "total con Pedro", "cuanto me debe Juan en total", "mis deudas con Maria"\n   Datos: contraparte (nombre de la persona)\n   IMPORTANTE: Diferente de ver_deudas (que lista TODAS). Aqui pregunta por el TOTAL con UNA persona especifica.\n\n74. "saldar_todo_contraparte" - el usuario quiere saldar/liquidar TODAS las deudas pendientes con una persona de golpe\n   Ej: "salda todo con Ana", "liquida todo con Pedro", "arregla todo con Maria", "cancela todo con Juan"\n   Datos: contraparte (nombre de la persona)\n   IMPORTANTE: Diferente de marcar_deuda_pagada (que salda UNA deuda). Aqui salda TODAS las deudas con esa persona.\n\n75. "compartir_meta" - el usuario quiere compartir una meta de ahorro para que otros se unan (meta colaborativa)\n   Ej: "comparte mi meta", "invitar a mi meta de viaje", "link de mi meta", "compartir mi ahorro"\n   Datos: nombre_meta (nombre de la meta o null si solo tiene una)\n\n76. "dividir_gasto_grupal" - el usuario quiere dividir un gasto entre varias personas (Splitwise lite)\n   Ej: "pague 300 la cena entre 4", "split de 500 entre 3", "dividir gasto de uber entre 2", "repartir 150 entre 3"\n   Datos: monto (numero), num_personas (numero), descripcion (que se pago)\n   IMPORTANTE: Diferente de dividir_gasto (que divide un gasto YA registrado). Aqui se CREA un gasto compartido nuevo.\n\nREGLAS CRITICAS:\n- Si el historial muestra que NETO hizo una pregunta y el usuario responde con "si", "no", "dale", "ok", "mas detalle", "eso", "las dos", o cualquier respuesta corta -> usar "desconocido" para que NETO maneje la continuacion\n- Si NETO acaba de notificar "Nuevo gasto" y el usuario dice algo como "el gasto es USD X" o "son dolares" -> usar "corregir_monto_moneda", NO "registrar_manual"\n- Si NETO acaba de registrar un gasto desde una imagen (historial muestra "Registré desde la imagen" o "📸") y el usuario dice la categoría o cómo corregirlo -> usar "corregir_categoria", NO "registrar_manual". Ej: "regístralo en alimentación", "ponlo en comida", "es alimentación porque compré pan", "cambialo a transporte"\n- Si el historial muestra que NETO hablaba de gastos por categoria y el usuario dice "otras categorias" o similar -> usar "desconocido" no "ver_categorias"\n- "otros" como categoria de gasto -> listar_gastos_categoria con categoria="Otros"\n- "cuanto gaste" sin periodo -> ver_total_gastado con periodo="mes"\n- "gastos registrados"/"que tengo" -> listar_gastos_mes\n- mes: enero=1, febrero=2, marzo=3, ..., diciembre=12\n- Si no especifica mes -> usar mes_actual\n- "debo X a Y" → "registrar_deuda" con tipo="debo". "Y me debe X" → tipo="me_deben"\n- "mis deudas" / "cuánto debo" / "quién me debe" → "ver_deudas", NO "desconocido"\n- "pagué X a [nombre]" sin mencionar gasto nuevo → "abonar_deuda", NO "registrar_manual"\n- "ya pagué a [nombre]" / "saldé con X" → "marcar_deuda_pagada", NO "desconocido"\n- "cuanto le debo a X en total" / "total con X" + contexto deudas → "consolidar_deudas", NO "ver_deudas"\n- "salda/liquida/cancela todo con X" → "saldar_todo_contraparte", NO "marcar_deuda_pagada"\n- "comparte/invita/link mi meta" → "compartir_meta", NO "desconocido"\n- "pague X entre N" / "dividir gasto" / "split" → "dividir_gasto_grupal", NO "registrar_manual"\n- "gracias", "genial", "crack", "buenazo" sin otra intencion -> "agradecimiento", NO "desconocido"\n- "cuanto gaste en [comercio]" con nombre de COMERCIO -> "buscar_gasto", NO "ver_total_gastado"\n- "cuanto gane" o "mis ingresos" -> "ver_ingresos", NO "ver_total_gastado"\n- "cuanto me queda" o "mi balance" -> "ver_balance", NO "ver_presupuesto"\n- "el monto es X" SIN mencionar dolares/moneda -> "editar_monto", NO "corregir_monto_moneda"\n- "divide entre X" o "mitad" -> "dividir_gasto"\n- "otro igual" o "lo mismo" -> "duplicar_gasto"\n- "mi nombre es X" -> "cambiar_nombre", NO "desconocido"\n- "no funciona", "hay un error", "no jala" como QUEJA -> "queja", NO "desconocido"\n- "deshaz", "cancela el ultimo", "me equivoque" SIN mencionar comercio -> "deshacer_ultimo", NO "eliminar_transaccion"\n- "siempre va en X" o "todo lo de X es Y" -> "editar_categoria_comercio", NO "corregir_categoria"\n- "no es gasto, es ingreso" o "es un cobro" -> "marcar_como_ingreso", NO "corregir_categoria"\n- "que es un CTS/AFP/gratificacion/deposito a plazo" -> "consulta_financiera", NO "desconocido"\n- "cuanto es X dolares en soles" o "convierte X USD" -> "convertir_moneda", NO "ver_tipo_cambio"\n- "soy nuevo" o "como empiezo" o "que hago primero" -> "como_empezar", NO "ayuda"\n- "quiero hablar con alguien/humano/soporte" -> "hablar_con_humano", NO "queja"\n- "estaria bueno que" o "podrias agregar" o "sugiero" -> "feedback", NO "desconocido"\n- "silencia" o "no me mandes mensajes" o "para los recordatorios" -> "silenciar", NO "desconocido"\n- "que plan tengo" o "mi cuenta" o "cuando vence" -> "estado_cuenta", NO "ver_premium"\n- "cual fue mi gasto mas grande/caro" -> "ver_gasto_mayor", NO "ver_total_gastado"\n- "cuantas veces fui a [comercio]" -> "ver_frecuencia_comercio", NO "buscar_gasto"\n- "gastos del 1 al 15" o "quincena" -> "ver_gastos_rango_fecha", NO "listar_gastos_mes"\n- "cuanto gasto los fines de semana" -> "ver_gastos_fin_de_semana", NO "ver_total_gastado"\n- "abona/agrega X a mi meta" -> "abonar_meta", NO "registrar_manual"\n- "quita/borra el presupuesto de X" -> "eliminar_presupuesto", NO "configurar_presupuesto"\n- "borra la meta de X" -> "eliminar_meta", NO "eliminar_transaccion"\n- "cuotas de X" o "cuanto pago en cuotas" -> "calcular_cuotas", NO "desconocido"\n- "recuerdame pagar X el dia Y" -> "recordatorio_pago", NO "desconocido"' + histCtx
      }, {
        role: 'user',
        content: msg
      }],
      temperature: 0
    });

    const rawClasif = clasificacion.choices[0].message.content.trim();
    const clean = rawClasif.startsWith('{') ? rawClasif : rawClasif.slice(rawClasif.indexOf('{'), rawClasif.lastIndexOf('}')+1);
    const _nlp = JSON.parse(clean); let intencion = _nlp.intencion; const datos = _nlp.datos || _nlp.data || {};

    // Overrides regex para patrones que el clasificador suele fallar
    const msgL = msg.toLowerCase();
    // "elimina/borra/quita [el gasto de] X" → eliminar_transaccion
    if (/\b(elimina|borra|quita|borrar|eliminar)\b.*(gasto|pago|cobro|movimiento|transacci[oó]n)/i.test(msg) ||
        /\b(elimina|borra|quita)\b.*\bde\b/i.test(msg)) {
      intencion = 'eliminar_transaccion';
      // Intentar extraer comercio del mensaje si no vino del clasificador
      if (!datos.comercio) {
        const m = msg.match(/(?:de|el de|gasto de|pago de)\s+([A-Za-záéíóúÁÉÍÓÚñÑ][A-Za-z0-9áéíóúÁÉÍÓÚñÑ\s\.]{1,30}?)(?:\s+(?:de|por|S\/|\$|\d|,|\.)|\s*$)/i);
        if (m) datos.comercio = m[1].trim();
      }
    }
    // "a la categoría NETO" / "ponlo en NETO" cuando clasificador no extrajo categoria_nueva
    if ((intencion === 'corregir_categoria' || intencion === 'desconocido') &&
        /(?:categor[íi]a|en)\s+neto\b|ponl[oa]\s+en\s+neto|muev[elo]+\s+a\s+neto/i.test(msg)) {
      intencion = 'corregir_categoria';
      if (!datos.categoria_nueva) datos.categoria_nueva = 'NETO';
    }
    // "es categoría X [y subcategoría Y]" → corregir_categoria con datos extraídos
    if (/\bes\s+categor[ií]a\b/i.test(msg)) {
      intencion = 'corregir_categoria';
      const mCatSub = msg.match(/\bes\s+categor[ií]a\s+([A-Za-záéíóúÁÉÍÓÚñÑ_\s]+?)(?:\s+y\s+subcategor[ií]a\s+([A-Za-záéíóúÁÉÍÓÚñÑ_\s]+))?\s*$/i);
      if (mCatSub) {
        datos.categoria_nueva = mCatSub[1].trim();
        if (mCatSub[2]) datos.subcategoria_nueva = mCatSub[2].trim();
      }
    }
    // "quiero ir a mi dashboard/app" → enviar link directo a app.neto.pe
    if (/\b(dashboard|mi app|la app|al app|mi panel|ver mis gr[aá]ficos|abrir app|entrar a la app|ir a mi app|ir al app|ir a la app|ir al dashboard|ver mi dashboard|abrir mi app|abrir la app|quiero ir al app|quiero ver mi app)\b/i.test(msg)) {
      intencion = 'ver_dashboard';
    }
    // "a cuánto está el dólar" / "tipo de cambio" → ver_tipo_cambio
    if (/\b(d[oó]lar|tipo de cambio|tc hoy|precio.+d[oó]lar|cambio.+d[oó]lar)\b/i.test(msg) && !/gast[eé]|pagu[eé]|registr/i.test(msg)) {
      intencion = 'ver_tipo_cambio';
    }
    // "gracias" / "eres crack" → agradecimiento (no desconocido)
    if (/^\s*(gracias|thanks|genial|crack|excelente|buenazo|buen[ií]simo|eres (lo|el) mejor|perfecto|chevere|ch[eé]vere|que bueno|muy bien)\s*[!.]*\s*$/i.test(msg)) {
      intencion = 'agradecimiento';
    }
    // "exportar" / "descargar mis datos" → exportar_datos
    if (/\b(exportar?|descargar?).+(datos|gastos|historial|todo)\b/i.test(msg) || /\b(excel|csv|backup).+mis\b/i.test(msg)) {
      intencion = 'exportar_datos';
    }
    // "divide entre X" / "mitad" → dividir_gasto
    if (/\b(divid[eir]|split|a medias|mitad)\b/i.test(msg) && !/categor/i.test(msg)) {
      intencion = 'dividir_gasto';
      if (!datos.partes) {
        const mDiv = msg.match(/entre\s+(\d+)/i) || msg.match(/(\d+)\s+part/i);
        if (mDiv) datos.partes = parseInt(mDiv[1]);
        else if (/mitad|medias/i.test(msg)) datos.partes = 2;
      }
    }
    // "otro igual" / "lo mismo" → duplicar_gasto
    if (/\b(otro igual|lo mismo|repite|rep[ií]telo|igual que el anterior|mismo gasto)\b/i.test(msg)) {
      intencion = 'duplicar_gasto';
    }
    // "deshaz" / "cancela el último" / "me equivoqué" → deshacer_ultimo
    if (/\b(desha[zs]|cancela el [uú]ltimo|me equivoqu[eé]|undo|quita eso|borra el [uú]ltimo)\b/i.test(msg) && !/\b(gasto de|pago de|cobro de)\b/i.test(msg)) {
      intencion = 'deshacer_ultimo';
    }
    // "silencia" / "no me mandes mensajes" → silenciar
    if (/\b(silenci[ao]r?|no me mandes|no me escribas|deja de enviar|desactiva.*(notificaci|recordatorio)|no quiero recordatorio)\b/i.test(msg)) {
      intencion = 'silenciar';
    }
    // "activa los recordatorios" / "vuelve a avisarme" → reactivar_recordatorios
    if (/\b(activa.*(recordatorio|notificaci|alerta)|vuelve a avisarme|reactiva.*(mensaje|recordatorio|notificaci))\b/i.test(msg)) {
      intencion = 'reactivar_recordatorios';
    }
    // "quiero hablar con alguien/humano/soporte" → hablar_con_humano
    if (/\b(hablar con (alguien|humano|persona|soporte)|p[aá]same con|atenci[oó]n al cliente|soporte t[eé]cnico|necesito.+humano|quiero.+persona)\b/i.test(msg)) {
      intencion = 'hablar_con_humano';
    }
    // "soy nuevo" / "cómo empiezo" → como_empezar
    if (/\b(soy nuev[oa]|c[oó]mo empiezo|qu[eé] hago primero|reci[eé]n empiezo|primera vez|acabo de registrarme|por d[oó]nde empiezo)\b/i.test(msg)) {
      intencion = 'como_empezar';
    }
    // "cuánto es X dólares en soles" → convertir_moneda (no ver_tipo_cambio)
    if (/\b(cu[aá]nto es|conv[ie]rt[eir]|pasa)\b.+\b(d[oó]lares?.*(en|a) soles|soles.*(en|a) d[oó]lares|USD.*(a|en) PEN|PEN.*(a|en) USD)\b/i.test(msg)) {
      intencion = 'convertir_moneda';
    }
    // "estaría bueno que" / "podrías agregar" / "sugiero" → feedback
    if (/\b(estar[ií]a bueno|podr[ií]as agregar|sugiero|sugerencia|me gustar[ií]a que|deber[ií]an|falta que|una idea)\b/i.test(msg) && !/gast/i.test(msg)) {
      intencion = 'feedback';
    }
    // "qué plan tengo" / "mi cuenta" / "cuándo vence" → estado_cuenta
    if (/\b(qu[eé] plan tengo|soy free|soy pro|cu[aá]ndo vence|estado de mi (cuenta|suscripci)|mi perfil)\b/i.test(msg)) {
      intencion = 'estado_cuenta';
    }
    // "gastos hormiga" / "calcular mis gastos hormiga" → gastos_hormiga
    if (/gastos?\s+hormiga/i.test(msg)) {
      intencion = 'gastos_hormiga';
    }
    // "debo X a Y" / "me prestaron X" / "tengo deuda de X con Y" → registrar_deuda
    if (/\b(debo|le debo|me prest[oó]|tengo.*(deuda|prestamo|pr[eé]stamo)|me pidi[oó]|pidi[eé]ndome)\b/i.test(msg)) {
      intencion = 'registrar_deuda';
    }
    // "X me debe Y" / "le presté X a Y" / "Y me debe por" → registrar_deuda tipo me_deben
    if (/\b\w+\s+me debe\b|\ble prest[eé]\b|\bme deben\b/i.test(msg) && !/\bcu[aá]nto me deben\b/i.test(msg)) {
      intencion = 'registrar_deuda';
    }
    // "mis deudas" / "cuánto debo" / "quién me debe" → ver_deudas
    if (/\b(mis deudas|cu[aá]nto debo|ver deudas|deudas activas|qu[eé] debo|resumen de deudas|cu[aá]nto me deben|qui[eé]n me debe)\b/i.test(msg)) {
      intencion = 'ver_deudas';
    }
    // "pagué X a Y" / "abono X a deuda" → abonar_deuda
    if (/\b(pagu[eé]|abono|abon[eé]|le pa[gq]u[eé])\b.+\b(a |de |su |lo que)\b/i.test(msg) && !/\b(gast[eé]|registra|anota)\b/i.test(msg)) {
      intencion = 'abonar_deuda';
    }
    // "ya pagué a Y" / "saldé con Y" / "Y me pagó" → marcar_deuda_pagada
    if (/\b(ya pagu[eé]|sald[eé]|liquidu[eé]|cancel[eé] la deuda|me pag[oó]|ya me pag[oó]|ya nos arreglamos|qued[oó] saldado)\b/i.test(msg)) {
      intencion = 'marcar_deuda_pagada';
    }
    // "Annie me dio 50" / "me transfirió 30" → abonar_deuda (pago recibido)
    if (/\b(\w+)\s+me\s+(dio|transfiri[oó]|deposit[oó]|pas[oó])\s+\d/i.test(msg) && !/\b(gast[eé]|registra|anota|debe)\b/i.test(msg)) {
      intencion = 'abonar_deuda';
    }
    // "le pagué la mitad a X" / "le di un tercio" → abonar_deuda (fracciones)
    if (/\b(le\s+)?(pagu[eé]|di|abon[eé])\s+(la mitad|un tercio|la tercera|un cuarto|la cuarta|\d+\s*%)\b/i.test(msg)) {
      intencion = 'abonar_deuda';
    }
    // "cuánto le debo a X en total" / "total con X" → consolidar_deudas
    if (/\bcu[aá]nto\s+(le\s+debo|me\s+debe)\b.+\b(en total|total)\b/i.test(msg) || /\btotal\s+(con|de)\s+\w+.*deuda/i.test(msg)) {
      intencion = 'consolidar_deudas';
    }
    // "salda todo con X" / "liquida todo con X" → saldar_todo_contraparte
    if (/\b(salda|liquida|arregla|cancela)\s+todo\s+(con|de)\b/i.test(msg)) {
      intencion = 'saldar_todo_contraparte';
    }
    // "ahorré 200 para mi laptop" / "guardé 100 para el viaje" → abonar_meta
    if (/\b(ahorr[eé]|guard[eé]|met[ií]|apart[eé]|separ[eé])\b.+\b(para|a|en)\s+(mi\s+)?\w+/i.test(msg) && !/\b(meta|ahorro)\b.*\bcre/i.test(msg) && !/\b(debo|debe|prest|deuda)\b/i.test(msg)) {
      intencion = 'abonar_meta';
    }
    // "saqué 50 de mi fondo" / "retiré de mi meta" → abonar_meta (retiro)
    if (/\b(saqu[eé]|retir[eé]|quit[eé]|us[eé]|tom[eé])\b.+\b(de\s+mi|del|de\s+la)\s+\w+/i.test(msg) && /\b(meta|fondo|ahorro)\b/i.test(msg)) {
      intencion = 'abonar_meta';
    }
    // "comparte mi meta" / "invitar a mi meta" / "link de mi meta" → compartir_meta
    if (/\b(comparte?|invitar?|compartir|link)\b.+\b(meta|ahorro)\b/i.test(msg) || /\b(meta|ahorro)\b.+\b(comparte?|invitar?|compartir|link)\b/i.test(msg)) {
      intencion = 'compartir_meta';
    }
    // "pagué 300 la cena entre 4" / "split de 500 entre 3" / "dividir gasto" → dividir_gasto_grupal
    if (
  /\b(pagu[eé]|divid[eiír]|split|repartir)\b.+\bentre\s+\d+/i.test(msg) ||
  /\b(dividir|split|repartir)\s+(gasto|cuenta|cena|almuerzo|uber)\b/i.test(msg) ||
  /\b(pagu[eé]|divid[eiír])\b.+\bcon\s+\d+\s+(amigos?|personas?)/i.test(msg)
) {
  intencion = 'dividir_gasto_grupal';
}
    log.info({ tag: 'NLP', intencion, datos }, 'Intención clasificada');


    // === Intent dispatch via registry ===
    const ctx = {
      supabase, openai, log, hoyPeru, ultimoDiaMes, mesActual, anioActual, mE,
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
