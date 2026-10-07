/**
 * Guards de seguridad para la clasificación NLP.
 *
 * Nota importante sobre acentos: `\b` en JS es ASCII, así que NO se usa antes de "último"
 * (la "ú" no es word-char y el boundary fallaría justo con la palabra que nos importa).
 * Los verbos de borrado van como stems con boundary solo al inicio, para cubrir todas las
 * conjugaciones (elimina/eliminar/eliminé, borra/borrar/borré, etc.).
 */

const RE_PIDE_ULTIMO =
  /[uú]ltim[oa]s?\b.{0,25}\b(movimiento|transacc|gasto|registro|compra|operaci)/i;
const RE_PIDE_ULTIMO_PREGUNTA =
  /\b(cu[aá]l|qu[eé]|mu[eé]stra|ens[eé][ñn]a|ver)\b.{0,30}[uú]ltim/i;
const RE_VERBO_BORRADO =
  /\b(borr|elimin|desha|quit|sac[ao]|cancel|reviert|revert|anul)/i;

// Verbo activo de registro/gasto (stems, boundary al inicio para cubrir conjugaciones).
const RE_VERBO_REGISTRO =
  /\b(gast[eé]|pagu[eé]|compr[eé]|regis?tr[aeoó]|an[oó]t[ao]|ap[uú]nt[ao]|invert[ií])/i;
// Presencia de un monto: dígito, número en palabras, o palabra de dinero.
const RE_MONTO_PRESENTE =
  /\d|\b(un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil)\b|\b(soles?|lucas?|mangos?|luquitas?|s\/)/i;

/**
 * ¿El mensaje pide VER el último movimiento/transacción sin ningún verbo de borrado?
 * Se usa para evitar que "el último movimiento" se ejecute como deshacer/eliminar
 * (caso Edgar, 23-jun-2026: pidió ver su último movimiento y Neto le borró el gasto).
 * @param {string} msg
 * @returns {boolean}
 */
function esVerUltimoMovimiento(msg) {
  const t = msg || '';
  const pide = RE_PIDE_ULTIMO.test(t) || RE_PIDE_ULTIMO_PREGUNTA.test(t);
  if (!pide) return false;
  return !RE_VERBO_BORRADO.test(t);
}

/**
 * ¿El mensaje es un REGISTRO DE GASTO NUEVO (verbo de gasto/registro + monto)?
 * Se usa en el webhook para NO dejar que el intercept de consultas pendientes
 * (intentarResolverConsulta) secuestre el mensaje: una nota de voz "registra un
 * gasto de diez soles en taxi" debe registrar el gasto, no categorizar un pendiente
 * al azar (bug 2026-07-14: se perdía el gasto y se corrompía un pendiente).
 * @param {string} msg
 * @returns {boolean}
 */
function esRegistroGastoNuevo(msg) {
  const t = msg || '';
  return RE_VERBO_REGISTRO.test(t) && RE_MONTO_PRESENTE.test(t);
}

