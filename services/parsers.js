const { openai } = require('../lib/ai');
const { hoyPeru } = require('../lib/dates');
const log = require('../lib/logger');

// Razones sociales → nombre comercial limpio (GPT no siempre normaliza)
const COMERCIO_MAP = {
  'SPSA PLAZA VEA': 'Plaza Vea',
  'SPSA TOTTUS': 'Tottus',
  'DLOCAL*NETFLIX': 'Netflix',
  'DLOCAL*DISNEY': 'Disney+',
  'DLOCAL*SPOTIFY': 'Spotify',
  'DLOCAL*HBOMAX': 'Max',
};

function normalizarComercio(comercio) {
  if (!comercio) return comercio;
  const upper = comercio.trim().toUpperCase();
  for (const [raw, clean] of Object.entries(COMERCIO_MAP)) {
    if (upper === raw) return clean;
  }
  return comercio;
}

// ── Pasarelas de pago: el prefijo que se come al comercio ──────────────────────
//
// Los avisos peruanos traen el comercio como "PASARELA*COMERCIO" (IZI*BARBANEGRA,
// DLC*PEDIDOSYA, NIUBIZ*VETERINARIA SAN). El prefijo es de QUIEN PROCESA el cobro,
// no de dónde se gastó: no aporta nada para categorizar y encima es la mitad que el
// modelo a veces se queda. Medido en producción el 02-sep-2026 sobre 389 correos: el
// mismo IZI salió en TRES grafías —"IZI CARPPONE BARBERIA", "IZI*PLAZA DEL SOL" y
// "IZI" a secas— y dos gastos quedaron con comercio "IZI", categorizados en
// Estacionamiento uno y Electrónico el otro, ambos inventados desde un nombre vacío.
//
// El costo no es cosmético: `buscarReglaComercio` matchea por IGUALDAD exacta del
// string en minúsculas y el detector de recurrentes agrupa por `comercio.toLowerCase()`.
// Con la grafía bailando, la corrección manual del usuario no se pega y una misma
// barbería mensual de S/60 se parte en dos grupos. Verificado en prod: 7 visitas al
// mismo local repartidas entre "IZI CARPPONE BARBERIA" y "Carppone Barberia".
//
// **El ASTERISCO es la evidencia, y por eso el separador de espacio NO va por default.**
// Una revisión adversarial lo midió: con el espacio aceptado siempre, "NIUBIZ PERU",
// "IZIPAY SA", "CULQI SAC" y "DLC MOTORS" perdían su primera palabra, y tres empresas
// distintas colapsaban en el string "PERU". Es el defecto INVERSO del que este código
// arregla (N comercios fusionados en uno, en vez de uno partido en N) y le pega justo a la
// pasarela cobrándose a sí misma, que es un gasto real de los usuarios que son negocio.
// Sin asterisco no hay forma de saber si el token es prefijo o es el nombre, así que no se
// pela. Quien SÍ tiene la evidencia —el parser de correos, que ve el texto original, y el
// backfill, cuyas 39 filas se revisaron a mano— lo pide explícito.
const PASARELAS = [
  'IZI', 'IZIPAY', 'NIUBIZ', 'OPENPAY', 'DLC', 'DLOCAL', 'MPO', 'PYU',
  'PAGOEFECTIVO', 'VN', 'VISANET', 'CULQI', 'SAFETYPAY', 'MERCADOPAGO', 'MPAGO',
];
const PASARELAS_ALT = PASARELAS.join('|');
// Algunas pasarelas anteponen DOS tokens: Culqi manda "CULQI QR*<comercio>". Pelando sólo
// "CULQI" quedaba "Qr*lenon", y "CULQI QR" pelado quedaba en "QR" — peor que el original,
// porque un prefijo a medio pelar es una grafía MÁS, no un arreglo.
const QR_OPCIONAL = '(?:\\s+QR)?';
const RE_PREFIJO_ASTERISCO = new RegExp('^(?:' + PASARELAS_ALT + ')' + QR_OPCIONAL + '\\s*\\*+\\s*(.+)$', 'i');
// Sólo lo usan los dos call-sites que traen evidencia aparte del asterisco (ver arriba).
const RE_PREFIJO_ESPACIO = new RegExp('^(?:' + PASARELAS_ALT + ')' + QR_OPCIONAL + '\\s+(.+)$', 'i');
const RE_SOLO_PASARELA = new RegExp('^(' + PASARELAS_ALT + ')' + QR_OPCIONAL + '[\\s*]*$', 'i');

/**
 * El nombre es SÓLO el prefijo de la pasarela, sin comercio detrás ("IZI", "IZI*", "CULQI QR").
 * Es el caso degenerado: no se puede arreglar pelando (no queda nada), hay que ir a rescatarlo
 * al texto del correo.
 */
function esPasarelaSola(comercio) {
  if (!comercio || typeof comercio !== 'string') return false;
  return RE_SOLO_PASARELA.test(comercio.trim());
}

// Descompone "IZI*BARBANEGRA" en { pasarela: 'IZI', resto: 'BARBANEGRA' }, o null si no
// arranca con una pasarela conocida. El caso degenerado ("IZI") da resto vacío. Existe porque
// el override del correo necesita saber DE QUÉ pasarela se trata: buscar en el texto sin
// atarse a ella es lo que hacía que un correo con dos pasarelas guardara la equivocada.
const RE_PARTIR_PASARELA = new RegExp('^(' + PASARELAS_ALT + ')' + QR_OPCIONAL + '(?:\\s*\\*+\\s*|\\s+)(.+)$', 'i');

function partirPasarela(comercio) {
  if (!comercio || typeof comercio !== 'string') return null;
  const limpio = comercio.replace(/\s+/g, ' ').trim();
  const solo = limpio.match(RE_SOLO_PASARELA);
  if (solo) return { pasarela: solo[1], resto: '' };
  const m = limpio.match(RE_PARTIR_PASARELA);
  if (!m) return null;
  return { pasarela: m[1], resto: (m[2] || '').trim() };
}

/** El nombre arranca con un prefijo de pasarela, con asterisco o con espacio. */
function empiezaConPasarela(comercio) {
  return partirPasarela(comercio) !== null;
}

/**
 * Forma canónica del nombre del comercio: sin prefijo de pasarela y sin espacios de más.
 *
 * `opts.separadorEspacio` habilita pelar también "IZI CARPPONE" (sin asterisco). NO es el
 * default, y el motivo está arriba: sin asterisco, pelar puede comerse el nombre real.
 *
 * NO toca mayúsculas/minúsculas a propósito. La comparación que decide plata —reglas y
 * agrupación de recurrentes— ya pasa por `toLowerCase()`, así que cambiar el case no
 * compraría nada ahí y sí abriría un modo de fallar nuevo (un "IZI*KFC" saldría "Kfc").
 *
 * Idempotente: canonizar dos veces da lo mismo que canonizar una.
 */
