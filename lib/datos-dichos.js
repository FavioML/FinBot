// ¿Los datos con los que se va a ESCRIBIR están en el mensaje? (02-oct-2026)
//
// El clasificador lee el historial y rellena los argumentos de la tool con lo que encuentra ahí.
// En prod, "No aparece en mi dashboard" llegó a `registrar_deuda` con `monto: 20` y
// `contraparte: "bidon de agua"`, copiados del turno anterior, y Neto contestó "Anotado. Le debes
// S/20 a bidon de agua" e insertó la fila (la persona la borró a mano, `borrados_auditoria` 12054).
//
// Fue la CUARTA aparición de la misma clase, y las tres anteriores se cerraron cada una en su
// handler: el sujeto inventado del borrado (`ELIMINAR_SUJETO_NO_DICHO`, efb1625), el nombre
// inventado (`lib/nombres.js`) y la edición sin orden (`lib/orden-edicion.js`). Un quinto tapón en
// `deudas.js` dejaba abiertos metas, presupuestos, límites, espacios, restaurar y la regla de
// comercio, que escriben `datos` sin mirar el mensaje (inventario del 02-oct en docs/DEFECTOS.md).
//
// Por eso la guarda vive en `dispatchIntent`, el único camino de producción hacia un handler, y
// no en cada handler. Las reglas:
//
//  1. Cada intent que escribe con `datos` del modelo tiene su fila en `ESCRITURAS`, con el TIPO de
//     cada campo que decide la escritura. Un campo cuyo valor no está en el mensaje se DESCARTA
//     (log `DATO_NO_DICHO`) y el handler sigue como si el modelo no lo hubiera dado.
//  2. Los SELECTORES (el nombre de la meta o del espacio, la contraparte de una deuda) no se
//     descartan: si el modelo dio uno y el mensaje no lo nombra, se PREGUNTA y el handler no corre.
//     Descartarlos no evitaba la escritura, la mudaba: los handlers caen a "la más reciente" y los
//     fallbacks de deudas leen cualquier palabra del mensaje como nombre ("Ya me pagó 50" → "Ya").
//     Un selector exige TODAS sus palabras clave: "viaje europa" no nombra "Viaje Cusco".
//  3. Los handlers que sin selector caen a "el más reciente" exigen además que el mensaje nombre el
//     OBJETO ("elimina mi meta"): sin selector ni objeto, se pregunta.
//  4. Un REPORTE de que algo no aparece EN la app ("No aparece en mi dashboard", "no está en mis
//     deudas") no es una orden y no escribe, traiga los datos que traiga: "La deuda de 20 con Juan no
//     aparece en mi dashboard" tiene todo dicho y duplicaba la deuda. Cede si el mensaje ARRANCA con
//     una orden o pide recuperar.
//  5. Un monto sin dígitos se compara por VALOR: "una deuda" vale 1, no los 20 del historial.
//  6. Todo intent registrado está clasificado acá o en `SIN_REVISION`, con su motivo. Un intent
//     nuevo sin clasificar rompe el build (`tests/lib/datos-dichos.test.js`), igual que el muro.
//
// ALCANCE, fijado después de tres revisiones adversariales (la memoria
// `feedback_tapar_el_caso_regenera_la_clase` dice cuándo parar de perseguir casos). Esta guarda
// responde UNA pregunta: ¿el dato salió del mensaje o del historial? NO resuelve, y lo declara:
//  - la RESOLUCIÓN de filas (a qué fila apunta un nombre que SÍ se dijo): la decide
//    `lib/resolver-nombre.js` desde el 02-oct, en cada handler y servicio que elige por nombre;
//  - la CATEGORÍA: se infiere ("taxi" → Transporte) y exigirla escrita rechazaba 10 de 10
//    presupuestos reales. Tampoco `corregir_categoria` sin comercio: corrige el último, como decidió
//    el chip 5 (su respuesta legítima es una palabra suelta tras una pregunta de NETO);
//  - el TIPO de una deuda (debo / me deben) y la fecha comparada por valor;
//  - un monto dicho en OTRA cláusula del mismo mensaje cuenta como dicho;
//  - una queja que NO nombra dónde no aparece ("no me aparece la deuda de Juan, me debe 20", "no lo
//    veo") y repite los datos sigue dependiendo del clasificador: las formas sin lugar se probaron y
//    bloqueaban préstamos reales ("me prestó 50 porque no me carga el yape");
//  - lecturas de un monto hablado que no son copias del historial ("veinte cincuenta" también suma
//    70, "cinco soles cincuenta" no se lee): son del mensaje, no del historial.
//
// Costo conocido: quien se refiere a alguien con un pronombre ("ella me debe 302") recibe la
// pregunta de a quién. De las 9 deudas creadas por WhatsApp en 90 días, 1 tenía esa forma y otra
// tenía la contraparte "desconocida", inventada por el modelo. Un mensaje de más contra una fila de
// plata que la persona tiene que encontrar y borrar sola.

