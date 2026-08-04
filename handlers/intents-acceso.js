// Qué puede hacer por WhatsApp un usuario que está en el MURO (terminó su trial y no pagó).
//
// La regla, en una línea: **escribir nunca se corta; lo que se cobra es leer.**
//
// Neto sigue registrando gastos gratis para siempre — esa es la promesa del sprint de
// activación (commits 3c992bb..232e7f6) y romperla mataría al usuario que solo quiere
// WhatsApp. Pero si además puede pedir su total por categoría, su reporte y su score por
// chat, entonces WhatsApp solo ES el producto completo, el paywall es decorativo y nadie
// paga nunca. El cohorte WhatsApp-only son 36 de 82 usuarios: es exactamente el que hay
// que poder convertir.
//
// Lo que se queda del lado gratis, además de escribir, es el TOTAL del mes — un número
// suelto que va pegado a la confirmación del gasto (lib/trial.js → nudgeMuro). Ese número
// es la señal de que sus datos siguen creciendo, y es lo que genera la comezón que el
// desglose cobra. Quitarlo también le saca el motivo para seguir anotando, y sin
// anotaciones el paywall termina vendiendo un dashboard sobre data muerta.
//
// ── Por qué dos listas y no una ──────────────────────────────────────────────────
// Un intent nuevo que no aparezca en NINGUNA de las dos rompe el test de
// `tests/handlers/intents-acceso.test.js`. Con una sola lista (solo lo bloqueado), un
// intent de lectura nuevo se filtraría GRATIS y en silencio, que es justo el modo de
// falla que no se puede detectar mirando producción.

// Lecturas: consultar la data que el usuario acumuló. Es lo que se paga.
const INTENTS_LECTURA = new Set([
  // Gastos agregados — el corazón del muro
  'listar_gastos_mes', 'listar_gastos_semana', 'listar_gastos_dia', 'listar_gastos_categoria',
  'ver_total_gastado', 'ver_gastos_rango_fecha', 'ver_gastos_fin_de_semana', 'gastos_hormiga',
  // Analítica
  'ver_gasto_mayor', 'ver_gasto_menor', 'ver_promedio_diario', 'ver_historial_cambios',
  'ver_ingresos', 'ver_suscripciones',
  // Reportes y export
  'ver_reporte', 'exportar_datos', 'compartir_resumen', 'ver_recomendaciones',
  // Presupuestos: configurarlos sin poder verlos no sirve de nada, así que el módulo
  // entero cae del lado de pago (escribir un límite que nunca vas a poder consultar es
  // peor que un "no": es una caja negra).
  'ver_presupuesto', 'configurar_presupuesto', 'eliminar_presupuesto', 'ver_balance', 'ver_categorias',
  // Metas / planes de ahorro
  'ver_metas', 'crear_meta', 'editar_meta', 'eliminar_meta', 'abonar_meta', 'compartir_meta',
  'viabilidad_plan', 'abandonar_plan', 'sugerir_recortes',
  // Deudas: mismo argumento que presupuestos — el valor del módulo es el ledger que se
  // lee después. `dividir_gasto_grupal` NO está acá: ese registra un gasto propio, y
  // registrar no se toca.
  'ver_deudas', 'registrar_deuda', 'abonar_deuda', 'marcar_deuda_pagada',
  'consolidar_deudas', 'saldar_todo_contraparte',
  // Espacios compartidos. `registrar_gasto_espacio` NO está acá: es ESCRITURA, y
  // escribir no se corta ni siquiera cuando el gasto va a un espacio (ver abajo).
  'crear_espacio', 'ver_espacios', 'ver_balance_espacio',
  'liquidar_espacio', 'invitar_espacio', 'unirse_espacio',
  // Gmail (Pro de origen)
  'escanear_gmail', 'agregar_gmail', 'cambiar_gmail', 'preferencia_reporte_gmail',
  // Consultas libres sobre la data propia
  'buscar_gasto', 'comparar_meses', 'ver_frecuencia_comercio', 'consulta_financiera',
  // Neto Score y detector de fugas: análisis puro sobre lo acumulado.
  'ver_neto_score', 'tips_neto_score', 'historial_neto_score',
  'ver_fugas', 'poner_limite_gasto',
]);

