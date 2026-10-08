// La DIRECCIÓN de un préstamo la decide el VERBO, no el clasificador (07-oct-2026).
//
// Lo que pasó en prod (usuario d21c11e0): "Y preste 118 soles" → "Anotado. Le debes S/ 118.00 a
// desconocida" (era al revés: prestó ella, y lo corrigió sola); "Me preste 50 soles" entró como GASTO
// Finanzas > Prestamo; y con `tool_choice: 'required'` "Me pagó mi tío 150 que me debía" creaba una
// deuda NUEVA 3 de 3 en vez de abonar (docs/DEFECTOS.md, 30-sep). El modelo adivina la dirección; el
// verbo la dice. Cuando el verbo no la dice, se pregunta: anotar una deuda al revés es plata mal
// guardada, y una pregunta de más cuesta un mensaje.
//
// LA REGLA (solo cuenta una forma con PLATA en su cláusula, después del verbo: un monto o una
// palabra de dinero; "me prestó su carro y le eché 50" es un gasto):
//   me deben   "le/les/te/se lo presté" (con o sin tilde: el pronombre dice a quién), "presté N a X"
//              y "preste N a X" (con destinatario), "le he prestado", "me pidió prestado"
//   debo       "me prestó", "me prestaron", "me prestaste", "me ha prestado", "pedí prestado"
//   ambiguo    "me presté" (en Perú se usa para "pedí prestado" y también para un gasto), "presté" o
//              "preste" sin pronombre ni destinatario ("presté 1500 al banco" es "me presté" sin el
//              "me"), un mensaje con las dos direcciones, y el discurso referido sin comillas
//   nada       lo negado ("no le presté"), lo citado entre comillas (lo dijo otro), el subjuntivo
//              ("que me lo preste", "si le preste"), y lo que otros se prestan entre ellos
//
// Y el ABONO a una deuda que ya existe: un verbo de pago con la referencia a esa deuda ("me pagó…
// que me debía", "le devolví lo que me prestó") es un abono, no una deuda nueva. El lado sale del
// verbo de pago: "me pagó" solo puede bajar lo que ME deben.
//
// Se aplica en `dispatchIntent` (handlers/intent-registry.js), antes del muro, para que la cubran
// todos los caminos que despachan (la continuación de un mensaje compuesto también). El handler de
// `registrar_deuda` vuelve a mirar la dirección con la misma función, y `extraerGastoSinIA` rechaza
// todo mensaje con un verbo de préstamo: un préstamo nunca entra como gasto.
//
// ALCANCE, después de tres vueltas de revisión adversarial el 07-oct (cada heurística para separar
// "préstamo de plata" de "cosa prestada" o leer un abono parcial abrió un error nuevo que escribía
// plata mal): el código ESCRIBE solo en dos casos, la dirección de lo que el clasificador ya llamó
// deuda y el abono limpio con una sola cifra. Todo lo demás que nombre un préstamo, PREGUNTA. Lo que
// eso cuesta, aceptado: preguntas de más ("Presté 200 a Juan" leído como gasto, un abono parcial "50 de
// los 200", la cuota de un préstamo "de lo que me prestaron"). Ver `enrutarPorVerbo`.
'use strict';

const LETRA = 'a-záéíóúüñ';
const NLA = '(?<![' + LETRA + '])';
const NLD = '(?![' + LETRA + '])';

const CLITICOS = new Set(['me', 'te', 'le', 'les', 'se', 'lo', 'la', 'los', 'las', 'nos']);
const NEGACIONES = new Set(['no', 'nunca', 'jamás', 'jamas', 'ni']);
// Delante de "preste" sin tilde marcan subjuntivo o hipótesis: no es plata que ya se movió.
const SUBJUNTIVO = new Set(['que', 'si', 'cuando', 'apenas']);
const CORTE_CLAUSULA = /[,.;:!?¿¡()]/;

/**
 * Minúsculas, sin lo citado (lo dijo otro) y con los espacios colapsados. Las comillas que envuelven
 * el mensaje ENTERO no son una cita: es la plantilla que el bot le mostró, copiada tal cual. La
 * revisión del 07-oct lo midió: `"le presté 118 a mi mamá"`, entre comillas, volvía a salir `debo`.
 */