const { montoEscritoEnMensaje } = require('./nlp-guards');
const { normalizar } = require('./orden-edicion');

// Palabras que no identifican a nadie: si el valor solo tiene éstas, se exige el valor entero.
const VACIAS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'por', 'para',
  'con', 'y', 'a', 'al', 'en', 'un', 'una', 'unos', 'unas', 'que', 'lo', 'le', 'les', 'se',
]);

/** Las palabras del valor que lo identifican (3+ letras, no vacías). */
function palabrasClave(valor) {
  return normalizar(valor).split(' ').filter((p) => p.length >= 3 && !VACIAS.has(p));
}

/**
 * ¿`valor` está escrito en `msg`? Por palabra entera (con o sin la "s" final), nunca por prefijo:
 * "Luis" no está en "Luisa". Con `todas`, cada palabra clave del valor tiene que estar (selectores);
 * sin él basta una, porque un dato que no elige fila puede venir completado por el modelo ("Jenny
 * Pérez" cuando el mensaje dice "mi tía Jenny"). "bidon de agua" contra "No aparece en mi
 * dashboard" no tiene ninguna.
 */
function textoDicho(valor, msg, { todas = false } = {}) {
  const palabras = new Set(normalizar(msg).split(' ').filter(Boolean));
  const claves = palabrasClave(valor);
  if (claves.length === 0) {
    const v = normalizar(valor);
    return v.length >= 2 && (' ' + normalizar(msg) + ' ').includes(' ' + v + ' ');
  }
  const esta = (p) => {
    const base = p.endsWith('s') ? p.slice(0, -1) : p;
    return palabras.has(p) || palabras.has(base) || palabras.has(base + 's');
  };
  return todas ? claves.every(esta) : claves.some(esta);
}

// ── Números escritos en palabras ─────────────────────────────────────────────────────────────
const UNIDADES = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
  veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200,
  doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};
// "gamba" es jerga peruana de cien soles: "dos gambas" = 200.
const MULTIPLICADORES = { mil: 1000, millon: 1e6, millones: 1e6, gamba: 100, gambas: 100 };

/** Lee un número en palabras desde `tokens[i]`. Devuelve { valor, fin } o null. */
function leerNumero(tokens, i) {
  let total = 0, actual = 0, hay = false, j = i;
  for (; j < tokens.length; j++) {
    const t = tokens[j];
    if (t in UNIDADES) { actual += UNIDADES[t]; hay = true; continue; }
    // Cifras pegadas a un multiplicador: "2 mil quinientos", "mil 500".
    if (/^\d+$/.test(t) && ((tokens[j + 1] || '') in MULTIPLICADORES || (tokens[j - 1] || '') in MULTIPLICADORES)) { actual += Number(t); hay = true; continue; }
    if (t in MULTIPLICADORES && (hay || t === 'mil' || t === 'gamba')) { total += (actual || 1) * MULTIPLICADORES[t]; actual = 0; hay = true; continue; }
    if (t === 'y' && hay && (tokens[j + 1] || '') in UNIDADES) continue;
    break;
  }
  return hay ? { valor: total + actual, fin: j } : null;
}

/**
 * Los números que el mensaje escribe en palabras, con TODAS sus lecturas: "ciento veinte" → 120,
 * "dos mil quinientos" → 2500, "un millón" → 1000000, "una deuda" → 1. Los decimales hablados
 * ("ciento diez punto setenta", "dos con cincuenta", "tres cincuenta") aportan las dos lecturas
 * posibles: para una guarda que pregunta "¿está dicho?", alcanza con que una coincida.
 */