/* ─── Salvavidas del 429: extraer un gasto SIN IA ─────────────────────────────
 *
 * Cuando OpenAI devuelve 429 el clasificador no responde, y la regla del producto es
 * que escribir nunca se corta: un 429 es problema nuestro, no del usuario. Así que se
 * intenta reconstruir el gasto por regex y guardarlo igual.
 *
 * Vive acá y no en `message-processor` para poder probar la DECISIÓN sin montar el
 * pipeline entero: esta función es pura y no toca la DB. El que persiste es
 * `salvarGastoSinIA`, que ya no decide nada.
 *
 * La versión anterior tomaba el PRIMER número del mensaje, sin preguntarse si el
 * mensaje era un gasto, y lo guardaba siempre como soles. O sea que durante un 429
 * "¿cuánto gasté en los últimos 30 días?" registraba un gasto de S/30, y
 * "gasté 100 dólares en zapatillas" entraba como S/100 (el mismo bug B15 que ya se
 * arregló en el prompt de Vision).
 *
 * Cuatro decisiones, todas conservadoras: el costo de salvar mal es una fila de plata
 * inventada que nadie va a ir a buscar.
 *
 *  1. Los RECHAZOS corren antes que la evidencia positiva. "¿cuánto gasté...?" tiene
 *     verbo de gasto: si el verbo se mirara primero, la consulta entraría como gasto.
 *  2. El monto es el primero DESPUÉS del verbo, no el primero del mensaje. En
 *     "hace 3 días pagué 80 de luz" el primer número es 3.
 *  3. Un número con separador de miles ("1.500") es ambiguo entre 1500 y 1.50 y NO se
 *     adivina. Y un número SOBRE el techo corta la búsqueda en vez de pasar al
 *     siguiente: "pagué 1000000 en 5 cosas" no puede terminar registrando S/5.
 *  4. Los interrogativos y los verbos-comando solo cuentan AL PRINCIPIO del mensaje.
 *
 * ── Por qué el punto 4, y por qué el argumento que había acá era falso ──────────
 *
 * La primera versión rechazaba `que`, `como`, `cuando`, `donde` y `cambio` en
 * cualquier posición, y lo justificaba diciendo "el costo de no salvar es que el
 * usuario reenvía el mensaje y listo". **Eso es mentira y una revisión adversarial lo
 * marcó.** Esta función es pura y determinista: reenviar el mismo texto cae en la
 * misma rama. Mientras dure el 429, "gasté 20 en el taxi que me llevó al trabajo" no
 * se registra NUNCA — y el mensaje que el usuario recibe le promete lo contrario.
 *
 * Un falso rechazo no es "un reintento": es la pérdida del gasto, que es exactamente
 * lo que este salvavidas existe para evitar. Y las palabras funcionales del español
 * (`que`, `como`, `cuando`, `donde`) aparecen en una fracción enorme de las frases
 * naturales, así que el filtro se estaba comiendo el caso común.
 *
 * En español la pregunta se FORMA al principio ("cuánto gasté", "¿dónde...?"), y el
 * comando también ("borra el gasto de 50"). En el medio de la frase esas mismas
 * palabras son relativos y sustantivos. Anclarlos al inicio conserva el rechazo que
 * importa —que es el ejemplo textual del hallazgo— y devuelve el caso común.
 */

/**
 * Fronteras de palabra que SÍ conocen los acentos.
 *
 * `\b` en JS es ASCII, y la cabecera de este archivo ya lo advierte: la "é" no es
 * word-char, así que en `/\b(gast[eé])\b/` el `\b` final **no matchea "gasté"** —
 * justo la conjugación que importa. La primera versión de este bloque lo usaba y el
 * filtro entero quedaba mudo sobre "gasté 20 en propina": sin verbo, sin moneda y con
 * más de cuatro palabras, el mensaje caía como "no es un registro" y no se salvaba
 * nada. Lo delataron los tests, no la lectura.
 *
 * Con lookarounds sobre el rango latino, "gasté" cierra palabra y "gastemos" no se
 * confunde con ella.
 */
const INI = '(?<![0-9A-Za-zÀ-ÿ_])';
const FIN = '(?![0-9A-Za-zÀ-ÿ_])';
const pal = (alternativas, flags = 'i') => new RegExp(INI + '(?:' + alternativas + ')' + FIN, flags);

/**
 * Un signo de interrogación en cualquier parte, o una palabra de pregunta/comando AL
 * PRINCIPIO. `arranca()` tolera un `¿` y un saludo corto delante, que es como la gente
 * escribe por WhatsApp ("oye cuánto gasté", "hola, borra el último").
 */
const RELLENO_INICIAL = '(?:(?:oye|hola|hey|buenas|neto|ok|ya|y|pero|a\\s+ver|por\\s+favor|porfa)[\\s,]+)*';
const arranca = (alternativas) =>
  new RegExp('^\\s*[¿¡]?\\s*' + RELLENO_INICIAL + '[¿¡]?\\s*(?:' + alternativas + ')' + FIN, 'i');

// Consultas. Sin esto un 429 convierte cada pregunta con un número en un gasto.
//
// Las palabras van ANCLADAS AL INICIO: `que`, `como`, `cuando` y `donde` sin tilde son
// relativos, no interrogativos, y buscarlas en cualquier posición rechazaba
// "gasté 20 en el taxi QUE me llevó al trabajo" — o sea el caso común. El `?`/`¿` sí
// vale en cualquier lado, porque ahí la forma es inequívoca.
const RE_SIGNO_PREGUNTA = /[?¿]/;