function canonizarComercio(comercio, opts) {
  if (!comercio || typeof comercio !== 'string') return comercio;
  const limpio = comercio.replace(/\s+/g, ' ').trim();
  if (!limpio) return comercio;
  // Sólo el prefijo: se devuelve el TOKEN, pelado de asteriscos y espacios de cola. Pelarlo
  // entero dejaría el campo vacío, y un comercio pobre es recuperable mientras que uno vacío
  // rompe el insert. Devolverlo verbatim tampoco servía: "IZI", "IZI*" y "IZI *" son tres
  // grafías del mismo caso degenerado, o sea el bug original sobreviviendo adentro de su
  // propio arreglo. El rescate del caso vive en el parser, que sí tiene el correo a mano.
  const solo = limpio.match(RE_SOLO_PASARELA);
  if (solo) return solo[1];
  const m = limpio.match(RE_PREFIJO_ASTERISCO)
    || ((opts && opts.separadorEspacio) ? limpio.match(RE_PREFIJO_ESPACIO) : null);
  if (m && m[1] && m[1].trim()) return m[1].trim();
  return limpio;
}

// El nombre del comercio, sacado del TEXTO del correo. El banco manda la forma
// "PASARELA*COMERCIO", que en un aviso no aparece por casualidad: ésa es la evidencia de que
// el token es un prefijo y no el nombre.
//
// El corte existe porque `extraerTexto` colapsa todos los espacios: después del comercio no
// queda ninguna marca de fin de campo, así que sin cortar se guardaría "BARBANEGRA Tarjeta
// terminada en 4821 Monto S/ 97.00".
//
// **La lista de terminadores es corta a propósito.** Tenía además total, hora, banco, cuenta y
// empresa, y esas cinco son palabras normales adentro de una razón social peruana: medido,
// "IZI*IMPORTACIONES TOTAL ARTEFACTOS" quedaba en "IMPORTACIONES" y "IZI*SUPER BANCO DE
// ALIMENTOS" en "SUPER". Cortar de más pierde el nombre; cortar de menos deja cola, que se ve
// feo pero no borra nada.
//
// Tres detalles de la forma que se pagaron:
//   · las palabras llevan `\b` para que "tarjeta" no matchee "TARJETAS";
//   · los símbolos de moneda NO pueden llevarlo: después de `/` o `$` viene un espacio, o sea
//     dos caracteres no-palabra seguidos, que no forman borde. Con `\b` esas tres alternativas
//     no cortaban NUNCA — medido: "IZI*BODEGA LUCHO S/ 20.00 hoy" salía entero;
//   · el punto corta sólo si le sigue espacio o fin: pegado entre letras es una abreviatura
//     ("IZI*D.ONOFRIO"), y cortar ahí dejaba "D", que la guarda de longitud volvía `null`.
const RE_CORTE_COMERCIO = new RegExp(
  '[,;:|()]'
  + '|\\.(?=\\s|$)'
  + '|\\s+(?:tarjeta|fecha|monto|importe|operaci[oó]n|n[uú]mero|nro)\\b'
  + '|\\s+por\\s+tu\\b'
  + '|\\s+(?:S/|US\\$|\\$)', 'i');

// Palabras función del castellano. Son lo que separa un código de operación de un local
// numerado cuando el nombre arranca con dígitos: detrás del código viene prosa ("4821 en tu
// cuenta"), detrás del número del local viene el nombre ("345 RESTO CAFE").
const RE_PALABRA_FUNCION = /^(?:en|de|del|la|el|los|las|un|una|unos|unas|por|para|con|sin|tu|tus|su|sus|mi|mis|al|a|y|o|u|que|se|es|son|fue|no|desde|hasta|sobre|entre|como)$/i;

function limpiarNombreExtraido(bruto) {
  const corte = String(bruto || '').split(RE_CORTE_COMERCIO)[0];
  const nombre = (corte || '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  if (nombre.length < 2) return null;
  // Tiene que EMPEZAR con letra. El chequeo viejo pedía "alguna letra" en cualquier posición y
  // se lo comía un código de operación seguido de prosa: "IZI*4821 en tu cuenta" pasaba como
  // comercio "4821 en tu".
  if (/^[A-Za-z\u00c0-\u024f]/.test(nombre)) return nombre;
  // **Salvo que el número sea parte del nombre.** Medido el 04-sep-2026 en producción: el aviso
  // decía "IZI*345 RESTO CAFE" —el local se llama así— y el rescate devolvía null por empezar
  // con dígito, así que quedaba lo que dijera el modelo, que fue "RESTO CAFE" sin el 345.
  // Exigir letra a secas obliga a elegir entre dejar pasar el código de operación o perder el
  // local numerado; la palabra que sigue al número decide cuál es cuál sin tener que elegir.
  const m = nombre.match(/^\d+\s+([A-Za-z\u00c0-\u024f]\S*)/);
  if (m && !RE_PALABRA_FUNCION.test(m[1])) return nombre;
  return null;
}

// Clave de comparación: decide si dos grafías son el mismo comercio, aguantando el case y la
// puntuación ("REST. EL PARAISO" y "RESTELPARAISO" comparten clave con "REST EL PARAISO").
const claveComercio = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]/g, '');

// Clave por TOKENS: sirve para preguntar si un nombre está CONTENIDO en otro sin que la
// pregunta se cuele a media palabra. `claveComercio` no puede hacerlo —borra los espacios, así
// que "grifoprimax1" queda adentro de "grifoprimax12" y dos sucursales distintas se dan por la
// misma. Con los espacios puestos, " grifo primax 1 " no está en " grifo primax 12 ".
const claveTokens = (x) => ' ' + String(x || '').toLowerCase()
  .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ').trim() + ' ';
const contieneNombre = (grande, chico) => {
  const c = claveTokens(chico);
  return c.trim().length > 0 && claveTokens(grande).includes(c);
};