function numerosEnPalabras(msg) {
  const tokens = normalizar(msg).split(' ');
  const out = [];
  for (let i = 0; i < tokens.length;) {
    const n = leerNumero(tokens, i);
    if (!n) { i++; continue; }
    out.push(n.valor);
    // Decimal con "punto" o "con": "dos con cincuenta" = 2.5.
    if ((tokens[n.fin] === 'punto' || tokens[n.fin] === 'con') && leerNumero(tokens, n.fin + 1)) {
      const d = leerNumero(tokens, n.fin + 1);
      out.push(n.valor + d.valor / (d.valor < 10 ? 10 : 100));
      out.push(d.valor);
      i = d.fin;
      continue;
    }
    // "tres cincuenta" = 3.50 y "veinte cincuenta" = 20.50: dos números menores que cien seguidos,
    // sin "y", se leen también como soles y céntimos.
    const pares = tokens.slice(i, n.fin);
    if (pares.length === 2 && UNIDADES[pares[0]] < 100 && UNIDADES[pares[1]] >= 10 && UNIDADES[pares[1]] < 100) {
      out.push(UNIDADES[pares[0]] + UNIDADES[pares[1]] / 100);
    }
    i = n.fin;
  }
  return out;
}

/** El monto, comparado por VALOR: con dígitos, contra los dígitos; sin dígitos, contra las palabras. */
function montoDicho(valor, msg) {
  const t = String(msg == null ? '' : msg);
  const v = Number(valor);
  if (/\d/.test(t)) {
    if (montoEscritoEnMensaje(valor, t)) return true;
    // Cifras con palabra en el medio, que `montoEscritoEnMensaje` no compone: "2 mil 500", "mil 500",
    // "2 mil quinientos", "2 gambas". Las lee `numerosEnPalabras`, que acepta cifras junto a un multiplicador.
    const n = normalizar(t);
    return Number.isFinite(v) && numerosEnPalabras(n).some((x) => Math.abs(x - v) < 0.005);
  }
  return Number.isFinite(v) && numerosEnPalabras(t).some((n) => Math.abs(n - v) < 0.005);
}

// ── Fechas ───────────────────────────────────────────────────────────────────────────────────
const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DIAS = 'lunes|martes|miercoles|jueves|viernes|sabado|domingo';
// Una fecha que el mensaje DICE. Un dígito suelto no alcanza ("ahorrar 500 al mes" no tiene fecha):
// la cifra tiene que tener forma de fecha o de plazo. No se compara el VALOR (declarado arriba).
const RE_FECHA_DICHA = new RegExp('(?:^| )(?:hoy|ayer|antier|anteayer|anoche|manana|quincena|navidad|'
  + DIAS + '|' + MESES + ')(?: |$)'
  + '|fin de (?:ano|mes)|(?:^| )(?:este|el proximo|proximo) (?:ano|mes)(?: |$)'
  + '|semana santa|fiestas patrias|ano nuevo|fin de ano|(?:^| )(?:verano|invierno|vacaciones|aguinaldo|gratificacion)(?: |$)'
  + '|(?:^| )(?:\\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce) (?:dias|semanas|meses|anos|dia|semana|mes|ano)(?: |$)'
  + '|(?:^| )\\d{1,2} \\d{1,2}(?: \\d{2,4})?(?: |$)|(?:^| )el \\d{1,2}(?: |$)|(?:^| )(?:19|20)\\d{2}(?: |$)');

const RE_USD = /(?:^| )(?:dolar|dolares|usd|verdes)(?: |$)/;