function prepararTexto(msg) {
  let t = String(msg == null ? '' : msg).toLowerCase().trim();
  // Solo si las comillas envuelven el mensaje ENTERO y no hay otras adentro (segunda revisión del
  // 07-oct: `"Te presté 200" me reclama Juan` perdía la comilla del borde y la cita quedaba suelta).
  const envuelto = t.match(/^[_*\s]*["“«]([^"“”«»]*)["”»][_*\s]*$/);
  if (envuelto) t = envuelto[1];
  return t.replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, ' ').replace(/\s+/g, ' ').trim();
}

// Lo que dijo otro. Una comilla que quedó sin pareja, una cita entre comillas simples que nombra un
// préstamo ("Juan me dijo 'te presté 200'"), o un verbo de decir sin comillas ("Juan me dijo: te
// presté 200"): no hay cómo saber dónde termina la cita, así que con un préstamo adentro se pregunta.
const RE_DISCURSO = new RegExp(NLA + '(?:dijo|dice|dicen|dijeron|dices|reclam[aoó]n?|escrib(?:e|en|i[oó]|ieron)|coment[aoó]|cont[oó]|puso|pone|'
  + 'mand[aoó]\\s*(?::|a\\s+decir))' + NLD + '|["“”«»]|\'[^\']*prest');
// Una sospecha en cualquier parte del mensaje: el pago que se cuenta no es seguro.
const RE_SOSPECHA = new RegExp(NLA + '(?:mentira|falso|supuestamente|creo|parece|pero\\s+no|aunque|'
  + 'todav[ií]a\\s+no|a[uú]n\\s+no|no\\s+(?:me\\s+|le\\s+)?(?:lleg|cay|entr|ha\\s+lleg)\\w*)' + NLD);
// Una negación, una condición o un pago que todavía no ocurrió ANTES del verbo de pago ("si Juan me
// pagó…", "no me pagó…", "quiere que le pague…", "cuando le pague…"). Después del verbo es un cierre
// normal ("…ya no me debe nada") y no cuenta (segunda revisión del 07-oct). El subjuntivo lo midió la
// cuarta: "Mi hermana quiere que le pague los 300 que le debo" abonaba 300.
const RE_DUDA_ANTES = new RegExp(NLA + '(?:no|nunca|jam[aá]s|todav[ií]a|a[uú]n|si|que|cuando|apenas|hasta|para|ojal[aá]|'
  + 'quiere|quiero|quieren|tengo|tiene|tienes|voy|va|vas|debo|debe|necesito|necesita|pidi[oó]|pide|espero|esperar)' + NLD);
// La plata en palabras o en fracción: "la mitad de los 300", "cien de los 300" tienen dos cantidades
// aunque haya un solo dígito (cuarta revisión del 07-oct).
const RE_CANTIDAD_EN_PALABRAS = new RegExp(NLA + '(?:mitad|medio|tercio|cuarto|parte|diez|once|doce|quince|veinte|veinti\\w+|'
  + 'treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|\\w+cientos|quinientos|mil|todo|toda)' + NLD + '|%', 'g');

/** Las palabras de la cláusula que termina justo antes de `idx`. */
function palabrasAntes(t, idx) {
  const tramo = t.slice(0, idx).split(CORTE_CLAUSULA).pop();
  return tramo.split(new RegExp('[^' + LETRA + ']+')).filter(Boolean);
}

/** Lo que sigue a la forma, hasta el fin de la cláusula. */
function clausulaDespues(t, idx) {
  // La coma de miles ("1,500") no corta (segunda revisión del 07-oct).
  return t.slice(idx).split(/,(?!\d)|[.;:!?](?!\d)|\sy\s|\spero\s/)[0];
}

// El DESTINATARIO tiene que parecer una persona: "a mi madre", "a Juan". No "a las 3", "a la semana",
// "a pagar en 12 cuotas" (un infinitivo), "a plazo fijo", ni una institución ("presté 1500 a la caja"
// es pedirle a la caja). "al banco" no entra porque no es "a ".
const INSTITUCIONES = 'banco|caja|financiera|cooperativa|tarjeta|bcp|bbva|interbank|scotiabank|mibanco|pichincha|banbif|'
  + 'falabella|ripley|oh|saga|efectiva|compartamos|confianza|credivargas|crediscotia|prestamista|plazo|cuotas?|cr[eé]dito|'
  + 'inter[eé]s|cuenta|nombre|tasa|meses|años|semanas|d[ií]as|sola';