// El cuerpo del nombre NO puede tragarse la mención siguiente. Antes se capturaba goloso y se
// partía después, y eso tenía un agujero medido: el tope de 49 caracteres cae ANTES del tercer
// comercio, `matchAll` retoma pasado el final del match, y ese tercero no se veía nunca. Con
// "IZI*TIENDA VIEJA. Empresa IZI*TIENDA VIEJA. Antes IZI*BARBANEGRA" quedaban dos candidatos
// iguales, la guarda de ambigüedad no se enteraba y se guardaba el consumo viejo. Acá el token
// atemperado (`(?!...)` por carácter) hace que cada mención sea su propio match.
const PREFIJO_PASARELA_SRC = '(?:' + PASARELAS_ALT + ')' + QR_OPCIONAL + '\\s*\\*+\\s*';
// Arranca con letra O CON DÍGITO: hay locales numerados ("IZI*345 RESTO CAFE"). Quién es
// local y quién código de operación lo decide `limpiarNombreExtraido`, que mira la palabra
// que sigue al número; acá cerrar la puerta al dígito era perder el local sin salvar nada,
// porque el código de operación igual entra si empieza con letra.
const CUERPO_NOMBRE_SRC = '([A-Za-z0-9\u00c0-\u024f](?:(?!\\b' + PREFIJO_PASARELA_SRC + ')[^\\n]){0,49})';

// BCP corta el nombre del comercio a 23 caracteres EN EL PROPIO CORREO, prefijo incluido. No
// es una estimación: medido el 02-sep-2026 sobre las 389 transacciones de Gmail, 48 miden
// exactamente 23 y salen cortadas a media palabra ("Cineplanet Alcazar Tote", "Dolce Capriccio
// Miraflo", "IZI CHICHARRONES KIO UN").
//
// **Es una BANDA y no un piso, y esa diferencia era un defecto de clase severa.** Con
// `>= 22` bastaba un prefijo largo para abrir la puerta: el mismo nombre de 14 caracteres daba
// `false` como "IZI*GRIFO PRIMAX 1" (18) y `true` como "PAGOEFECTIVO*GRIFO PRIMAX 1" (27), o
// sea que cambiar el nombre de la pasarela derrotaba la guarda y se guardaba la sucursal
// equivocada. El argumento correcto es al revés: un string MÁS LARGO que el corte prueba que el
// banco NO cortó, porque si hubiera cortado mediría 23. Sólo un string parado justo en el corte
// puede venir recortado.
const LARGO_CORTE_BANCO = 22;
const LARGO_CORTE_BANCO_MAX = 24; // holgura: el modelo agrega o saca un espacio junto al asterisco
const pareceRecortadoPorElBanco = (nombre) =>
  typeof nombre === 'string' && nombre.length >= LARGO_CORTE_BANCO && nombre.length <= LARGO_CORTE_BANCO_MAX;

/**
 * Devuelve el nombre del comercio que trae el TEXTO del correo, o null si no hay uno del que se
 * pueda estar seguro. Null significa "manda lo que dijo el modelo", nunca "no hay nada".
 *
 * @param opts.prefiere  el resto del nombre que devolvió el modelo ('' en el caso degenerado).
 * @param opts.recortePosible  si el nombre del modelo está parado justo en el corte del banco.
 *
 * **Las reglas de abajo salieron de defectos MEDIDOS, no de imaginar casos.** Todas fallan hacia
 * el mismo lado: ante la duda no se reemplaza, y queda el nombre del modelo — que como mucho
 * arrastra el prefijo, mientras que reemplazar mal atribuye el gasto a otro negocio.
 */
function extraerComercioPasarela(texto, opts) {
  if (!texto || typeof texto !== 'string') return null;
  const prefiere = claveComercio(opts && opts.prefiere);

  // Se buscan TODAS las pasarelas, también en el caso degenerado. Acotarlo a la pasarela que
  // dijo el modelo parecía prudente y era lo contrario: en el caso degenerado esa es su ÚNICA
  // salida, o sea la menos confiable de todas. Medido — cargo real bajo "IZIPAY*BARBANEGRA",
  // mención vieja bajo "IZI*TIENDA VIEJA", modelo "IZI": el `\b` impide que IZI matchee dentro
  // de IZIPAY, así que se veía un candidato solo, la guarda de ambigüedad no se enteraba y se
  // guardaba el consumo anterior. La ambigüedad la cierra la regla (1), no el filtro por
  // pasarela, que además perdía rescates (IZI/IZIPAY y MPAGO/MERCADOPAGO son la misma empresa).
  const re = new RegExp('\\b' + PREFIJO_PASARELA_SRC + CUERPO_NOMBRE_SRC, 'gi');
  const candidatos = [];
  for (const m of texto.matchAll(re)) {
    const n = limpiarNombreExtraido(m[1]);
    if (n) candidatos.push(n);
  }
  if (candidatos.length === 0) return null;

  // (1) **Si el correo nombra DOS comercios distintos, no se reemplaza nada.** La guarda es
  // global y no sólo del caso degenerado, y eso cierra por construcción la clase entera de
  // defectos que tres revisiones adversariales encontraron una y otra vez acá: todos eran
  // "el correo tenía otra mención y el matcher se quedó con ésa". Perseguirlos de a uno
  // —atando la búsqueda a la pasarela, mirando el largo, comparando claves— tapaba el caso
  // medido y dejaba el siguiente abierto.
  //
  // Lo que cuesta es poco y cae del lado seguro: en un correo con dos menciones queda el
  // nombre del modelo, que para la forma con asterisco ya sale canónico igual (lo pela
  // `canonizarComercio`). Sólo se pierde el pelado de la forma con espacio y el rescate del
  // recorte, y sólo en correos con dos comercios, que en un aviso de un cargo no existen.
  //
  // Un aviso que nombra el MISMO comercio dos veces (BCP lo pone en la frase y otra vez en el
  // campo "Empresa") no es ambiguo: las dos menciones dan la misma clave.
  if (new Set(candidatos.map(claveComercio)).size > 1) return null;

  // (2) Sin nombre del modelo (caso degenerado, "IZI") se toma el único candidato que hay.
  if (!prefiere) return candidatos[0];

  // (3) Con nombre del modelo, la comparación es por el NOMBRE. Es la única que puede decidir:
  // el token de pasarela lo elige el modelo y no es de fiar — la búsqueda de arriba mira TODAS
  // las pasarelas porque IZI/IZIPAY y MPAGO/MERCADOPAGO son la misma empresa con dos nombres.
  const exacto = candidatos.find((c) => claveComercio(c) === prefiere);
  if (exacto) return exacto;

  // (3b) **El modelo no sólo recorta: MUTILA.** Medido el 04-sep-2026 sobre dos avisos de BCP
  // del mismo día: "IZI*345 RESTO CAFE" se guardó como "RESTO CAFE" —leyó el número del local
  // como código de referencia— y "DLC*PedidosYa Mariate Aur" como "PedidosYa", colapsando el
  // local contra la marca de delivery. En los dos el correo traía el nombre entero. Si el
  // candidato del correo CONTIENE al nombre del modelo, es el mismo comercio con más
  // información, y el correo es la fuente.
  //
  // La contención se pide por TOKENS completos, y eso es lo que la separa de (4): mantiene
  // afuera el caso que motivó la guarda de largo, donde "GRIFO PRIMAX 1" y "GRIFO PRIMAX 12"
  // son dos sucursales y no una recortada. Por eso acá no hace falta mirar el largo: un token
  // que no cierra no es contención. La guarda (1) ya garantizó que el correo nombra un solo
  // comercio, así que "más información" no puede venir de otro negocio.
  // El piso de largo NO es cosmético: con un nombre de dos letras la contención es gratis
  // ("EL" está adentro de medio Perú), y ese caso está medido —modelo "IZI*EL", correo
  // "IZI*EL AGUAJAL"—. De ahí sale el piso y no de un número redondo. Lo demás lo cierra la
  // contención por tokens, que ya deja afuera "MERCADO" dentro de "SUPERMERCADO SAN JOSE".
  const nombreModelo = (opts && opts.prefiere) || '';
  if (claveComercio(nombreModelo).length >= 3 && contieneNombre(candidatos[0], nombreModelo)) {
    return candidatos[0];
  }

  // (4) El nombre del modelo puede venir recortado por el banco y el del correo no, así que un
  // candidato que EXTIENDE al del modelo puede ser el mismo local. Sólo en esa dirección
  // —el banco recorta por el final, nunca por el principio— y sólo si el largo dice que el
  // recorte es plausible: sin eso, "GRIFO PRIMAX 1" y "GRIFO PRIMAX 12" se daban por el mismo
  // local. Si extienden dos, tampoco se elige.
  if (!(opts && opts.recortePosible)) return null;
  const unico = candidatos[0];
  return claveComercio(unico).startsWith(prefiere) ? unico : null;
}