/** ¿El valor de un campo, según su tipo, está en el mensaje? */
function campoDicho(tipo, valor, msg, opciones) {
  switch (tipo) {
    case 'monto': return montoDicho(valor, msg);
    case 'texto': return textoDicho(valor, msg, opciones);
    // Un código se compara sin espacios ni guiones: "abc-12345" es ABC12345.
    case 'codigo': return normalizar(valor).replace(/ /g, '').length >= 4
      && normalizar(msg).replace(/ /g, '').includes(normalizar(valor).replace(/ /g, ''));
    case 'fecha': return RE_FECHA_DICHA.test(normalizar(msg));
    // PEN es el default de todos los handlers: solo hay que verificar el que lo cambia.
    case 'moneda': return String(valor).toUpperCase() !== 'USD' || RE_USD.test(normalizar(msg)) || /\$/.test(String(msg || ''));
    default: throw new Error('datos-dichos: tipo de campo desconocido ' + tipo);
  }
}

// ── El reporte de que algo no aparece EN la app ──────────────────────────────────────────────
// Solo la forma que nombra DÓNDE no aparece ("No aparece en mi dashboard", "no está en mis deudas",
// "no aparecen en neto"): es un reporte sobre lo que ya está anotado y no escribe. Cede ante un
// mensaje que ARRANCA con una orden ("Anota que le debo 30 a Rosa, no me aparece en la app") o que
// pide recuperar. Las formas sin lugar ("no lo veo", "no me carga", "no me sale") se probaron y se
// sacaron: la cuarta revisión las encontró bloqueando préstamos reales ("me prestó 50 porque no me
// carga el yape") y evadidas por relativas con sujeto. Una queja sin lugar que repite los datos
// queda declarada en el ALCANCE.
const LUGAR_EN_LA_APP = '(?:dashboard|app|aplicacion|web|pagina|panel|grafico|graficos|historial|resumen|reporte|cuenta|celular|neto|lista|deudas|gastos|metas|presupuestos|movimientos)';
const RE_NO_APARECE_EN_LA_APP = new RegExp('(?:^| )no (?:(?:me|te|lo|la|los|las|le|se) ){0,2}'
  + '(?:aparece|aparecen|aparecio|aparecieron|sale|salen|salio|figura|figuran|veo|ve|ven|esta|estan|'
  + 'carga|cargan|muestra|muestran|refleja|reflejan|registro|registraron|guardo|guardaron|anoto|anotaron)'
  + '(?: \\w+){0,2} (?:en|desde) (?:mi |mis |el |la |los |las |tu |tus )?' + LUGAR_EN_LA_APP + '(?: |$)');
const RE_EMPIEZA_CON_ORDEN = /^(?:(?:oye|neto|hola|porfa|por favor|ya) )?(?:anota|apunta|registra|pon|ponle|ponme|elimina|borra|quita|crea|cambia|sube|baja|agrega|suma|salda|liquida|debo|le debo)\w*(?: |$)/;
const RE_RECUPERAR = /(?:^| )(?:recupera\w*|restaura\w*|devuelve\w*|desborra\w*|restablec\w*)(?: |$)/;
function esReporteNoAparece(msg) {
  const t = normalizar(msg);
  return RE_NO_APARECE_EN_LA_APP.test(t) && !RE_EMPIEZA_CON_ORDEN.test(t) && !RE_RECUPERAR.test(t);
}
const REPORTE = 'No anoté nada nuevo: me cuentas que algo no aparece. Para ver lo que tengo guardado escríbeme _"mis gastos"_ o _"mis deudas"_. Si falta algo, dímelo como una orden (_"debo 20 a Juan"_) o escribe */soporte* y lo revisamos.';

// `objeto` es la palabra del dominio que basta para nombrar el objeto cuando el mensaje no dice
// el nombre. "plan" NO está: choca con el plan Pro ("ya no quiero el plan").
const RE_META = /(?:^| )(?:meta|metas|ahorro|ahorros|ahorrar|ahorre|ahorrando|objetivo|objetivos|alcancia|chanchito)(?: |$)/;