const RE_DESTINATARIO = new RegExp('(?:^|\\s)a\\s+(?:(?:mi|mis|tu|su|sus|la|el|un|una)\\s+)?'
  + '(?!(?:' + INSTITUCIONES + ')' + NLD + ')(?![' + LETRA + ']+(?:ar|er|ir)' + NLD + ')(?!las?' + NLD + ')[' + LETRA + ']');

// Plata en el mensaje: un número, una moneda o un número en palabras.
const RE_PLATA = new RegExp('\\d|s\\/|\\$|' + NLA + '(?:soles?|lucas?|luquitas?|mangos?|cocos?|d[oó]lares?|plata|dinero|sencillo|'
  + 'diez|once|doce|quince|veinte|veinti\\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|'
  + '\\w+cientos|quinientos|mil)' + NLD);
// Lo prestado es una COSA cuando lo que sigue al verbo es un POSESIVO con un objeto de una lista CERRADA:
// "me prestó su carro y le eché 50 de gasolina" es un gasto de 50 (la primera revisión del 07-oct midió
// cuatro gastos así convertidos en deudas). Lista blanca y no negra a propósito: con la negra ("todo lo
// que no sea plata"), "me prestó sus ahorros, 2000" o "su quincena" quedaban como gasto (cuarta
// revisión). Lo que no está en la lista, desde un gasto, PREGUNTA (`enrutarPorVerbo`), que es el lado
// seguro: una cosa nueva cuesta una pregunta, no una deuda.
const COSAS = 'carro|auto|moto|camioneta|bici|bicicleta|casa|depa|departamento|cuarto|cochera|taladro|herramientas?|laptop|'
  + 'compu|computadora|celular|cel|tel[eé]fono|tablet|c[aá]mara|parlante|ropa|terno|vestido|zapatillas|libros?|cuaderno|'
  + 'mochila|maleta|carpa|escalera|tele|televisor|play|consola|licuadora|plancha';
const RE_OBJETO = new RegExp('^\\s*(?:su|sus|mi|mis|tu|tus)\\s+(?:' + COSAS + ')' + NLD);

const RE_FORMA = new RegExp(NLA + 'prest(é|e|ó|o|aron|aste|ado)' + NLD, 'g');

/** ¿Todas las formas de "prestar" del mensaje prestan una cosa (con posesivo)? */
function soloCosasPrestadas(msg) {
  const t = prepararTexto(msg);
  const formas = [...t.matchAll(RE_FORMA)];
  return formas.length > 0 && formas.every((m) => RE_OBJETO.test(clausulaDespues(t, m.index + m[0].length)));
}

/**
 * Qué dirección dice cada forma de "prestar" del mensaje.
 * @returns {Array<'me_deben'|'debo'|'ambiguo'>}
 */
function direccionesDichas(t) {
  const dirs = [];
  // Sin plata en ningún lado, lo prestado es una cosa o el monto no está: no es un préstamo de plata.
  if (!RE_PLATA.test(t)) return dirs;
  for (const m of t.matchAll(RE_FORMA)) {
    const fin = m[1];
    const antes = palabrasAntes(t, m.index);
    const despues = clausulaDespues(t, m.index + m[0].length);

    if (fin === 'ado') {
      // "le he prestado", "me han prestado", "pedí prestado", "me pidió prestado".
      const w1 = antes[antes.length - 1] || '';
      const w0 = antes[antes.length - 2] || '';
      const previa = (k) => antes[antes.length - k] || '';
      let dir = null;
      let largo = 0;
      if (['he', 'había', 'habia'].includes(w1) && ['le', 'les', 'te', 'se', 'lo', 'la', 'los', 'las'].includes(w0)) { dir = 'me_deben'; largo = 2; }
      else if (['ha', 'han', 'había', 'habían', 'habia', 'habian'].includes(w1) && ['me', 'nos'].includes(w0)) { dir = 'debo'; largo = 2; }
      else if (['pedí', 'pedi', 'pedimos'].includes(w1)) { dir = 'debo'; largo = CLITICOS.has(w0) ? 2 : 1; }
      else if (['pidió', 'pidio', 'pidieron'].includes(w1) && ['me', 'nos'].includes(w0)) { dir = 'me_deben'; largo = 2; }
      if (dir && !NEGACIONES.has(previa(largo + 1))) dirs.push(dir);
      continue;
    }

    // Los clíticos pegados a la forma ("me lo", "se lo", "le") y la palabra que viene antes.
    let i = antes.length;
    while (i > 0 && CLITICOS.has(antes[i - 1])) i--;
    const cl = antes.slice(i);
    const previa = antes[i - 1] || '';
    if (NEGACIONES.has(previa)) continue;

    if (fin === 'é' || fin === 'e') {
      if (fin === 'e' && SUBJUNTIVO.has(previa)) continue;
      if (cl.includes('me') || cl.includes('nos')) { dirs.push('ambiguo'); continue; }
      if (cl.some((c) => ['le', 'les', 'te', 'se'].includes(c))) { dirs.push('me_deben'); continue; }
      // Sin pronombre hace falta el DESTINATARIO, con tilde o sin ella: "presté 1500 al banco para la
      // casa" y "presté 3000 para la moto" son "me presté" sin el "me" (lo pidió prestado). La revisión
      // del 07-oct los midió saliendo me_deben con la regla de "origen".
      dirs.push(RE_DESTINATARIO.test(despues) ? 'me_deben' : 'ambiguo');
      continue;
    }
    // "prestó/presto", "prestaron", "prestaste": solo dicen algo de MI plata con "me"/"nos" delante.
    // "Juan le prestó a Pedro" es entre ellos.
    if (cl.includes('me') || cl.includes('nos')) dirs.push('debo');
  }
  return dirs;
}