// Extracción determinística de los últimos 4 dígitos de la tarjeta/cuenta a partir
// del texto de una notificación bancaria. Las notificaciones peruanas exponen la
// tarjeta con patrones muy estables ("terminada en 1234", "****1234"), así que un
// regex es más confiable que pedírselo al LLM. Devuelve string de 4 dígitos o null.
//
// Conservador a propósito: solo dispara con un keyword de tarjeta ("terminada en",
// "termina en", "terminación", "finaliza en", "acaba en") o una máscara (****, ····,
// xxxx, ●●●●) inmediatamente antes de los 4 dígitos. Así no captura montos, fechas ni
// códigos de operación sueltos.
const LAST4_PATTERNS = [
  /(?:terminad[ao]s?|que\s+termina|termina|terminaci[oó]n|finaliza(?:d[ao])?|acaba)\s+(?:en\s+)?[:#nro.\s-]*?(\d{4})\b/i,
  /(?:[*x·●•]\s?){2,}(\d{4})\b/i,
];

function extraerLast4(texto) {
  if (!texto || typeof texto !== 'string') return null;
  for (const re of LAST4_PATTERNS) {
    const m = texto.match(re);
    if (m && /^\d{4}$/.test(m[1])) return m[1];
  }
  return null;
}

// Normaliza un last4 recibido de una fuente no confiable (ej. campo emitido por el
// modelo de visión): solo acepta exactamente 4 dígitos, cualquier otra cosa → null.
function normalizarLast4(valor) {
  if (valor == null) return null;
  const s = String(valor).trim();
  return /^\d{4}$/.test(s) ? s : null;
}

const BANK_PARSER_PROMPT = `Eres un parser experto de notificaciones bancarias peruanas. Devuelve SOLO JSON sin markdown:
{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"nombre limpio del comercio", "categoria":"ver lista", "subcategoria":"ver lista", "banco":"BCP|Interbank|BBVA|Scotiabank|Yape|Plin|Falabella|Ripley|BanBif|Mibanco|CMAC|Otro", "metodo_pago":"Debito|Credito|Transferencia|Yape|Plin|Efectivo|Otro", "fecha":"YYYY-MM-DD", "descripcion_original":"texto original" }

CATEGORÍAS Y SUBCATEGORÍAS OBLIGATORIAS (usa EXACTAMENTE estos valores, sin variantes):

Alimentación:    delivery | restaurante | supermercado | mercado | cafeteria | snacks
Transporte:      uber_cabify | taxi | bus_micro | metro_bus | gasolina | peaje | estacionamiento
Vivienda:        alquiler | mantenimiento | electricidad | agua | gas | internet | cable
Salud:           farmacia | medico | clinica | laboratorio | seguro_salud | optica
Entretenimiento: streaming | suscripciones | cine | juegos | bares_clubs | eventos | hobbies
Compras:         ropa | calzado | electronico | hogar | belleza | mascotas
Educación:       universidad | instituto | curso_online | utiles | idiomas | colegios
Finanzas:        prestamo | tarjeta_credito | seguro | ahorro | inversion | comision_banco
Trabajo_Negocio: herramientas | publicidad | oficina | logistica | contador
Otros:           regalo | donacion | multa | viaje | sin_categoria

REGLAS DE NORMALIZACIÓN DE COMERCIOS:
- Rappi / PedidosYa / Glovo / DLC*PedidosYa → categoria: Alimentación, subcategoria: delivery.
  El comercio va COMPLETO: si el aviso trae el local detrás de la marca ("DLC*PedidosYa Mariate Aur"),
  el comercio es "PedidosYa Mariate Aur", NO sólo "PedidosYa".
- McDonald's / KFC / Bembos / Pizza Hut / restaurantes / huariques → Alimentación > restaurante
- SPSA / SPSA TOTTUS / Wong / Metro / Plaza Vea / Tottus / supermercados → Alimentación > supermercado
- Starbucks / Juan Valdez / café → Alimentación > cafeteria
- Uber / Cabify / InDriver / Beat → Transporte > uber_cabify
- Repsol / Primax / Pecsa / Petroperu / Grifo / gasolineras → Transporte > gasolina
- Peajes / Telepeaje / RUTAS → Transporte > peaje
- Estacionamiento / playa de estacionamiento → Transporte > estacionamiento
- Metropolitano / bus / combi / micro → Transporte > metro_bus
- Luz del Sur / Enel / Electrodunas / Hidrandina → Vivienda > electricidad
- SEDAPAL / EPS → Vivienda > agua
- Claro / Entel / Movistar hogar / Bitel / internet → Vivienda > internet
- TV cable / cableoperadora → Vivienda > cable
- Gas LP / GLP / Zeta Gas → Vivienda > gas
- DLOCAL*NETFLIX / Netflix / Disney+ / HBO / Spotify / YouTube Premium / Apple Music / Apple TV → Entretenimiento > suscripciones
- Apple.com/bill / Apple iCloud / Google One / Google Drive / Google Storage → Entretenimiento > suscripciones
- Claude / ChatGPT / OpenAI / suscripciones de software / apps recurrentes → Entretenimiento > suscripciones
- Cineplanet / Cinemark / UVK → Entretenimiento > cine
- Google Play / App Store / Steam / Xbox / PlayStation → Entretenimiento > juegos
- Bares / discotecas / pubs → Entretenimiento > bares_clubs
- Saga / Ripley / H&M / Zara / Forever 21 → Compras > ropa
- Bata / Marathon / Adidas / Nike → Compras > calzado
- Hiraoka / Falabella / Mercado Libre / Amazon / electrónica → Compras > electronico
- Promart / Sodimac / Maestro → Compras > hogar
- Natura / Unique / Perfumerías / salón / spa / barbería → Compras > belleza
- Veterinaria / mascotas / Petco → Compras > mascotas
- Inkafarma / MiFarma / Boticas / Farmacéxito → Salud > farmacia
- Clínicas / hospitales / emergencias → Salud > clinica
- Laboratorio / análisis → Salud > laboratorio
- Coursera / Udemy / Platzi / Duolingo → Educación > curso_online
- ICPNA / Británico / Berlitz / idiomas → Educación > idiomas
- Universidad / instituto / SENATI / ISEP → Educación > universidad
- Colegio / pensión escolar → Educación > colegios
- Cuota préstamo BCP/BBVA/Interbank → Finanzas > prestamo
- Pago tarjeta crédito / TC → Finanzas > tarjeta_credito
- SOAT / seguro vehicular / seguro de vida → Finanzas > seguro
- Comisión banco / ITF / porte → Finanzas > comision_banco
- Software / SaaS / herramientas trabajo → Trabajo_Negocio > herramientas
- Meta Ads / Google Ads / publicidad → Trabajo_Negocio > publicidad

REGLAS POR BANCO:
- BCP transferencia a terceros / interbancaria (BCP, BBVA, Interbank, Scotiabank cuando dice "Realizaste una transferencia" + "Enviado a"):
  * tipo: gasto
  * metodo_pago: "Transferencia"
  * El campo "Mensaje" del correo es la SEÑAL PRIMARIA de categoría/subcategoría (más fuerte que el beneficiario).
    Ejemplos:
      "Cuota 3 turismo" / "viaje" / "tour" → Otros > viaje
      "Alquiler" / "renta departamento" → Vivienda > alquiler
      "Préstamo" / "devuelvo plata" → Finanzas > prestamo
      "Almuerzo" / "cena" / "comida" → Alimentación > restaurante
      "Curso" / "matrícula" / "pensión colegio" → Educación > curso_online | colegios
      "Sueldo" / "honorarios" → tipo: ingreso, Finanzas > sin_categoria
      sin mensaje claro → Otros > sin_categoria
  * comercio: construir como "<Beneficiario> — <propósito principal del mensaje>" cuando el mensaje aporta contexto.
    Ejemplos:
      "Quipuzco Valles Danny L." + mensaje "Cuota 3 turismo" → comercio: "Quipuzco Valles Danny L. — cuota turismo"
      "Maria Lopez" + mensaje "alquiler abril" → comercio: "Maria Lopez — alquiler"
      "Juan Perez" sin mensaje claro → comercio: "Juan Perez"
    El propósito debe ser 1-3 palabras lowercase, sin números, sin meses, sin "menos", "y", "más", etc.
    Esto permite que Neto aprenda reglas distintas por propósito aunque sea el mismo beneficiario.
- BCP débito/crédito: buscar campo "Empresa" o descripción del consumo
- BBVA: buscar campo "Comercio" o descripción de consumo
- Interbank: buscar campo "Empresa" para pagos de servicio
- Scotiabank: buscar campo "Empresa o institución" para el comercio real
- YAPE:
  * "Realizaste un yapeo" / "Yapeaste" / "yapeo de S/" enviado → tipo: gasto
  * "Recibiste un yapeo" / "Te yapearon" / "yapeo recibido" → tipo: ingreso
  * Extraer monto después de "S/", comercio del campo "Nombre del Beneficiario" o "Enviado por"
  * fecha del campo "Fecha y Hora de la operación", banco: Yape
  * categoria: Otros (gasto) o Finanzas (ingreso), subcategoria: sin_categoria (a menos que sea comercio conocido)
- Plin:
  * "Realizaste un plin" / "Pago exitoso" / "plin enviado" → tipo: gasto
  * "Recibiste un plin" / "Te hicieron un plin" / "plin recibido" → tipo: ingreso
  * Extraer monto, comercio del destinatario/remitente, banco: Plin
- Banco Falabella: buscar campo "Comercio" o "Establecimiento", banco: Falabella
- Banco Ripley: buscar campo "Comercio", banco: Ripley
- BanBif: buscar campo "Comercio" o "Empresa", banco: BanBif
- Mibanco: buscar campo "Descripción" o "Empresa", banco: Mibanco
- Cajas municipales (CMAC Huancayo, Piura, Trujillo, Cusco, Ica, Sullana): banco: CMAC

REGLA CRÍTICA DE MONEDA (aplicar SIEMPRE antes de asignar moneda):
- Si el correo contiene "$", "USD", "US$" → moneda: "USD" sin excepción
- Si el correo dice "S/", "PEN", "soles" → moneda: "PEN"
- Comercios internacionales que SIEMPRE son USD: Netflix, NETFLIX.COM, DLOCAL*NETFLIX, Spotify, Disney+, Amazon Prime, YouTube Premium, Apple, Steam, Xbox, PlayStation, Google One, iCloud, ChatGPT, OpenAI, Claude, Claude.AI, Anthropic, Canva, Dropbox, Adobe, Microsoft 365, GitHub, Notion, Figma, Slack, Zoom, Shopify
- Si ves "$ 8.73" o "$8.73" en el correo → monto: 8.73, moneda: "USD"
- Tarjeta de crédito BCP/BBVA/Interbank con símbolo "$" → moneda: "USD"
- NUNCA registres en PEN un gasto que tenga símbolo "$" en el cuerpo del correo

REGLA CRÍTICA DE COMERCIO:
- "comercio" debe ser SOLO el nombre del establecimiento/empresa/persona (ej: "Plaza Vea", "Netflix", "Rappi")
- NUNCA incluir montos, fechas, tipo de operación ni frases descriptivas en el campo comercio
- Si el correo NO tiene un comercio identificable (ej: "operación pendiente", "cargo automático", "pago de servicio" sin nombre):
  → comercio: nombre del banco (ej: "BCP", "BBVA", "Interbank")
  → NO poner "Gasto pendiente de BCP S/5 del 2026-04-02" ni frases similares
- Si el correo dice "consumo en APPARKA PLAZA SAN MIGUE" → comercio: "Apparka Plaza San Miguel"
- PASARELAS DE PAGO (IZI*, IZIPAY*, NIUBIZ*, OPENPAY*, DLC*, DLOCAL*, MPO*, PYU*, VN*, CULQI*):
  el comercio real es TODO lo que va DESPUÉS del asterisco, y va COMPLETO.
  El prefijo es de la empresa que procesa el cobro, no de donde se gastó.
  "IZI*BARBANEGRA" → comercio: "BARBANEGRA"
  "IZI*BOTICA PEPITO" → comercio: "BOTICA PEPITO" → Salud > farmacia
  "NIUBIZ*VETERINARIA SAN" → comercio: "VETERINARIA SAN" → Compras > mascotas
  "DLC*PEDIDOSYA" → comercio: "PedidosYa" → Alimentación > delivery
  "DLC*PedidosYa Mariate Aur" → comercio: "PedidosYa Mariate Aur" (la marca Y el local, completo)
  "IZI*345 RESTO CAFE" → comercio: "345 RESTO CAFE" (el número es parte del nombre del local)
  NUNCA devuelvas sólo el prefijo ("IZI", "NIUBIZ"): no dice nada del gasto y hace
  imposible categorizarlo. Si sólo ves el prefijo, busca el nombre en el resto del correo.
- Limpiar códigos de referencia y números de operación, pero NUNCA recortar el nombre
  del comercio: si el correo trae "IZI*LA CARPITA DEL SABO", el comercio es
  "LA CARPITA DEL SABO" entero, aunque venga cortado por el banco.
- Un número PEGADO al nombre después del asterisco es parte del nombre, no un código:
  "IZI*345 RESTO CAFE" → "345 RESTO CAFE", "IZI*24 HORAS MARKET" → "24 HORAS MARKET".
  Sólo se descarta un número cuando lo que sigue es prosa del aviso y no un nombre
  ("IZI*4821 en tu cuenta" → no hay comercio).

REGLAS GENERALES:
- fecha en formato YYYY-MM-DD (año actual 2026)
- monto siempre número sin símbolos
- tipo=ingreso cuando el usuario RECIBE dinero:
  * "Recibiste un yapeo/plin/transferencia/abono/depósito"
  * "Te yapearon" / "Te hicieron un plin" / "Te transfirieron"
  * "Abono recibido" / "Depósito recibido" / "Transferencia recibida"
  * Sueldo, salario, honorarios cobrados
  * El campo "Enviado por" indica quién mandó el dinero al usuario
  * Para ingresos: comercio = nombre de quien envía el dinero, categoria: Finanzas, subcategoria: sin_categoria
- tipo=gasto cuando el usuario ENVÍA dinero:
  * "Realizaste un yapeo/plin/transferencia/pago"
  * "Yapeaste" / "Pagaste" / "Consumo con tarjeta"
  * Consumos, pagos, compras, transferencias enviadas
  * El campo "Enviado a" o "Beneficiario" indica a quién le pagó el usuario
- subcategoria NUNCA puede ser null — usar sin_categoria si no sabes
- comercio: nombre limpio sin códigos y sin prefijo de pasarela, pero COMPLETO: se pela lo que está ANTES del asterisco y se conserva TODO lo que está después (no "DLC*PEDIDOSYA" sino "PedidosYa"; no "IZI" sino "BARBANEGRA"; y si detrás del asterisco hay varias palabras o un número, van todas)`;

/**
 * Construye el bloque de prompt con categorías custom del usuario.
 * categoriasCustom: array de { nombre, subcategorias: [{ nombre }] } obtenido
 * con services/categories.js → obtenerCategoriasUsuario(usuarioId)
 *
 * Lo usan los DOS clasificadores de categoría del backend: éste (correos bancarios) y
 * `detectarCategoriaIA` (gastos por WhatsApp). Vive acá por ser el primero que lo tuvo; lo que
 * importa es que sea UNA sola copia — dos prompts que deciden la misma columna divergen solos.
 *
 * `opts.sustantivo` y `opts.matiz` existen SOLO para que el texto nombre bien lo que se está
 * clasificando. Los defaults reproducen el prompt de correos byte a byte, así que llamarla sin
 * opciones no cambia nada de lo que ya funcionaba (fijado por test).
 *
 * El placeholder es el SUSTANTIVO pelado, no la frase con artículo: los artículos van en la
 * plantilla ("del ${sustantivo}", "el ${sustantivo}") porque si no la contracción sale mal
 * ("de el correo").
 */
function buildCategoriasCustomPrompt(categoriasCustom, opts = {}) {
  if (!categoriasCustom || categoriasCustom.length === 0) return '';
  const sustantivo = opts.sustantivo || 'correo';
  const matiz = opts.matiz === undefined ? ' (especialmente para transferencias con mensaje)' : opts.matiz;
  // La regla que CIERRA las subcategorías es correcta para correos —ese prompt las declara
  // cerradas— y sería una contradicción en el clasificador de gastos, cuyo system prompt dice lo
  // contrario tres líneas antes ("usa ese nombre exacto aunque no esté en la lista"). Como este
  // bloque se concatena AL FINAL, la restrictiva ganaría, y los usuarios con árbol propio
  // dejarían de poder estrenar subcategorías nombrándolas — justo la población de B26.
  const reglaSub = opts.subsCerradas === false ? '' :
    '\n- subcategoria debe ser una de las listadas para esa categoría custom; si no hay match exacto, usar "sin_categoria"';
  const lineas = categoriasCustom.map(c => {
    const subs = (c.subcategorias || []).map(s => s.nombre).filter(Boolean);
    return '- ' + c.nombre + (subs.length ? ' → ' + subs.join(' | ') : ' (sin subcategorías)');
  }).join('\n');
  return `

CATEGORÍAS CUSTOM DEL USUARIO (PRIORIDAD SOBRE CANÓNICAS):
El usuario ha creado estas categorías propias. Si alguna encaja mejor con el contexto del ${sustantivo}${matiz}, úsala EN LUGAR de la canónica. Devuelve el "nombre" exacto tal como aparece aquí, respetando mayúsculas y acentos.

${lineas}

REGLA DE PRIORIDAD:
- Si el ${sustantivo} describe un viaje y el usuario tiene categoría "Viajes" custom → usa "Viajes" (no "Otros > viaje")
- Si el ${sustantivo} describe deudas y el usuario tiene categoría "Deudas" custom → usa "Deudas" (no la canónica más cercana)
- Solo cae a categoría canónica si NINGUNA custom encaja con el contexto${reglaSub}`;
}

async function parsearCorreoBancario(texto, contexto, categoriasCustom) {
  const systemPrompt = BANK_PARSER_PROMPT + buildCategoriasCustomPrompt(categoriasCustom);
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Parsea este correo bancario' + (contexto ? ' (asunto: ' + contexto + ')' : '') + ':\n\n' + texto }
    ],
    temperature: 0
  });
  const raw = res.choices[0].message.content.trim();
  const clean = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const parsed = JSON.parse(clean);
  // Nombre del comercio, en tres pasos y en este orden.
  //
  // 1. `normalizarComercio` primero, porque su tabla tiene entradas CON prefijo
  //    ('DLOCAL*NETFLIX' → 'Netflix'). Canonizar antes las dejaría sin match.
  // 2. **El correo le gana al modelo cuando el modelo empieza con una pasarela.** El texto
  //    original trae la forma "PASARELA*COMERCIO", que en un aviso bancario no aparece por
  //    casualidad: ésa es la EVIDENCIA de que el token es un prefijo y no el nombre. Cubre
  //    de una sola vez las tres grafías que se vieron en producción —"IZI", "IZI*BARBANEGRA"
  //    y "IZI BARBANEGRA"— sin tener que adivinar cuál de ellas era, y sin pelar por espacio
  //    a ciegas, que es lo que se comería un "NIUBIZ PERU" legítimo (ver arriba).
  // 3. Canonizar al final deja UNA sola grafía, que es lo que necesitan la regla del
  //    usuario y la agrupación de recurrentes para reconocer al mismo comercio.
  if (parsed.comercio) {
    let comercio = normalizarComercio(parsed.comercio);
    const partes = partirPasarela(comercio);
    if (partes) {
      const delCorreo = extraerComercioPasarela(texto, {
        prefiere: partes.resto,
        recortePosible: pareceRecortadoPorElBanco(comercio),
      });
      if (delCorreo) {
        log.info({ tag: 'COMERCIO', devuelto: comercio, delCorreo }, 'Comercio tomado del correo en vez de la respuesta del modelo');
        comercio = delCorreo;
      }
    } else {
      // **Que el modelo YA haya pelado el prefijo alcanzaba para que nadie mirara el correo**, y
      // ahí viven los dos defectos medidos el 04-sep-2026. El prompt le pide pelar la pasarela,
      // así que el caso en que obedece —y de paso se come parte del nombre— es el normal, no el
      // raro: la respuesta sale sin pasarela, `partirPasarela` da null y el override no corría.
      // La evidencia del correo no cambia por cómo respondió el modelo, así que se consulta
      // igual. Sólo reemplaza si aporta: con la misma clave gana el nombre del modelo, que trae
      // mejor capitalización que las mayúsculas del aviso ("Netflix" y no "NETFLIX").
      const delCorreo = extraerComercioPasarela(texto, { prefiere: comercio });
      if (delCorreo && claveComercio(delCorreo) !== claveComercio(comercio)) {
        log.info({ tag: 'COMERCIO', devuelto: comercio, delCorreo }, 'Comercio completado desde el correo');
        comercio = delCorreo;
      }
    }
    parsed.comercio = canonizarComercio(comercio);
  }
  // Últimos 4 de la tarjeta: extracción determinística sobre el correo original
  // (más fiable que el LLM). Si el modelo ya devolvió tarjeta_last4, se respeta;
  // si no, se intenta del texto.
  const last4 = normalizarLast4(parsed.tarjeta_last4) || extraerLast4(texto);
  if (last4) parsed.tarjeta_last4 = last4;
  return parsed;
}