// Por intent:
//   campos      el tipo de cada campo que decide la escritura. Uno no dicho se DESCARTA.
//   selectores  los campos que eligen QUÉ fila existente se escribe. Uno que el modelo dio y el
//               mensaje no nombra (con TODAS sus palabras clave) NO se descarta: se contesta
//               `pregunta` y el handler no corre (regla 2).
//   objeto      la palabra del dominio que, sin selector, basta para que la escritura vaya a la más
//               reciente ("elimina mi meta"). Sin selector ni objeto, `pregunta` (regla 3).
const PREGUNTA_META = '¿De qué meta me hablas? Dime su nombre, por ejemplo _"elimina la meta viaje"_ o _"aboné 100 a la meta viaje"_.';
const PREGUNTA_ESPACIO = '¿En qué espacio lo anoto? Dime su nombre, por ejemplo _"pagué 200 del hotel en el espacio Viaje Cusco"_.';
const PREGUNTA_PERSONA = '¿Con quién es? Dime el nombre, por ejemplo _"debo 50 a Juan"_ o _"Juan me pagó 20"_.';
const ESCRITURAS = Object.freeze({
  registrar_deuda: { campos: { monto: 'monto', moneda: 'moneda', contraparte: 'texto' }, selectores: ['contraparte'], pregunta: PREGUNTA_PERSONA },
  // Un monto no dicho PREGUNTA en vez de descartarse: el fallback de `abonar_deuda` toma el primer
  // número del mensaje ("Juan ya me abonó lo de las 2 entradas" abonaba S/2). Salvo una fracción,
  // que el handler calcula del pendiente.
  abonar_deuda: {
    campos: { monto: 'monto', contraparte: 'texto' }, selectores: ['contraparte'], pregunta: PREGUNTA_PERSONA,
    preguntarSiNoDicho: ['monto'], salvo: /(?:^| )(?:la mitad|medio|un tercio|la tercera parte|un cuarto|la cuarta parte)(?: |$)|\d+ ?(?:%|por ciento)/,
    preguntaMonto: '¿Cuánto te pagó, o cuánto le pagaste? Dime el monto, por ejemplo _"Juan me pagó 50"_.',
  },
  marcar_deuda_pagada: { campos: { contraparte: 'texto' }, selectores: ['contraparte'], pregunta: PREGUNTA_PERSONA },
  saldar_todo_contraparte: { campos: { contraparte: 'texto' }, selectores: ['contraparte'], pregunta: PREGUNTA_PERSONA },
  crear_meta: { campos: { monto: 'monto', fecha_limite: 'fecha' } },
  editar_meta: {
    campos: { nombre: 'texto', monto_nuevo: 'monto', fecha_nueva: 'fecha' },
    selectores: ['nombre'],
    objeto: RE_META,
    pregunta: PREGUNTA_META,
  },
  eliminar_meta: { campos: { nombre: 'texto' }, selectores: ['nombre'], objeto: RE_META, pregunta: PREGUNTA_META },
  abonar_meta: {
    campos: { monto: 'monto', nombre_meta: 'texto', nombre: 'texto' },
    selectores: ['nombre_meta', 'nombre'],
    objeto: /(?:^| )(?:meta|metas|ahorro|ahorros|ahorre|ahorrar|ahorrando|aporte|aporto|abono|abone|separe|guarde|junte|alcancia|chanchito|objetivo|saque|retire)(?: |$)/,
    pregunta: PREGUNTA_META,
  },
  abandonar_plan: { campos: { nombre: 'texto' }, selectores: ['nombre'], objeto: RE_META, pregunta: PREGUNTA_META },
  configurar_presupuesto: { campos: { monto: 'monto', alerta_porcentaje: 'monto' } },
  eliminar_presupuesto: {
    campos: {},
    objeto: /(?:^| )(?:presupuesto|presupuestos|limite|limites|tope|topes)(?: |$)/,
    pregunta: '¿Qué presupuesto quieres quitar? Escríbeme _"elimina el presupuesto de comida"_.',
  },
  poner_limite_gasto: { campos: { monto_limite: 'monto' } },
  registrar_gasto_espacio: { campos: { monto: 'monto', nombre_espacio: 'texto' }, selectores: ['nombre_espacio'], pregunta: PREGUNTA_ESPACIO },
  liquidar_espacio: {
    campos: { monto: 'monto', contraparte: 'texto', nombre_espacio: 'texto' },
    selectores: ['contraparte', 'nombre_espacio'],
    pregunta: PREGUNTA_ESPACIO,
  },
  unirse_espacio: { campos: { codigo: 'codigo' } },
  // Sin comercio ni monto dichos restaura el último borrado: es lo que pide un "restaura" pelado.
  restaurar_eliminado: {
    campos: { comercio: 'texto', monto: 'monto' },
    objeto: /(?:^| )(?:restaura\w*|restablec\w*|recupera\w*|recupere\w*|devuelve\w*|regresa\w*|desborra\w*|repon\w*|vuelta|vuelve|volver|borrado|borre|borrar|borrarlo|borrarla|borraste|eliminado|elimine|eliminaste|quitaste|equivoque)(?: |$)/,
    pregunta: '¿Quieres que recupere lo último que borraste? Escríbeme _"recupera lo que borré"_.',
  },
  // Sin comercio dicho corrige el último movimiento (chip 5), y eso no lo decide esta guarda.
  corregir_categoria: { campos: { comercio: 'texto' } },
  // El comercio de una REGLA elige qué movimientos se mueven, ahora y después: es un selector.
  editar_categoria_comercio: {
    campos: { comercio: 'texto' }, selectores: ['comercio'],
    pregunta: '¿De qué comercio hablamos? Dímelo, por ejemplo _"todo lo de Rappi va en Delivery"_.',
  },
});