/**
 * La dirección de un préstamo según el verbo.
 * @returns {'me_deben'|'debo'|'ambiguo'|null} null = el mensaje no dice un préstamo con un verbo.
 */
function direccionPrestamo(msg) {
  const t = prepararTexto(msg);
  const dirs = direccionesDichas(t);
  if (!dirs.length) return null;
  if (RE_DISCURSO.test(t)) return 'ambiguo';
  if (dirs.includes('ambiguo')) return 'ambiguo';
  const unicas = new Set(dirs);
  return unicas.size === 1 ? dirs[0] : 'ambiguo';
}

// ─── El abono a una deuda que ya existe ─────────────────────────────────────────────────────────
// Solo el singular: el plural impersonal ("me pagaron 1500 que me debían del sueldo") es un empleador
// o un banco, o sea un ingreso, y llevarlo a una deuda lo choca con el muro (revisión del 07-oct).
const VERBOS_PAGO_A_MI = 'pag[oó]|devolvi[oó]|abon[oó]|di[oó]|yape[oó]|'
  + 'pline[oó]|transfiri[oó]|deposit[oó]|pas[oó]|cancel[oó]|'
  + 'ha\\s+(?:pagado|devuelto|abonado|dado|yapeado|transferido|depositado|pasado|cancelado)';
const VERBOS_PAGO_MIO = 'pagu[eé]|devolv[ií]|abon[eé]|yape[eé]|pline[eé]|transfer[ií]|deposit[eé]|cancel[eé]|'
  + 'he\\s+(?:pagado|devuelto|abonado|dado|yapeado|transferido|depositado|cancelado)';
const RE_PAGO_MIO_PRETERITO = new RegExp(NLA + '(?:pagué|devolví|aboné|yapeé|plineé|transferí|deposité|cancelé|'
  + '(?:le|les|te)\\s+di|he\\s+(?:pagado|devuelto|abonado|dado|yapeado|transferido|depositado|cancelado))' + NLD);
const RE_PAGO_A_MI = new RegExp(NLA + '(?:me|nos)\\s+(?:lo\\s+|la\\s+|los\\s+|las\\s+)?(?:' + VERBOS_PAGO_A_MI + ')' + NLD, 'g');
const RE_PAGO_MIO = new RegExp(NLA + '(?:(?:le|les|te|se\\s+l[oa]s?)\\s+di|(?:(?:le|les|te|se\\s+l[oa]s?)\\s+)?(?:' + VERBOS_PAGO_MIO + '))' + NLD, 'g');
// La referencia a la deuda que ya existía: "que me debía", "lo que le presté", "lo que me prestó".
const RE_REF_ME_DEBEN = new RegExp(NLA + '(?:que|lo\\s+que)\\s+(?:me\\s+(?:deb[ií]an?|deben?|deb[ií]as|debes)'
  + '|(?:le|les|te|se\\s+l[oa]s?)\\s+(?:prest[eé]|hab[ií]a\\s+prestado|he\\s+prestado))' + NLD);