// Sub-1 amount fallback: el modelo a veces devuelve ok:false o monto=0 ante microtransacciones
// (ej. "Gasté 0.0001 USD en tus servicios ayer" — cripto/fees). Si el modelo falló pero el msg
// contiene un patrón claro de "<1 + moneda explícita", reconstruimos el parsed manualmente.
// Solo se activa con moneda explícita para no abrir falsos positivos en montos sin contexto.
// Cubre ambos órdenes: "0.0001 USD" y "S/0.50".
const RE_MONTO_POST_MONEDA = /(\d+[.,]\d+)\s*(USD|EUR|GBP|PEN|d[oó]lares?|euros?|libras?|soles?|cripto|btc|eth)\b/i;
const RE_MONTO_PRE_MONEDA = /\b(USD|EUR|GBP|PEN|S\/\.?|\$)\s*(\d+[.,]\d+)/i;
const RE_VERBO_GASTO_MSG = /\b(gast[eé]|gaste|pagu[eé]|compr[eé]|bot[eé]|tir[eé]|perd[ií])\b/i;

function parseMonedaToken(token) {
  const t = (token || '').toLowerCase();
  if (/usd|d[oó]lar|^\$$/.test(t)) return 'USD';
  if (/eur|euro/.test(t)) return 'EUR';
  if (/gbp|libra/.test(t)) return 'GBP';
  // soles, S/, PEN, cripto/btc/eth → tratamos como PEN para mantener compat con el resto del flujo
  return 'PEN';
}