// Lo que no pasa por esta guarda, con su motivo. Un intent nuevo tiene que elegir lado.
const SIN_REVISION = Object.freeze({
  // Tienen guarda propia sobre el mensaje.
  registrar_manual: 'parsea el mensaje sin historial; montoEscritoEnMensaje y tipoContradiceElMensaje',
  eliminar_transaccion: 'ELIMINAR_SUJETO_NO_DICHO + pideBorrarUnGasto',
  deshacer_ultimo: 'pideBorrarUnGasto',
  cambiar_nombre: 'lib/nombres.js',
  editar_monto: 'lib/orden-edicion.js', editar_fecha: 'lib/orden-edicion.js', editar_comercio: 'lib/orden-edicion.js',
  corregir_monto_moneda: 'lib/orden-edicion.js', marcar_como_ingreso: 'lib/orden-edicion.js',
  dividir_gasto: 'lib/orden-edicion.js', duplicar_gasto: 'lib/orden-edicion.js',
  // Escriben con datos que salen del MENSAJE, no del modelo.
  corregir_multiple: 'parsearCorreccionesMultiples(msg), sin historial',
  dividir_gasto_grupal: 'todo por regex sobre el mensaje',
  compartir_meta: 'el nombre sale por regex del mensaje',
  // Escriben sin ningún dato del modelo (una bandera, el texto del mensaje, un cálculo).
  silenciar: 'bandera', reactivar_recordatorios: 'bandera', hablar_con_humano: 'ticket con el mensaje',
  desconectar_cuenta: 'el borrado real exige la frase fija', cargar_excel: 'responde con el link',
  ver_premium: 'abre la espera del comprobante, sin datos', ver_referidos: 'genera el código propio',
  queja: 'guarda el mensaje', feedback: 'guarda el mensaje', ayuda: 'bandera de no_quiero_pro',
  ver_neto_score: 'upsert del score calculado', invitar_espacio: 'código del espacio; elige entre los propios',
  editar_split_espacio: 'manda a la app', crear_espacio: 'nombre cosmético de algo nuevo',
  preferencia_reporte_gmail: 'enum cerrado; cualquier otro valor es unificado',
  escanear_gmail: 'sin datos', agregar_gmail: 'manda al OAuth', cambiar_gmail: 'manda al OAuth',
  // Lecturas.
  ver_gasto_mayor: 'lectura', ver_gasto_menor: 'lectura', ver_promedio_diario: 'lectura',
  ver_historial_cambios: 'lectura', ver_ultima_transaccion: 'lectura', ver_ingresos: 'lectura',
  ver_suscripciones: 'lectura', ver_deudas: 'lectura', consolidar_deudas: 'lectura',
  ver_espacios: 'lectura', ver_balance_espacio: 'lectura', ver_fugas: 'lectura',
  listar_gastos_mes: 'lectura', listar_gastos_semana: 'lectura', listar_gastos_dia: 'lectura',
  listar_gastos_categoria: 'lectura', ver_total_gastado: 'lectura', ver_gastos_rango_fecha: 'lectura',
  ver_gastos_fin_de_semana: 'lectura', gastos_hormiga: 'lectura', ver_metas: 'lectura',
  viabilidad_plan: 'lectura', sugerir_recortes: 'lectura', estado_cuenta: 'lectura',
  ver_presupuesto: 'lectura', ver_balance: 'lectura', ver_categorias: 'lectura',
  editar_categorias: 'manda a la app', ver_reporte: 'lectura', ver_dashboard: 'lectura',
  exportar_datos: 'lectura', compartir_resumen: 'lectura', ver_recomendaciones: 'lectura',
  tips_neto_score: 'lectura', historial_neto_score: 'lectura', saludo: 'texto fijo',
  agradecimiento: 'texto fijo', chiste_finanzas: 'texto fijo', como_empezar: 'texto fijo',
  ver_tipo_cambio: 'lectura', convertir_moneda: 'cálculo', calcular_cuotas: 'cálculo',
  buscar_gasto: 'lectura', comparar_meses: 'lectura', ver_frecuencia_comercio: 'lectura',
  consulta_financiera: 'texto', recordatorio_pago: 'no escribe',
});