const RE_REF_DEBO = new RegExp(NLA + '(?:que|lo\\s+que)\\s+(?:(?:le|les|te)\\s+(?:deb[ií]a|debo|debemos|deb[ií]amos)'
  + '|me\\s+(?:prest[oó]|prestaron|prestaste|hab[ií]an?\\s+prestado|han?\\s+prestado))' + NLD);

/** ¿El verbo de pago aparece afirmado (no negado) en el mensaje? */
function pagoAfirmado(t, re) {
  for (const m of t.matchAll(re)) {
    const antes = palabrasAntes(t, m.index);
    let previa = antes[antes.length - 1] || '';
    if (previa === 'ya') previa = antes[antes.length - 2] || '';
    if (NEGACIONES.has(previa) || previa === 'todavía' || previa === 'todavia' || previa === 'aún' || previa === 'aun') continue;
    return true;
  }
  return false;
}

/**
 * De qué lado es el pago que dice el verbo: "me pagó" baja lo que me deben, "le pagué" lo que debo.
 * @returns {'me_deben'|'debo'|null} null = no hay pago afirmado, o hay de los dos lados.
 */
function ladoDelPago(msg) {
  const t = prepararTexto(msg);
  const aMi = pagoAfirmado(t, RE_PAGO_A_MI);
  const mio = pagoAfirmado(t, RE_PAGO_MIO);
  if (aMi === mio) return null;
  return aMi ? 'me_deben' : 'debo';
}

/**
 * ¿El mensaje paga una deuda que ya existe? Hace falta el verbo de pago Y la referencia a la deuda,
 * del mismo lado: "Me pagó mi tío 150 que me debía" → 'me_deben'.
 * @returns {'me_deben'|'debo'|null}
 */
function abonoDeDeudaExistente(msg) {
  const lado = ladoDelPago(msg);
  if (!lado) return null;
  const t = prepararTexto(msg);
  const refMe = RE_REF_ME_DEBEN.test(t);
  const refDebo = RE_REF_DEBO.test(t);
  if (refMe === refDebo) return null;
  if ((refMe ? 'me_deben' : 'debo') !== lado) return null;
  // Solo el mensaje LIMPIO. La revisión midió abonos que saldaban deuda real con "Juan dice que me
  // pagó… pero es mentira", "¿Juan me pagó lo que me debía?", "si Juan me pagó…" y "…y le volví a
  // prestar 100" (el préstamo nuevo se perdía). Lo que no es limpio lo pregunta `enrutarPorVerbo`.
  if (/[?¿]/.test(String(msg || ''))) return null;
  if (RE_DISCURSO.test(t) || RE_SOSPECHA.test(t)) return null;
  const pago = (lado === 'me_deben' ? RE_PAGO_A_MI : RE_PAGO_MIO);
  pago.lastIndex = 0;
  const primerPago = pago.exec(t);
  pago.lastIndex = 0;
  if (primerPago && RE_DUDA_ANTES.test(t.slice(0, primerPago.index))) return null;
  if (/prest/.test(t.replace(refMe ? RE_REF_ME_DEBEN : RE_REF_DEBO, ' '))) return null;
  // Una sola cifra. Con dos ("50 de los 200", "1 de las 3 cuotas", "1,500 de los 2,000") no se sabe
  // cuál es el abono: la tercera revisión del 07-oct midió un lector de "N de los M" abonando 1.5 en
  // vez de 1500 y "1" por una cuota. Se pregunta.
  if (numerosDe(t).length + (t.match(RE_CANTIDAD_EN_PALABRAS) || []).length > 1) return null;
  // Del lado `debo`, el pago tiene que estar en pretérito SIN duda: "pague" sin tilde también es
  // subjuntivo ("quiere que le pague"). Con tilde, "le di" o "he pagado"; si no, se pregunta.
  if (lado === 'debo' && !RE_PAGO_MIO_PRETERITO.test(t)) return null;
  return lado;
}

/**
 * ¿El mensaje tiene FORMA de pago de una deuda que ya existe, limpio o no? Un verbo de pago (afirmado o
 * negado) y la referencia a la deuda ("que me debía", "lo que le presté"). Si tiene esa forma y no es
 * un abono limpio, se pregunta: lo que nunca puede pasar es que termine creando una deuda NUEVA, que
 * es lo que hacía el clasificador con "Me pagó mi tío 150 que me debía".
 */