function extraerMontoSub1ConMoneda(msg) {
  if (!msg) return null;
  let m = RE_MONTO_POST_MONEDA.exec(msg);
  if (m) {
    const monto = parseFloat(m[1].replace(',', '.'));
    if (Number.isFinite(monto) && monto > 0 && monto < 1) {
      return { monto, moneda: parseMonedaToken(m[2]) };
    }
  }
  m = RE_MONTO_PRE_MONEDA.exec(msg);
  if (m) {
    const monto = parseFloat(m[2].replace(',', '.'));
    if (Number.isFinite(monto) && monto > 0 && monto < 1) {
      return { monto, moneda: parseMonedaToken(m[1]) };
    }
  }
  return null;
}

async function parsearRegistroManual(msg, fechaHoy) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Extrae datos de un registro manual de gasto o ingreso en lenguaje natural. Devuelve SOLO JSON:
{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"descripcion breve", "categoria":"ver lista", "subcategoria":"ver lista", "fecha":"YYYY-MM-DD", "ok":true|false }

Si no puedes extraer un monto claro, devuelve { "ok": false }.

Hoy es ${fechaHoy}.
REGLA CRÍTICA DE FECHA: Si el usuario NO menciona explícitamente una fecha (palabras como "ayer", "antier", "anteayer", "hoy", "el lunes/martes/...", "la semana pasada", "hace N días", "el 5", "5/5", "el 15 de abril", "3 de marzo", etc.), DEBES devolver fecha exactamente igual a "${fechaHoy}". NUNCA restes ni calcules días si el usuario no lo pide. Solo cuando el usuario diga "ayer" restas 1 día; "el lunes" / "la semana pasada" calculas la fecha correcta. Para fechas con día+mes ("el 15 de abril", "3 de marzo"), usa ese día y mes del año actual (o del año anterior si esa fecha aún no ha ocurrido este año). En cualquier otro caso, fecha = "${fechaHoy}" sin modificar.