// Lo que sigue abierto en el muro. Tres familias:
//   · ESCRITURA — registrar, corregir, borrar, deshacer. La promesa que no se toca.
//     Incluye `ver_ultima_transaccion` a propósito: es el eco del último registro y el
//     ancla de toda corrección ("¿cuál fue el último?" → "cámbialo a 40"). Bloquearlo
//     rompe el flujo de escritura, no protege ninguna lectura de valor.
//   · CONVERSIÓN — /premium, referidos, estado de cuenta, el link al dashboard. Cerrarle
//     al usuario en el muro el camino de pagar sería absurdo.
//   · SERVICIO — saludos, ayuda, soporte, silenciar, y utilidades que no leen SU data
//     (tipo de cambio, conversión de moneda, cuotas).
const INTENTS_LIBRES = new Set([
  // Escritura
  'registrar_manual', 'corregir_categoria', 'corregir_multiple', 'corregir_monto_moneda',
  'eliminar_transaccion', 'editar_monto', 'editar_fecha', 'editar_comercio',
  'editar_categoria_comercio', 'deshacer_ultimo', 'restaurar_eliminado',
  'marcar_como_ingreso', 'dividir_gasto', 'duplicar_gasto',
  'ver_ultima_transaccion', 'dividir_gasto_grupal',
  // `registrar_gasto_espacio` registra un gasto. Que además caiga en un espacio
  // compartido no lo convierte en lectura, y estaba del otro lado — o sea que el
  // muro le cortaba una ESCRITURA, contra la única regla que no se negocia.
  //
  // Ojo que esto NO cierra la asimetría de canal completa (hallazgo M11), y es
  // deliberado (decisión de Favio, 04-ago-2026): la webapp autoriza Espacios por
  // el plan del OWNER ("host paga", ver webapp/src/lib/spaces-server.ts), mientras
  // que acá el muro sigue siendo del EMISOR. Un miembro en el muro, en un espacio
  // cuyo host paga, ve balances por web y no por WhatsApp. Se deja así porque
  // resolverlo de verdad obliga al chokepoint a consultar shared_spaces+usuarios
  // ANTES de saber si el mensaje siquiera va a un espacio —en el camino más
  // caliente del bot— y abre una vía de lectura gratis: te invito a mi espacio y
  // consultás sin pagar. El muro de WhatsApp es del usuario, no del espacio.
  'registrar_gasto_espacio',
  // Conversión
  'ver_premium', 'ver_referidos', 'estado_cuenta', 'ver_dashboard',
  // Servicio
  'saludo', 'ayuda', 'agradecimiento', 'queja', 'chiste_finanzas', 'como_empezar', 'feedback',
  'silenciar', 'reactivar_recordatorios', 'hablar_con_humano', 'desconectar_cuenta', 'cargar_excel',
  'ver_tipo_cambio', 'convertir_moneda', 'calcular_cuotas', 'cambiar_nombre', 'recordatorio_pago',
]);

/** ¿Este intent requiere plan con derecho a lectura? */
function requiereLectura(intencion) {
  return INTENTS_LECTURA.has(intencion);
}

// Comandos con `/` que hacen lo mismo que un intent de lectura. Van aparte porque la
// cascada de comandos de handlers/webhook.js corre ANTES del NLP y nunca pasa por el
// dispatch de intents, así que el chokepoint de message-processor no los cubre.
const COMANDOS_LECTURA = new Set([
  '/semana', '/resumen', '/mes', '/presupuesto', '/reporte', '/escanear', '/pendientes', '/categorias',
]);

/** ¿Este comando `/` es una lectura? Tolera argumentos ("/reporte julio"). */
function comandoRequiereLectura(cmd) {
  const base = String(cmd || '').trim().split(/\s+/)[0];
  return COMANDOS_LECTURA.has(base);
}

module.exports = {
  INTENTS_LECTURA,
  INTENTS_LIBRES,
  COMANDOS_LECTURA,
  requiereLectura,
  comandoRequiereLectura,
};