function pareceAbono(msg) {
  const t = prepararTexto(msg);
  return RE_PAGO_ANCHO.test(t) && (RE_REF_ME_DEBEN.test(t) || RE_REF_DEBO.test(t));
}

// Cualquier forma de pagar o devolver, en cualquier tiempo y persona. Puede ser ancho porque solo decide
// PREGUNTAR: la cuarta revisión del 07-oct midió deudas nuevas creadas con "me devolvieron", "le pasé",
// "le mandé", "me cobró" y "no me paga", que el reconocedor del abono limpio no ve a propósito.
// Las raíces largas llevan cualquier terminación; las cortas ("di", "da", "pasé") van exactas: con
// terminación libre, "di" calzaba con "Diego" ("Registra que le debo 300 a Diego", del pool).
const RE_PAGO_ANCHO = new RegExp(NLA + '(?:(?:pag|devolv|devuel|abon|yape|pline|transf|deposit|cancel|cobr|mand)[' + LETRA + ']*'
  + '|di|di[oó]|dieron|dan?|dado|pas[eéoó]|pasaron|pasa|pasan)' + NLD);

// ─── Lo que se le pregunta ───────────────────────────────────────────────────────────────────────
const numerosDe = (msg) => String(msg == null ? '' : msg).match(/\d+(?:[.,]\d+)*/g) || [];
const cifraUnica = (msg) => { const n = numerosDe(msg); return n.length === 1 ? n[0] : null; };

function preguntaDireccionPrestamo(msg) {
  const u = cifraUnica(msg);
  const x = u || '100';
  const cabeza = u
    ? '¿Esos ' + x + ' los prestaste tú o te los prestaron a ti?'
    : '¿Ese préstamo lo hiciste tú o te lo hicieron a ti?';
  return cabeza + ' Para no anotarlo al revés, dímelo así:\n'
    + '_"le presté ' + x + ' a mi mamá"_ si te lo deben\n'
    + '_"mi mamá me prestó ' + x + '"_ si lo debes tú\n\n'
    + 'Y si fue un gasto: _"gasté ' + x + ' en el taxi"_.';
}

// Desde un gasto: el mensaje nombra un préstamo y puede ser las dos cosas ("gasolina 50 para la moto
// que me prestó Juan" es un gasto; "Presté 200 a Juan" es una deuda). No se anota ninguna.
function preguntaPrestamoOGasto(msg) {
  const x = cifraUnica(msg) || '50';
  return 'No anoté nada todavía: ¿eso fue un préstamo o un gasto? Dímelo así y lo anoto bien:\n'
    + '_"le presté ' + x + ' a Juan"_ si te lo deben\n'
    + '_"Juan me prestó ' + x + '"_ si lo debes tú\n'
    + '_"gasté ' + x + ' en gasolina"_ si fue un gasto';
}

function preguntaAbonoDudoso(msg) {
  const x = cifraUnica(msg) || '50';
  return 'No cambié nada: ¿eso es un pago de una deuda que ya tenías anotada? Dímelo solo con lo que te pagaron o pagaste, así:\n'
    + '_"Juan me pagó ' + x + '"_ si te pagaron a ti\n'
    + '_"le pagué ' + x + ' a Juan"_ si pagaste tú';
}

function preguntaSinContraparte(tipo, monto) {
  const x = monto ? String(monto) : '100';
  return tipo === 'me_deben'
    ? '¿A quién se lo prestaste? Dímelo así: _"le presté ' + x + ' a Juan"_.'
    : '¿Quién te lo prestó? Dímelo así: _"Juan me prestó ' + x + '"_.';
}

function preguntaSinDeuda(tipo, contraparte, monto) {
  const x = monto ? String(monto) : '';
  if (tipo === 'me_deben') {
    return 'No tengo anotado que *' + contraparte + '* te deba plata, así que no cambié nada.\n\n'
      + '¿Lo anoto como un ingreso? Escríbeme _"me pagaron ' + (x || '100') + '"_. '
      + 'Si primero quieres anotar la deuda: _"' + contraparte + ' me debe ' + (x || '100') + '"_.';
  }
  return 'No tengo anotado que le debas plata a *' + contraparte + '*, así que no cambié nada.\n\n'
    + '¿Lo anoto como un gasto? Escríbeme _"pagué ' + (x || '100') + ' a ' + contraparte + '"_. '
    + 'Si primero quieres anotar la deuda: _"le debo ' + (x || '100') + ' a ' + contraparte + '"_.';
}