/**
 * La forma ACENTUADA de un interrogativo no es ambigua: `qué`, `cómo`, `cuándo`,
 * `dónde`, `cuánto` con tilde SIEMPRE preguntan. Esas rechazan en cualquier posición.
 *
 * Anclar todo al inicio arregló el falso rechazo masivo pero abrió el caso opuesto, y
 * la segunda revisión adversarial lo midió: *"el sueldo de 3000 cuando entra"* es una
 * consulta pura y fabricaba un **INGRESO de S/3000**, que va al ahorro y al score. La
 * forma "X de N … cuándo/cuánto" es normal y no arranca con el interrogativo.
 *
 * No cubre a quien no tildea —y mucha gente no tildea en WhatsApp—, así que las formas
 * sin tilde siguen ancladas al inicio: ahí son relativos, no preguntas. Es una mejora
 * estricta sobre las dos versiones anteriores, no una solución completa.
 */
const RE_PREGUNTA_ACENTUADA = pal('cuánt[oa]s?|cuál(?:es)?|qué|cómo|cuándo|dónde|por\\s*qué');

const RE_PREGUNTA_INICIO = arranca(
  'cu[aá]nt[oa]s?|cu[aá]l(?:es)?|qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|por\\s*qu[eé]|'
  + 'mu[eé]stra\\w*|dime|dame|ens[eé][ñn]a\\w*|lista\\w*|res[uú]men|reporte|balance|saldo');

// Sustantivos que dicen "esto es otra cosa, no un gasto", en cualquier posición: si el
// mensaje habla de un presupuesto o de una deuda, el número que trae es de eso.
const RE_OTRO_DOMINIO = pal(
  'presupuest\\w*|metas?|ahorr\\w*|recordatorio\\w*|alert\\w*|deudas?|debo|me\\s+debe|'
  + 'suscripci\\w*|categor[ií]as?');

// Verbos-comando, SOLO al inicio. En el medio son sustantivos o relativos:
// "gasté 30 en el CAMBIO de aceite" es un gasto; "CAMBIA los 40 de ayer" es un comando.
const RE_COMANDO_INICIO = arranca(
  'elimin\\w*|borr\\w*|corrig\\w*|corregir|cambi[ao]\\w*|cambiar|edit\\w*|recategoriz\\w*|'
  + 'desha[cz]\\w*|divid\\w*|pon\\w*|mueve|mover|crea\\w*|agrega\\w*|a[ñn]ad\\w*|limita\\w*');

// Intención futura o hipotética: no es un registro.
const RE_FUTURO = pal('ma[ñn]ana|voy\\s+a|vamos\\s+a|pienso|planeo|quiero|quisiera|ser[ií]a|si\\s+gast\\w+');

// Verbos de GASTO. `compre`/`cobre` sueltos salían sobrando: `compr[eé]` ya matchea
// las dos formas, así que eran ramas inalcanzables que se leían como cobertura.
//
// `me\s+prest[eé]` lleva el "me" de vuelta: sin él, `prest[eé]` matchea "PRESTÉ 100 a
// Juan", que es una DEUDA (yo presto), no un gasto mío. El "me" es lo que invierte la
// dirección, y la versión anterior lo había perdido al reescribir la lista.
const VERBOS_GASTO = 'gast[eé]|pagu[eé]|pagu?e|compr[eé]|bot[eé]|tir[eé]|perd[ií]|invert[ií]|me\\s+prest[eé]';
// Verbos de INGRESO — CONJUGADOS. `sueldo`, `salario` y `depósito` salieron de acá a
// propósito: son SUSTANTIVOS, y como evidencia de que hubo un movimiento son mucho más
// débiles que un verbo. La segunda revisión adversarial midió el precio de tratarlos
// igual: *"el sueldo de 3000 cuando entra"* es una pregunta y registraba un INGRESO de
// S/3000. Sin verbo, sin moneda y con seis palabras, ahora no es evidencia de nada.
//
// No se pierde el caso real: quien reporta un sueldo cobrado escribe un verbo
// ("me pagaron 2000", "cobré 500 del sueldo"), y ahí el sustantivo viaja igual.
const VERBOS_INGRESO = 'cobr[eé]|me\\s+pagaron|me\\s+pag[oó]|me\\s+abonaron|recib[ií]';
const VERBOS_TX = VERBOS_GASTO + '|' + VERBOS_INGRESO;