/**
 * ¿El mensaje pide que la categoría corra para TODOS los movimientos de ese comercio, también los
 * anteriores? Solo con el alcance dicho: "siempre", "todos/todas", "los anteriores", "de ahora en
 * adelante", "cada vez", "regla". "todo" en singular no cuenta ("todo bien, cámbialo a taxi").
 *
 * Es la otra cara de la misma clase: una escritura MÁS ANCHA que el pedido. En prod (01-oct)
 * "Cambiar Plin de ricardo como taxi" movió ese pago y todos los anteriores a Ricardo; contra prod
 * (02-oct) el mismo mensaje creó la regla permanente "Plin → Transporte (siempre)".
 */
function pideAlcanceRetroactivo(msg) {
  return /(?:^| )(?:siempre|todos|todas|anteriores|cada vez|de ahora en adelante|todo lo de|lo de|los de|las de|regla|reglas|asocia\w*|clasifica\w*)(?: |$)/.test(normalizar(msg));
}

/**
 * Revisa los `datos` de una escritura contra el mensaje.
 *
 * @returns {{ datos: object, descartados: string[], pregunta: string|null }}
 *   `datos` es una COPIA sin los campos no dichos (nunca muta el original). `pregunta` no nula
 *   significa: no llamar al handler, contestar esto.
 */
function revisarDatosDichos({ intencion, msg, datos }) {
  const regla = ESCRITURAS[intencion];
  const entrada = datos || {};
  if (!regla) return { datos: entrada, descartados: [], pregunta: null };
  if (esReporteNoAparece(msg)) return { datos: entrada, descartados: [], pregunta: REPORTE };
  const limpios = { ...entrada };
  const descartados = [];
  const selectores = regla.selectores || [];
  let selectorNombrado = false;
  let selectorInventado = false;
  for (const [campo, tipo] of Object.entries(regla.campos)) {
    const v = limpios[campo];
    if (v === undefined || v === null || v === '') continue;
    const esSelector = selectores.includes(campo);
    if (campoDicho(tipo, v, msg, { todas: esSelector })) {
      if (esSelector) selectorNombrado = true;
    } else {
      delete limpios[campo];
      descartados.push(campo);
      if (esSelector) selectorInventado = true;
    }
  }
  let pregunta = null;
  const montoQuePregunta = (regla.preguntarSiNoDicho || []).some((c) => descartados.includes(c))
    && !(regla.salvo && (regla.salvo.test(normalizar(msg)) || /\d+\s*%/.test(String(msg || ''))));
  if (selectorInventado) pregunta = regla.pregunta;
  else if (montoQuePregunta) pregunta = regla.preguntaMonto;
  else if (regla.objeto && !selectorNombrado && !regla.objeto.test(normalizar(msg))) pregunta = regla.pregunta;
  return { datos: limpios, descartados, pregunta };
}

module.exports = {
  ESCRITURAS, SIN_REVISION, revisarDatosDichos, textoDicho, palabrasClave, VACIAS, campoDicho, pideAlcanceRetroactivo,
  numerosEnPalabras, montoDicho, esReporteNoAparece, REPORTE,
};