tipo=ingreso: sueldo, salario, honorarios, abono recibido, ingreso, cobré, me pagaron, depósito recibido.
tipo=gasto: gasté, pagué, compré, anota un gasto, registra gasto. También cuenta como gasto: "boté", "tiré", "se me fueron", "perdí" (en contexto de dinero).

MODISMOS PERUANOS PARA SOLES (regla estricta 1:1, NUNCA multiplicar):
- "lucas" = soles. Ej: "50 lucas" = 50 soles. NUNCA interpretar como "1 luca = 1000 soles" aunque históricamente era así.
- "cocos" = soles. Ej: "20 cocos" = 20 soles.
- "mangos" = soles. Ej: "100 mangos" = 100 soles.
- "mortadelos" = soles. Ej: "30 mortadelos" = 30 soles.
- "soles", "S/", "S/.", "PEN" = soles (estándar).
- "dólares", "USD", "$", "verdes" = dólares (moneda=USD).
Si el usuario escribe sólo un número sin moneda, asumir PEN (soles).

CATEGORÍAS (usa exactamente):
Alimentación: delivery|restaurante|supermercado|mercado|cafeteria|snacks
Transporte: uber_cabify|taxi|bus_micro|metro_bus|gasolina|peaje|estacionamiento
Vivienda: alquiler|mantenimiento|electricidad|agua|gas|internet|cable
Salud: farmacia|medico|clinica|laboratorio|seguro_salud|optica
Entretenimiento: streaming|cine|juegos|bares_clubs|eventos|hobbies
Compras: ropa|calzado|electronico|hogar|belleza|mascotas
Educación: universidad|instituto|curso_online|utiles|idiomas|colegios
Finanzas: prestamo|tarjeta_credito|seguro|ahorro|inversion|comision_banco
Trabajo_Negocio: herramientas|publicidad|oficina|logistica|contador
Otros: regalo|donacion|multa|viaje|sin_categoria