const RE_VERBO_TX = pal(VERBOS_TX);
const RE_VERBO_INGRESO = pal(VERBOS_INGRESO);

// Moneda explícita. Los modismos peruanos ("lucas", "cocos", "mangos", "mortadelos")
// son soles 1:1 — la misma regla que el prompt de `parsearRegistroManual`.
// El `$` va aparte: no es letra, así que las fronteras de palabra no aplican.
const RE_MONEDA_USD = new RegExp('\\$|' + INI + '(?:USD|d[oó]lares?|d[oó]lar|verdes)' + FIN, 'i');
const RE_MONEDA_PEN = new RegExp('S\\/\\.?|' + INI + '(?:PEN|soles?|lucas?|cocos?|mangos?|mortadelos?)' + FIN, 'i');

// Monedas que Neto NO anota. `guardarTransaccion` sólo convierte USD, así que un rescate que
// leyera "gasté 20 euros en un polo" guardaba S/20.
//
// Cuenta sólo PEGADA A UNA CIFRA ("20 euros", "18€", "EUR 30"). La primera versión buscaba la
// palabra en cualquier lado y la segunda revisión adversarial la hizo negarse a "gasté 410 soles
// comprando euros" y a "50 soles en la Euro Shop", que son gastos en soles. Con la cifra al
// lado, además, se pueden sumar monedas cuyo nombre es palabra común ("pesos", "reales").
// "libras" queda afuera a propósito: en un mercado también es peso ("2 libras de pollo").
const MONEDAS_NO_SOPORTADAS = '€|£|eur|euros?|euritos?|gbp|esterlinas?|pesos?|reales|bolivianos?|yenes?|yuanes?|francos?';
const RE_MONEDA_NO_SOPORTADA = new RegExp(
  '\\d\\s*(?:' + MONEDAS_NO_SOPORTADAS + ')' + FIN + '|(?:€|£|' + INI + '(?:eur|gbp)' + FIN + ')\\s*\\d', 'i');

// El SENTIDO que dice un verbo explícito. Sirven para un invariante del handler, no para
// clasificar: si el parser registra un tipo que contradice al único sentido que el mensaje
// nombra, no se guarda y se pregunta. El prompt se reajustó tres veces el 30-sep y cada ajuste
// dio vuelta un signo distinto ("me cobraron" salía ingreso; "me yapearon 50", gasto); esto no
// depende del prompt.
const RE_SENTIDO_INGRESO = pal(
  'me\\s+(?:yapearon|yape[oó]|plinearon|pline[oó]|pagaron|pag[oó]|depositaron|deposit[oó]|transfirieron|transfiri[oó]|'
  + 'abonaron|abon[oó])|cobr[eé]|vend[ií]');
// Sólo verbos que hablan de PLATA. "gané", "recibí", "me dio", "me mandó" salieron: la tercera
// revisión midió preguntas innecesarias sobre gastos bien leídos ("me gané una multa de 80",
// "recibí mi pedido de rappi 35", "me dio flojera cocinar, delivery 35", "mi mamá me mandó a
// comprar pan 5"). "vendí" entra para que "vendí mi celular que compré…" no sea contradicción.
const RE_SENTIDO_GASTO = pal(
  'gast[eé]|pagu[eé]|compr[eé]|yape[eé]|pline[eé]|transfer[ií]|bot[eé]|invert[ií]|me\\s+prest[eé]|'
  + 'me\\s+(?:cobraron|cobr[oó]|descontaron|descont[oó]|debitaron|debit[oó])');

/**
 * ¿El tipo que devolvió el parser contradice el verbo del mensaje? Sólo cuando el mensaje nombra
 * UN sentido: con los dos ("me pagaron 500 y gasté 100") no hay contradicción que afirmar.
 */