// ─── El enrutado, en `dispatchIntent` ────────────────────────────────────────────────────────────
/**
 * Tres caminos, y solo desde los intents que REGISTRAN (las lecturas, las ediciones y el resto de los
 * intents de deudas, como "ya le pagué todo a Juan", no se tocan):
 *
 *   registrar_manual  el clasificador leyó un gasto o un ingreso. Si el mensaje nombra un préstamo, el
 *                     código NO lo convierte en deuda: pregunta si fue préstamo o gasto. Tres vueltas
 *                     de revisión el 07-oct midieron gastos convertidos en deudas por cada heurística
 *                     de "lo prestado es una cosa"; preguntar es la que no se equivoca. Las únicas
 *                     excepciones: un objeto con posesivo ("me prestó su carro y le eché 50 de
 *                     gasolina") sigue siendo gasto, y un abono limpio de lo que ME deben abona.
 *   registrar_deuda   el clasificador ya decidió que es una deuda: el verbo decide la dirección, lo
 *                     ambiguo pregunta, y lo que tiene forma de abono abona (limpio) o pregunta (no
 *                     limpio), nunca crea una deuda nueva.
 *   abonar_deuda      el verbo de pago dice de qué lado es la deuda.
 *
 * @returns {{ intencion: string, datos: object } | { pregunta: string }}
 */
function enrutarPorVerbo({ intencion, datos, msg }) {
  const d = datos || {};
  const lado = (intencion === 'registrar_manual' || intencion === 'registrar_deuda' || intencion === 'abonar_deuda')
    ? abonoDeDeudaExistente(msg) : null;

  if (intencion === 'abonar_deuda') {
    const del = lado || ladoDelPago(msg);
    return { intencion, datos: del ? { ...d, tipo: del } : d };
  }

  if (intencion === 'registrar_manual') {
    // "Me pagó mi tío 150 que me debía" no puede ser un gasto. Del lado `debo` ("pagué la luz con la
    // tarjeta que me prestó mi hermana") sí puede: se pregunta abajo.
    if (lado === 'me_deben') return { intencion: 'abonar_deuda', datos: { monto: d.monto, tipo: lado } };
    // Lo que tiene forma de pago de una deuda tampoco es un gasto ni un ingreso nuevo.
    if (pareceAbono(msg)) return { pregunta: preguntaAbonoDudoso(msg) };
    if (!nombraPrestamo(msg) || soloCosasPrestadas(msg)) return { intencion, datos };
    return { pregunta: preguntaPrestamoOGasto(msg) };
  }

  if (intencion !== 'registrar_deuda') return { intencion, datos };
  if (lado) return { intencion: 'abonar_deuda', datos: { contraparte: d.contraparte, monto: d.monto, tipo: lado } };
  if (pareceAbono(msg)) return { pregunta: preguntaAbonoDudoso(msg) };
  // Un préstamo y un pago en el mismo mensaje ("Le presté 500 a Juan y ya me devolvió 200"): anotar la
  // deuda con un monto pierde el otro (cuarta revisión del 07-oct).
  const tt = prepararTexto(msg);
  if (nombraPrestamo(msg) && RE_PAGO_ANCHO.test(tt.replace(new RegExp(RE_FORMA.source, 'g'), ' ')) && numerosDe(tt).length > 1) {
    return { pregunta: preguntaAbonoDudoso(msg) };
  }
  const dir = direccionPrestamo(msg);
  if (!dir) return { intencion, datos };
  if (dir === 'ambiguo') return { pregunta: preguntaDireccionPrestamo(msg) };
  return { intencion, datos: { ...d, tipo: dir } };
}

/**
 * ¿El mensaje nombra un préstamo con un verbo, sea de lo que sea? Para el rescate sin IA, que guarda
 * un gasto sin preguntar: ahí basta el verbo para no rescatar.
 */
const nombraPrestamo = (msg) => new RegExp(RE_FORMA.source).test(String(msg == null ? '' : msg).toLowerCase());

module.exports = {
  direccionPrestamo, ladoDelPago, abonoDeDeudaExistente, pareceAbono, enrutarPorVerbo, nombraPrestamo,
  preguntaDireccionPrestamo, preguntaPrestamoOGasto, preguntaAbonoDudoso, preguntaSinContraparte, preguntaSinDeuda,
};