Para ingresos: comercio="Sueldo" o la fuente del ingreso, categoria="Finanzas", subcategoria="sin_categoria".` },
      { role: 'user', content: msg }
    ],
    temperature: 0
  });
  const raw2 = res.choices[0].message.content.trim();
  const clean2 = raw2.startsWith('{') ? raw2 : raw2.slice(raw2.indexOf('{'), raw2.lastIndexOf('}') + 1);
  const parsed = JSON.parse(clean2);
  // Sub-1 fallback: si el modelo no extrajo monto pero el msg tiene "<1 + moneda explícita",
  // reconstruimos la TX manualmente. Cubre amt-006 (microtransacciones cripto/fee).
  if (!parsed.ok || !parsed.monto || parsed.monto <= 0) {
    const found = extraerMontoSub1ConMoneda(msg);
    if (found) {
      const tipo = RE_VERBO_GASTO_MSG.test(msg) ? 'gasto' : 'ingreso';
      return {
        ok: true,
        monto: found.monto,
        moneda: found.moneda,
        tipo,
        comercio: 'sin_descripcion',
        categoria: tipo === 'ingreso' ? 'Finanzas' : 'Otros',
        subcategoria: 'sin_categoria',
        fecha: fechaHoy,
      };
    }
  }
  return parsed;
}

async function parsearCorreccionesMultiples(msg) {
  try {
    const hoy = hoyPeru();
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `Eres un parser de correcciones de gastos financieros. La fecha de hoy es ${hoy}.
El usuario lista varios gastos que quiere reclasificar en un solo mensaje.
Extrae TODAS las correcciones y devuelve SOLO un array JSON con este formato:
[
  {
    "comercio": "nombre del comercio tal como aparece",
    "monto": numero o null,
    "fecha": "YYYY-MM-DD" o null,
    "categoria_nueva": "nombre de la categoria en español, capitalizada",
    "subcategoria_nueva": "subcategoria si se menciona, sino null"
  }
]
Reglas:
- "menu" o "almuerzo" → categoria_nueva="Alimentación"
- "gasolina" o "combustible" → categoria_nueva="Transporte", subcategoria_nueva="Gasolina"
- "uber", "taxi", "bus" → categoria_nueva="Transporte"
- "farmacia", "médico", "clinica" → categoria_nueva="Salud"
- Si dice "pasalo a X" o "ponlo en X" o "es de X" → categoria_nueva=X
- Si solo dice una palabra sin "pasalo"/"ponlo", esa palabra es la categoria o subcategoria
- Capitaliza la primera letra de categoria_nueva
IMPORTANTE: Devuelve SOLO el array JSON, sin texto adicional.`
      }, {
        role: 'user',
        content: msg
      }],
      temperature: 0
    });
    const raw = res.choices[0].message.content.trim();
    const arr = JSON.parse(raw.startsWith('[') ? raw : raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
    return Array.isArray(arr) ? arr : [];
  } catch(e) {
    log.error({ tag: 'PARSE_MULT', err: e.message }, 'Error parseando correcciones múltiples');
    return [];
  }
}

async function interpretarComandoPresupuesto(texto) {
  try {
    var aiRes = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Extrae datos de presupuesto. SOLO JSON: {"es_presupuesto":true/false,"categoria":"nombre","monto":numero,"alerta_porcentaje":numero 1-100 default 80}' }, { role: 'user', content: texto }], temperature: 0 });
    var raw = aiRes.choices[0].message.content.trim();
    return JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
  } catch(e) {
    // El fallback es legítimo (es_presupuesto:false = "no era un comando de presupuesto"),
    // pero era el único catch del backend sin log: un fallo del parser se veía igual que un
    // mensaje que no hablaba de presupuestos.
    log.error({ tag: 'PARSE_PRESUP', err: e.message }, 'Error interpretando comando de presupuesto');
    return { es_presupuesto: false };
  }
}

module.exports = {
  buildCategoriasCustomPrompt,
  canonizarComercio,
  esPasarelaSola,
  empiezaConPasarela,
  partirPasarela,
  extraerComercioPasarela,
  parsearCorreoBancario,
  parsearRegistroManual,
  parsearCorreccionesMultiples,
  interpretarComandoPresupuesto,
  extraerMontoSub1ConMoneda,
  extraerLast4,
  normalizarLast4,
};