function tipoContradiceElMensaje(tipo, msg) {
  const t = String(msg == null ? '' : msg);
  const ing = RE_SENTIDO_INGRESO.test(t);
  const gas = RE_SENTIDO_GASTO.test(t);
  if (ing === gas) return false;
  return tipo === 'gasto' ? ing : tipo === 'ingreso' ? gas : false;
}

// Números dichos en palabras: ahí el monto no está en dígitos y no hay nada que comparar.
const RE_NUMERO_EN_PALABRAS = pal(
  'cero|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|'
  + 'diecis\\w+|veinti\\w*|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|'
  + 'cien|ciento|\\w+cientos|quinientos|mil|medio|media|punto');

/**
 * ¿El monto que registraría el parser está ESCRITO en el mensaje? Invariante contra el monto
 * inventado o mal leído: "s/.25 menú" salía S/0.25 y "Oe 15 mangos InDriver" dio S/100 en una
 * corrida (aceptación y revisión del 30-sep). Si no está, el handler REBOTA pidiendo el número:
 * no le pasa la decisión al rescate, porque la tercera revisión mostró que otro lector adivinando
 * es peor ("me depositaron 15mil soles" terminaba como gasto S/15).
 *
 * Cada cifra aporta sus lecturas posibles: con el separador como decimal ("1,50" = 1.5), como
 * miles ("1,500" = 1500), miles con decimales ("1,250.80"), espacio de miles ("1 500"), con
 * "k" o "mil" ("2mil" = 2000), con "céntimos" ("50 céntimos" = 0.5) y, si viene precedida de un
 * punto suelto que no es el de "S/.", como decimal sin cero (".50" = 0.5).
 */
function montoEscritoEnMensaje(monto, msg) {
  const t = String(msg == null ? '' : msg);
  const m = Number(monto);
  if (!Number.isFinite(m)) return false;
  // Sin ninguna cifra, el monto vino en palabras ("ciento diez punto setenta") y no hay contra
  // qué comparar. Con cifras, se compara contra ELLAS aunque haya palabras de número: con la
  // excepción amplia, "compré una pizza 35" leído como 350 pasaba (tercera revisión).
  if (!/\d/.test(t)) return RE_NUMERO_EN_PALABRAS.test(t);
  // Una cifra con separadores de miles y/o decimales ("1,250.80", "1.500", "1 500", "12,50").
  for (const x of t.matchAll(/\d{1,3}(?:[ .,]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d+)?/g)) {
    const tok = x[0];
    const limpio = tok.replace(/ /g, '');
    const ultimoSep = Math.max(limpio.lastIndexOf('.'), limpio.lastIndexOf(','));
    const lecturas = [parseFloat(limpio.replace(/[.,]/g, '')), parseFloat(limpio.replace(',', '.'))];
    if (ultimoSep >= 0) {
      lecturas.push(parseFloat(limpio.slice(0, ultimoSep).replace(/[.,]/g, '') + '.' + limpio.slice(ultimoSep + 1)));
    }
    const despues = t.slice(x.index + tok.length);
    const base = lecturas.slice();
    // "2mil", "15 mil", "15k" y "50 céntimos": sin estas lecturas la guarda rebotaba montos
    // bien leídos por el modelo (tercera revisión).
    if (/^\s*(?:k|mil)(?![a-záéíóúñ])/i.test(despues)) base.forEach((v) => lecturas.push(v * 1000));
    if (/^\s*(?:c[eé]ntimos?|cts?|cent)(?![a-záéíóúñ])/i.test(despues)) base.forEach((v) => lecturas.push(v / 100));
    const antes = t.slice(Math.max(0, x.index - 2), x.index);
    if (/[.,]$/.test(antes) && !/\/[.,]$/.test(antes)) lecturas.push(parseFloat('0.' + tok.replace(/[ .,]/g, '')));
    if (lecturas.some((v) => Math.abs(v - m) < 0.005)) return true;
  }
  return false;
}

// Separador seguido de EXACTAMENTE tres dígitos: "1.500" / "1,500". Ambiguo.
const RE_MILES_AMBIGUO = /\d[.,]\d{3}(?!\d)/;

// Un número con hasta 2 decimales, que no sea la cabeza de uno más largo.
const RE_MONTO = /\d+(?:[.,]\d{1,2})?(?!\d)/g;

// Lo que viene DESPUÉS de un número y lo descalifica como monto: unidades de tiempo,
// cantidades, porcentajes y la hora ("3:30").
const RE_UNIDAD_NO_MONETARIA =
  /^\s*(?:d[ií]as?|horas?|hrs?|min(?:utos?)?|semanas?|mes(?:es)?|a[ñn]os?|personas?|veces|kg|gr(?:amos?)?|km|litros?|unidades?|%)\b|^:/i;

// Ruido que no aporta al nombre del comercio: el verbo, los conectores y la moneda.
const RE_RUIDO_COMERCIO = pal(VERBOS_TX + '|me|en|de|del|la|el|los|las|por|para|un|una|mi|al', 'gi');
const RE_RUIDO_MONEDA = new RegExp(
  '\\$|S\\/\\.?|' + INI + '(?:USD|d[oó]lares?|d[oó]lar|verdes|PEN|soles?|lucas?|cocos?|mangos?|mortadelos?)' + FIN, 'gi');

const MAX_MONTO_SALVAGE = 999999.99;

/**
 * Primer número del texto a partir de `desde` que puede ser un monto, o null.
 *
 * Dos salidas distintas y no da lo mismo cuál:
 *  - un número con UNIDAD pegada ("3 días", "2 kg") no es un monto → sigue buscando.
 *  - un número FUERA DE RANGO corta la búsqueda → devuelve null.
 *
 * La segunda la trajo la revisión adversarial: con `continue`, "pagué 1000000 en 5
 * cosas" saltaba el millón y registraba **S/5**, dejando el monto real de nombre de
 * comercio. Es la misma clase de adivinanza que el separador de miles, que este módulo
 * ya declara que no se adivina — no se puede rechazar una y aceptar la otra.
 */
function primerMonto(texto, desde) {
  for (const m of texto.matchAll(RE_MONTO)) {
    if (m.index < desde) continue;
    if (RE_UNIDAD_NO_MONETARIA.test(texto.slice(m.index + m[0].length))) continue;
    // Una corrida de 8+ dígitos seguidos es un IDENTIFICADOR (recibo, DNI, RUC,
    // celular), no un importe: se salta y se sigue buscando. Sin esto, el corte por
    // "fuera de rango" mataba el rescate entero en "pagué mi recibo 1234567890 de 80
    // soles" — el número del recibo va ANTES del monto, así que abortaba con el 80
    // todavía por leer. La versión previa a esa lo salvaba.
    if (/^\d{8,}$/.test(m[0])) continue;
    const n = parseFloat(m[0].replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n > MAX_MONTO_SALVAGE) return null;
    return { monto: n, token: m[0], index: m.index };
  }
  return null;
}

/**
 * ¿Este mensaje es un registro de gasto/ingreso reconstruible sin IA?
 *
 * @param {string} msg
 * @returns {{monto:number, moneda:'PEN'|'USD', tipo:'gasto'|'ingreso', comercio:string}|null}
 */
function extraerGastoSinIA(msg) {
  const texto = (msg || '').trim();
  if (!texto) return null;

  // (1) Rechazos primero — ver la nota de arriba.
  if (RE_SIGNO_PREGUNTA.test(texto)) return null;
  if (RE_PREGUNTA_ACENTUADA.test(texto)) return null;
  if (RE_PREGUNTA_INICIO.test(texto)) return null;
  if (RE_COMANDO_INICIO.test(texto)) return null;
  if (RE_OTRO_DOMINIO.test(texto)) return null;
  if (RE_FUTURO.test(texto)) return null;
  if (RE_MILES_AMBIGUO.test(texto)) return null;
  // Adentro del extractor y no en cada call-site: lo usan el rescate de `registrar_manual` y
  // `salvarGastoSinIA` (el 429), y en los dos un monto en euros se guardaba como soles.
  if (RE_MONEDA_NO_SOPORTADA.test(texto)) return null;

  // (2) Evidencia positiva de que esto es una transacción. La tercera forma —número
  // suelto + una o dos palabras— es EL caso que este salvavidas existe para cubrir
  // (Ricardo, "4.10 pastillas"): no tiene verbo ni moneda, y sin ella el rescate no
  // rescata nada.
  const verbo = texto.match(RE_VERBO_TX);
  const esUsd = RE_MONEDA_USD.test(texto);
  const esPen = RE_MONEDA_PEN.test(texto);
  const palabras = texto.split(/\s+/);
  const desnudo = palabras.length <= 4 && /^\d/.test(palabras[0]);
  if (!verbo && !esUsd && !esPen && !desnudo) return null;

  // (3) El monto: después del verbo si lo hay.
  const hallado = (verbo && primerMonto(texto, verbo.index + verbo[0].length))
    || primerMonto(texto, 0);
  if (!hallado) return null;

  // Con las dos monedas nombradas no hay forma de saber cuál gana; PEN es el default
  // del resto del pipeline y el que menos sorprende en Perú.
  const moneda = esUsd && !esPen ? 'USD' : 'PEN';
  // El verbo de GASTO gana sobre la palabra de ingreso: "compré abono 50 para las
  // plantas" es un gasto, y con el orden al revés entraba como INGRESO — o sea con el
  // signo invertido, inflando ingresos, ahorro y score. Venía así desde el `esIngreso`
  // viejo y viajó intacto en la mudanza; lo encontró la revisión adversarial.
  // Se decide con EL VERBO QUE PRODUJO EL MONTO, no con el texto entero.
  //
  // Dos versiones invirtieron el signo, cada una por su lado. La primera miraba solo
  // las palabras de ingreso: "compré abono 50" entraba como INGRESO. La segunda lo
  // arregló con "cualquier verbo de gasto gana" y rompió el mixto: en "me pagaron 500 y
  // compré 100 de comida" el monto sale del verbo de ingreso (500) y el tipo del de
  // gasto, o sea un ingreso registrado como gasto. Las dos son la misma falla: el monto
  // y el tipo se decidían con reglas distintas. Atarlos al mismo verbo cierra las dos.
  const tipo = verbo && RE_VERBO_INGRESO.test(verbo[0]) ? 'ingreso' : 'gasto';

  // Se corta POR ÍNDICE, no con `.replace(token)`. `replace` borra la primera aparición
  // TEXTUAL del token, y desde que el monto es "el primero después del verbo" esa no es
  // necesariamente la que se eligió: en "hace 3 días pagué 3 soles de pan" borraba el 3
  // de los días y el monto quedaba DENTRO del nombre del comercio ("hace días 3 pan"),
  // que es lo que se persiste y lo que el usuario ve en la confirmación.
  const sinMonto = texto.slice(0, hallado.index) + ' ' + texto.slice(hallado.index + hallado.token.length);
  let comercio = sinMonto
    .replace(RE_RUIDO_COMERCIO, ' ')
    .replace(RE_RUIDO_MONEDA, ' ')
    .replace(/\s+/g, ' ').trim();
  if (comercio.length > 40) comercio = comercio.slice(0, 40);

  return { monto: hallado.monto, moneda, tipo, comercio };
}

/**
 * El texto sin sus tokens de moneda.
 *
 * Se exporta porque el rescate de `registrar_manual` necesita preguntar "¿este mensaje es
 * SOLO un número?" —un saldo dictado no es un gasto— y armar allá su propia lista de monedas
 * la deja divergir de ésta a la primera vez que alguien agregue un modismo. No es teórico:
 * la primera versión tenía lista propia y aceptaba la moneda solo como prefijo, así que
 * "592.91 usd" se le escapaba y entraba como gasto en DÓLARES, o sea multiplicado por el
 * tipo de cambio en `monto_pen`. Lo encontró la revisión adversarial.
 */
function quitarTokensDeMoneda(texto) {
  return String(texto == null ? '' : texto).replace(RE_RUIDO_MONEDA, ' ');
}

/**
 * Cuántos números del texto podrían ser un monto.
 *
 * Comparte los filtros de `primerMonto` (unidad no monetaria pegada, corridas de 8+ dígitos
 * que son identificadores, rango válido) porque están en este módulo: una segunda copia de
 * esas reglas es justo lo que este archivo viene evitando.
 *
 * Difiere en UNA cosa, a propósito: `primerMonto` ABORTA al toparse con un número fuera de
 * rango (para no saltearse el monto real y quedarse con un número menor), y acá solo se
 * cuenta. Contar es para decidir si el mensaje es ambiguo, y un número gigante lo vuelve
 * MÁS ambiguo, no menos.
 */
function contarMontosCandidatos(texto) {
  const t = String(texto == null ? '' : texto);
  let n = 0;
  for (const m of t.matchAll(RE_MONTO)) {
    if (RE_UNIDAD_NO_MONETARIA.test(t.slice(m.index + m[0].length))) continue;
    if (/^\d{8,}$/.test(m[0])) continue;
    const v = parseFloat(m[0].replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0 || v > MAX_MONTO_SALVAGE) continue;
    n++;
  }
  return n;
}

/**
 * Los intents que BORRAN filas del usuario. Los leen dos guardas: la de "es una pregunta"
 * (`message-processor.js`) y el turno que sigue al menú de borrar la cuenta (`dispatchIntent`,
 * 07-oct-2026), donde no corren porque con el menú abierto borrar es la frase de confirmación.
 *
 * Se decide por EFECTO (un DELETE), no por nombre ni por "suena destructivo": la segunda revisión
 * del 07-oct midió que frenar también lo que cierra o salda (`abandonar_plan`, `marcar_deuda_pagada`,
 * `consolidar_deudas`, que es una lectura…) le comía al usuario la respuesta a "¿ya te pagó?" del cron
 * de deudas, que es justo el mensaje que este arreglo vino a no perder. Cerrar una deuda que la
 * persona dice que se pagó no es borrar nada. `restaurar_eliminado` no entra: devuelve, no quita.
 *
 * Lo vigila `tests/handlers/menu-borrado-mensaje-siguiente.test.js`: todo `.delete(` de
 * `handlers/intents/` cae en un intent de este set o en una exención con motivo, y `registrar_deuda`
 * (que borra la anotación opuesta reciente) salta ese DELETE con `ctx.sinBorrados`.
 */
const INTENTS_QUE_BORRAN = new Set(['eliminar_transaccion', 'deshacer_ultimo', 'eliminar_meta', 'eliminar_presupuesto']);

/**
 * ¿El mensaje nombra la CUENTA (o lo que se haría con ella) y no solo "todo"? (07-oct-2026)
 *
 * El clasificador mandaba "empecemos de cero, cancela todo" a `desconectar_cuenta`, o sea al menú
 * de ELIMINAR LA CUENTA. Lo más destructivo que hay se abre solo con un pedido explícito; lo vago
 * (reiniciar, empezar de cero, borrar todo) recibe el texto de `reiniciar_o_borrar`, que ya le dice
 * a quien de verdad se quiere ir que escriba *borrar mi cuenta*. Decidido por Favio con la medición
 * en `docs/DEFECTOS.md` (07-oct). `gmail`/`correo`/`mail`/`desconect`/`desvincul` están porque el
 * mismo intent es el de desconectar el Gmail, que no borra nada. "elimíname", "bórrame" nombran a
 * la persona, y eso es la cuenta.
 *
 * Solo decide sobre lo que el clasificador YA mandó a `desconectar_cuenta`: una frase vaga que pasa
 * ("borra la cuenta del chifa") abre el menú, y desde el 07-oct eso no se come el mensaje siguiente.
 */
function pideCuentaExplicita(msg) {
  const t = String(msg == null ? '' : msg).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return /\b(cuentas?|account|datos|informacion|perfil|usuario|gmail|correos?|e-?mail|mail|whatsapp|desconect\w*|desvincul\w*|baja|(?:elimin|borr)a?me)\b/.test(t);
}

module.exports = {
  INTENTS_QUE_BORRAN,
  pideCuentaExplicita,
  tipoContradiceElMensaje,
  montoEscritoEnMensaje,
  mencionaMonedaNoSoportada: (t) => RE_MONEDA_NO_SOPORTADA.test(String(t == null ? '' : t)),
  esVerUltimoMovimiento,
  esRegistroGastoNuevo,
  extraerGastoSinIA,
  quitarTokensDeMoneda,
  contarMontosCandidatos,
};
