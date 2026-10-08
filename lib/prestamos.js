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
// "q" es "que" en WhatsApp ("Juan quiere q le preste 500"; tercera revisión del 08-oct).
const SUBJUNTIVO = new Set(['que', 'q', 'si', 'cuando', 'apenas']);
// "le di prestado", "me dejó prestado": el auxiliar de "dar/dejar prestado".
const DAR_DEJAR = new Set(['di', 'dí', 'dimos', 'dejé', 'deje', 'dejamos', 'dio', 'dió', 'dieron', 'dejó', 'dejo', 'dejaron']);
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
// Con "q": desde que la referencia a la deuda acepta "q", "Juan jura q me pago los 200 q me debia" se
// ABONABA porque la duda solo conocía "que" (tercera revisión del 08-oct). Las dos listas van juntas.
const RE_DUDA_ANTES = new RegExp(NLA + '(?:no|nunca|jam[aá]s|todav[ií]a|a[uú]n|si|que|q|cuando|apenas|hasta|para|ojal[aá]|'
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
      if (['he', 'e', 'había', 'habia'].includes(w1) && ['le', 'les', 'te', 'se', 'lo', 'la', 'los', 'las'].includes(w0)) { dir = 'me_deben'; largo = 2; }
      else if (['ha', 'han', 'había', 'habían', 'habia', 'habian'].includes(w1) && ['me', 'nos'].includes(w0)) { dir = 'debo'; largo = 2; }
      else if (['pedí', 'pedi', 'pedimos'].includes(w1)) { dir = 'debo'; largo = CLITICOS.has(w0) ? 2 : 1; }
      else if (['pidió', 'pidio', 'pidieron'].includes(w1) && ['me', 'nos'].includes(w0)) { dir = 'me_deben'; largo = 2; }
      else if (DAR_DEJAR.has(w1)) {
        // "le di prestado", "se lo dejé prestado" (me deben) y "me dio prestado", "me dejó prestado"
        // (debo). Sin estas formas caían en el default `'debo'` del handler (ítem 47, 08-oct-2026).
        let j = antes.length - 1;
        while (j > 0 && CLITICOS.has(antes[j - 1])) j--;
        const cls = antes.slice(j, antes.length - 1);
        const antesCl = antes[j - 1] || '';
        const yoDoy = ['di', 'dí', 'dimos', 'dejé', 'dejamos'].includes(w1) || (w1 === 'deje' && !SUBJUNTIVO.has(antesCl));
        const meDan = ['dio', 'dió', 'dieron', 'dejó', 'dejo', 'dejaron'].includes(w1);
        if (yoDoy && cls.some((c) => ['le', 'les', 'te', 'se'].includes(c))) dir = 'me_deben';
        else if (meDan && (cls.includes('me') || cls.includes('nos'))) dir = 'debo';
        if (dir && !NEGACIONES.has(antesCl)) dirs.push(dir);
        continue;
      }
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
// "q" es "que" en WhatsApp: sin ella "los 200 q me prestó" esquivaba el abono y el duplicado (revisión del 08-oct).
const RE_REF_ME_DEBEN = new RegExp(NLA + '(?:que|q|lo\\s+(?:que|q))\\s+(?:me\\s+(?:deb[ií]an?|deben?|deb[ií]as|debes)'
  + '|(?:le|les|te|se\\s+l[oa]s?)\\s+(?:prest[eé]|hab[ií]a\\s+prestado|he\\s+prestado))' + NLD);
const RE_REF_DEBO = new RegExp(NLA + '(?:que|q|lo\\s+(?:que|q))\\s+(?:(?:le|les|te)\\s+(?:deb[ií]a|debo|debemos|deb[ií]amos)'
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

// ─── Un pago que YA ocurrió junto a un préstamo (ítem 47, 08-oct-2026) ───────────────────────────
// "Le presté 300 a mi prima y me pagó la mitad" y "Juan me devolvió 150, le presté para su cumple"
// creaban una deuda NUEVA por el monto del préstamo: hasta el 08-oct se preguntaba solo con más de una
// cifra. Ahora pregunta con CUALQUIER verbo de pago, salvo los que seguro no narran un pago hecho,
// porque así escribe la gente: dos de los ocho mensajes reales con "prest" en `conversaciones` dicen
// "preste 302 soles a mi madre y me lo devolvera el lunes", y es una deuda de 302 bien leída.
//
// Se descarta un verbo de pago solo cuando seguro no es un pago hecho:
//   · negado ("no me ha devuelto nada");
//   · el medio, no el pago: un sustantivo detrás de "por/x/con/vía/en" ("se lo presté x yape");
//   · un fin: "para"/"pa" en las tres palabras de antes ("para que pague su luz", "para el pago");
//   · infinitivo, futuro o condicional ("me lo devolvera"), o subjuntivo sin pretérito posible
//     ("apenas me paguen", "que me lo devuelva");
//   · un PRESENTE inequívoco ("me paga", "le pago", "me lo devuelve") con una marca de futuro y sin
//     marca de pasado en su cláusula ("me paga el viernes");
//   · la ENTREGA del préstamo y no su devolución: un verbo de transferencia en la misma dirección que el
//     préstamo ("me prestó 200, me los yapeó", "le presté 300, se los transferí").
// Todo lo demás PREGUNTA. Dos vueltas de revisión adversarial el 08-oct rompieron una lista más ancha:
// "que/cuando" leídos como subjuntivo dejaban pasar "que ya me devolvio la mitad", y las marcas de
// tiempo leídas como futuro dejaban pasar "la semana pasada le devolvi la mitad" (la -i y la -e sin
// tilde de la primera persona son pretérito). Lo que se pregunta de más está en docs/DEFECTOS.md.
const sinTildes = (w) => w.normalize('NFD').replace(/[̀-ͯ]/g, '');
const ENCLITICOS = '(?:me|te|le|les|lo|la|los|las|nos|se)*';
const RE_NO_OCURRIDO = new RegExp('^(?:'
  + '[a-z]+(?:ar|er|ir)' + ENCLITICOS                                    // infinitivo: pagar, devolverme
  + '|[a-z]+(?:ar|er|ir)(?:a|as|e|emos|an|ia|ias|iamos|ian)'             // futuro y condicional: devolvera
  + ')$');
// Subjuntivo que no se confunde con un pretérito: el plural de -ar ("paguen") y el de -er/-ir ("devuelva").
const RE_SUBJUNTIVO_PURO = /^(?:(?:pagu|abon|cobr|yape|pline|mand|deposit|cancel|regres|sald|pas|envi)(?:en|es)|(?:devuelv|transfier|repong)(?:a|an|as))$/;
// Presente indicativo sin otra lectura posible. "me pago" NO entra (es "me pagó" sin tilde), ni "pague"
// (es "pagué"), ni "pago" sin clítico ("la semana pasada pago la mitad" es "pagó").
const RE_PRESENTE_A = /^(?:pag|abon|cobr|yape|pline|mand|deposit|cancel|regres|sald|pas|envi)(?:a|an|as)$/;
const RE_PRESENTE_E = /^(?:devuelv|transfier)(?:e|en|es)$/;
const RE_PRESENTE_YO = /^(?:pag|abon|yape|pline|mand|deposit|cancel|regres|sald|pas|envi|devuelv|transfier)o$/;
const RE_POR_VENIR = new RegExp(NLA + '(?:mañana|manana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|pr[oó]xim[oa]|'
  + 'que\\s+viene|otra\\s+semana|fin\\s+de\\s+mes|quincena|cuotas?|apenas|cuando|luego|despu[eé]s|pronto)' + NLD);
const RE_PASADO_EN_CLAUSULA = new RegExp(NLA + '(?:ayer|anoche|anteayer|pasad[oa]|antes|hace|ya)' + NLD);
const PREP_DE_MEDIO = new Set(['por', 'x', 'con', 'via', 'vía', 'en']);
const SUSTANTIVOS_PAGO = new Set(['pago', 'pagos', 'abono', 'abonos', 'deposito', 'depósito', 'depositos', 'depósitos',
  'transferencia', 'transferencias', 'yape', 'plin', 'cobro', 'cobros', 'devolucion', 'devolución', 'saldo',
  'envio', 'envío', 'efectivo']);
const AUXILIARES = new Set(['ha', 'han', 'he', 'has', 'hemos', 'había', 'habia', 'habían', 'habian']);
const RAICES_TRANSFERENCIA = /^(?:yape|pline|transf|deposit|mand|envi|di|dio|dieron|dimos|dan?|dado|pas)/;
const RE_PALABRA_PAGO = new RegExp(NLA + '(?:(?:pag|devolv|devuel|abon|yape|pline|transf|deposit|cancel|cobr|mand|regres|envi|'
  + 'repus|repon|sald)[' + LETRA + ']*|plin|di|dimos|di[oó]|dieron|dan?|dado|pas[eéoó]|pasaron|pasa|pasan)' + NLD, 'g');
// Antes de un infinitivo, lo que dice que el pago YA se hizo ("vino a devolverme", "ya pudo pagarme",
// "ayer fui a pagarle"; tercera revisión del 08-oct). Sin una de estas, el infinitivo no ocurrió.
const RE_HECHO_ANTES_INF = /^(?:ya|ayer|anoche|vino|vinieron|fue|fui|fueron|pudo|pude|pudieron|logr[oó]|logr[eé]|acab[aoó]|acab[eé]|termin[oó]|termin[eé]|alcanz[oó]|alcanc[eé])$/;
const ARTICULOS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'del', 'al']);
// Lo que se paga con la plata prestada y no es la devolución: "Juan me prestó 500 y pagué la luz". Solo
// con ARTÍCULO y sin dueño después: "ya pagó MI alquiler", "pagué SU tarjeta" o "la tarjeta DE Juan"
// pueden ser la devolución (cuarta revisión del 08-oct), y preguntan.
// El posesivo cuenta solo si es de quien RECIBIÓ el préstamo: "mi" cuando debo ("me prestó 500, con eso
// cancelé mi tarjeta") y "su" cuando me deben ("le presté 300 y pagó su luz").
const pagoATercero = (dir) => new RegExp('^\\s*(?:con\\s+eso\\s+|con\\s+esa\\s+plata\\s+)?(?:la|el|los|las'
  + (dir === 'debo' ? '|mi|mis' : dir === 'me_deben' ? '|su|sus' : '') + ')\\s+'
  + '(?:luz|agua|alquiler|renta|tarjeta|recibo|colegio|pensi[oó]n|matr[ií]cula|internet|cable|tel[eé]fono|celular|gas|'
  + 'universidad|mensualidad|cuarto|depa|cl[ií]nica|medicinas?|pasaje|seguro|mantenimiento|letra\\s+del\\s+carro)' + NLD
  + '(?!\\s+(?:de|del)\\s)');
// Palabras de pago que no son un pago en esa frase.
const RE_NO_ES_PAGO = /^(?:da|dan)\s+(?:pena|miedo|cosa|verg[uü]enza|risa|igual|flojera|cólera|colera)\b|^dado\s+que\b|^pasa\s+(?:es|que)\b/;

/**
 * ¿Hay un pago que pudo haber ocurrido junto al préstamo?
 * @param {string} t texto ya preparado (prepararTexto)
 * @param {'me_deben'|'debo'|null} dir la dirección del préstamo, para separar su entrega de su devolución
 */
function pagoHechoJuntoAlPrestamo(t, dir) {
  // "le di prestado", "Le di 200 prestado a Juan": ese "di" es el préstamo. Solo con el PARTICIPIO:
  // con "prest" a secas se comía el pago de "ya me dio la mitad del prestamo" (segunda revisión).
  const sinPrestamo = t
    .replace(new RegExp(NLA + '(?:di|dí|dimos|di[oó]|dieron|dej[eéoó]|dejamos|dejaron)((?:\\s+[^\\s,.;]+){0,3}?)\\s+prestad[oa]s?' + NLD, 'g'), ' $1 ')
    .replace(new RegExp(NLA + 'pr[eé]st[' + LETRA + ']*', 'g'), ' ');
  for (const m of sinPrestamo.matchAll(RE_PALABRA_PAGO)) {
    const w = m[0];
    const s = sinTildes(w);
    const antes = palabrasAntes(sinPrestamo, m.index);
    const despues = clausulaDespues(sinPrestamo, m.index + w.length);
    const pegada = antes[antes.length - 1] || '';
    // "la/los/las" con un clítico delante ("me los yapeó", "se las transferí") son clíticos, no artículos.
    const pegadaEsClitico = CLITICOS.has(pegada) && CLITICOS.has(antes[antes.length - 2] || '');
    const sustantivo = SUSTANTIVOS_PAGO.has(w) || (ARTICULOS.has(pegada) && !pegadaEsClitico);
    if (RE_NO_ES_PAGO.test(sinPrestamo.slice(m.index))) continue;
    if (SUSTANTIVOS_PAGO.has(w) && PREP_DE_MEDIO.has(pegada)) continue;
    // "regresó de viaje" no es un pago: se descarta solo seguido de una preposición. Exigir el clítico
    // escondía "ya regresó la mitad" (cuarta revisión del 08-oct).
    if (/^regres/.test(s) && /^\s*(?:de|del|a|al|en|por|para|pa)\s/.test(despues)) continue;

    let i = antes.length;
    const cls = [];
    while (i > 0 && (CLITICOS.has(antes[i - 1]) || AUXILIARES.has(antes[i - 1]) || antes[i - 1] === 'ya')) {
      if (CLITICOS.has(antes[i - 1])) cls.push(antes[i - 1]);
      i--;
    }
    const previa = antes[i - 1] || '';
    if (NEGACIONES.has(previa) || ['todavía', 'todavia', 'aún', 'aun'].includes(previa)) continue;

    // Un FIN, solo pegado al verbo: "para que pague", "pa q pague", "para pagar", "para el pago". Con
    // una ventana de tres palabras "para julio me pagó la mitad" se descartaba (tercera revisión).
    const fin = ['para', 'pa'].includes(previa)
      || (['que', 'q'].includes(previa) && ['para', 'pa'].includes(antes[i - 2] || ''))
      || (sustantivo && ARTICULOS.has(pegada) && ['para', 'pa'].includes(antes[antes.length - 2] || ''));
    if (fin) continue;

    const conTilde = /[áéíóú]/.test(w);
    const aMi = cls.includes('me') || cls.includes('nos');
    const aOtro = cls.some((c) => ['le', 'les', 'te', 'se'].includes(c));
    if (RE_NO_OCURRIDO.test(s)) {
      const hecho = antes.slice(-3).some((x) => RE_HECHO_ANTES_INF.test(x));
      if (!hecho) continue;
    } else if (RE_SUBJUNTIVO_PURO.test(s)) continue;
    const presente = !conTilde && (RE_PRESENTE_A.test(s) || RE_PRESENTE_E.test(s)
      || (RE_PRESENTE_YO.test(s) && !aMi && aOtro));
    if (presente) {
      // La cláusula del verbo: desde el último corte (puntuación, " y ", " pero ") hasta el siguiente.
      const clausula = sinPrestamo.slice(0, m.index).split(/[,.;:!?¿¡()]|\sy\s|\spero\s/).pop() + ' ' + clausulaDespues(sinPrestamo, m.index);
      if (RE_POR_VENIR.test(clausula) && !RE_PASADO_EN_CLAUSULA.test(clausula)) continue;
    }

    // Lo que se pagó con la plata, sin clítico de persona: "y pagué la luz", "con eso cancelé mi tarjeta".
    if (!aMi && !aOtro && pagoATercero(dir).test(despues) && !/\d/.test(despues)) continue;

    // La entrega del préstamo no es un pago: un VERBO de transferencia en la misma dirección que el
    // préstamo. Un sustantivo ("me cayó el yape") no dice la dirección y pregunta (tercera revisión).
    if (dir && !sustantivo && RAICES_TRANSFERENCIA.test(s)) {
      const deMi = !aMi && (aOtro || ['di', 'dimos'].includes(s) || /[eéií]$/.test(w));
      if ((dir === 'debo' && aMi) || (dir === 'me_deben' && deMi)) continue;
    }
    return true;
  }
  return false;
}

// Cualquier forma VERBAL de prestar, en cualquier tiempo: "me va a prestar", "prestaba", "presten".
// El sustantivo ("un préstamo", "del prestamito") no cuenta: ahí no hay verbo que lea nada.
const RE_PRESTAR_VERBAL = new RegExp(NLA + 'prest(?!am(?:o|os|ito|itos)' + NLD + '|amista)[' + LETRA + ']*');
const RE_PRESTAMO_SUSTANTIVO = new RegExp(NLA + 'pr[eé]stam(?:o|os|ito|itos)' + NLD);
const DETERMINANTES = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'su', 'sus', 'mi', 'mis', 'tu', 'tus',
  'del', 'al', 'otro', 'otros', 'varios', 'dos', 'tres', 'por', 'con', 'en', 'via', 'vía', 'x', 'de', 'sin']);
function nombraPrestamoVerbal(msg) {
  const t = prepararTexto(msg);
  if (RE_PRESTAR_VERBAL.test(t)) return true;
  // "prestamos" sin tilde también es el verbo ("le prestamos 200 a Juan"), salvo detrás de un
  // determinante o una preposición ("mis prestamos", "en prestamos").
  for (const m of t.matchAll(new RegExp(NLA + 'prestamos' + NLD, 'g'))) {
    const antes = palabrasAntes(t, m.index);
    if (!DETERMINANTES.has(antes[antes.length - 1] || '')) return true;
  }
  return false;
}
/** ¿Nombra un préstamo, como verbo o como sustantivo? */
const nombraPrestamoAlgo = (msg) => nombraPrestamoVerbal(msg) || RE_PRESTAMO_SUSTANTIVO.test(prepararTexto(msg));

// Una deuda dicha en PRIMERA persona y afirmada: "Juan me debe 300", "le debo 200", "le quedo debiendo".
// Con una de estas, un verbo de prestar sin dirección es contexto ("Juan me debe 300, siempre le
// presto") y decide el resto del flujo como antes del 08-oct.
// Solo el PRESENTE: "Juan me debía 300 pero ya me pagó" es una deuda que ya no existe (segunda revisión).
const RE_ME_DEBEN = new RegExp(NLA + '(?:me|nos)\\s+deben?' + NLD);
const RE_DEBO = new RegExp(NLA + '(?:debo|debemos|(?:quedo|quedamos)\\s+debiendo)' + NLD);
const RE_INFINITIVO = /^[a-z]+(?:ar|er|ir)(?:me|te|le|les|lo|la|los|las|nos|se)*$/;
function afirmada(t, re) {
  for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
    // "debo cobrarle", "se lo debo cobrar": es una obligación de hacer algo, no una deuda.
    const siguiente = t.slice(m.index + m[0].length).trim().split(/\s+/)[0] || '';
    if (re === RE_DEBO && RE_INFINITIVO.test(sinTildes(siguiente))) continue;
    const antes = palabrasAntes(t, m.index);
    let i = antes.length;
    while (i > 0 && CLITICOS.has(antes[i - 1])) i--;
    const previa = antes[i - 1] || '';
    if (!NEGACIONES.has(previa) && previa !== 'nadie') return true;
  }
  return false;
}
/**
 * La dirección que dice el texto con "debe/debo", sin verbo de prestar.
 * @returns {'me_deben'|'debo'|null} null = no lo dice, o dice las dos.
 */
function tipoPorDeber(msg) {
  const t = prepararTexto(msg);
  const meDeben = afirmada(t, RE_ME_DEBEN);
  const debo = afirmada(t, RE_DEBO);
  if (meDeben === debo) return null;
  return meDeben ? 'me_deben' : 'debo';
}

/**
 * Un verbo de prestar sin dirección (negado, futuro, subjuntivo, de terceros, o una forma que el
 * código no lee) y sin una deuda dicha en primera persona: no se anota (ítem 47, 08-oct-2026).
 */
function prestamoSinDireccion(msg) {
  return direccionPrestamo(msg) === null && nombraPrestamoVerbal(msg) && !tipoPorDeber(msg);
}

/** ¿El mensaje se refiere a una deuda que ya existe? "los 200 que me prestó", "del préstamo", "todavía le debo". */
const RE_REF_ANCHA = new RegExp(NLA + '(?:del\\s+pr[eé]stam\\w*|todav[ií]a\\s+(?:le|les|te|me|nos)\\s+deb\\w*|a[uú]n\\s+(?:le|les|te|me|nos)\\s+deb\\w*|'
  + 'sigue\\s+debiendo|me\\s+sigue\\s+debiendo|le\\s+sigo\\s+debiendo|sigo\\s+debiendo)' + NLD);
function refiereDeudaExistente(msg) {
  const t = prepararTexto(msg);
  return RE_REF_ME_DEBEN.test(t) || RE_REF_DEBO.test(t) || RE_REF_ANCHA.test(t);
}

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
// Desde una deuda, cuando el verbo no dice ni que ocurrió ni quién prestó: lo negado ("nunca me
// prestó"), lo que todavía no pasó ("me va a prestar", "le pedí que me preste") y lo de terceros ("mi
// papá le prestó a mi tío"). Anotarlo sería escribir una deuda que no existe (ítem 47, 08-oct-2026).
function preguntaPrestamoSinDireccion(msg) {
  const x = cifraUnica(msg) || '100';
  return 'No anoté nada: no me queda claro si ese préstamo ya pasó, ni quién se lo prestó a quién. Si ya pasó, dímelo así:\n'
    + '_"le presté ' + x + ' a Juan"_ si te lo deben\n'
    + '_"Juan me prestó ' + x + '"_ si lo debes tú\n\n'
    + 'Si todavía no pasa, o fue entre otras personas, no hace falta anotarlo.';
}

// Una deuda sin préstamo nombrado y sin dirección ("Pedro, 150 de la cena"): la pregunta no habla de
// prestar (la revisión del 08-oct lo marcó como copy que no encaja).
function preguntaDireccionDeuda(msg) {
  const x = cifraUnica(msg) || '100';
  return '¿Quién le debe a quién? Para no anotarlo al revés, dímelo así:\n'
    + '_"Juan me debe ' + x + '"_ si te deben a ti\n'
    + '_"le debo ' + x + ' a Juan"_ si debes tú';
}

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
  // Un préstamo y un pago que ya ocurrió en el mismo mensaje ("Le presté 500 a Juan y ya me devolvió
  // 200", "Le presté 300 a mi prima y me pagó la mitad", "Juan me devolvió 150, le presté para su
  // cumple"): anotar la deuda con el monto del préstamo pierde el pago, o anota la devolución como
  // deuda nueva. Hasta el 08-oct exigía más de una cifra (ítem 47).
  // Con dos cifras sigue preguntando aunque el pago no haya ocurrido ("…y me devolverá 200 el lunes"):
  // no se sabe cuál es la deuda (cuarta revisión del 07-oct).
  const tt = prepararTexto(msg);
  const conPago = RE_PAGO_ANCHO.test(tt.replace(new RegExp(RE_FORMA.source, 'g'), ' '));
  // El préstamo dicho como sustantivo también: "Le hice un préstamo de 500 a mi primo y ya me pagó la mitad".
  const dir = direccionPrestamo(msg);
  const dirClara = dir === 'me_deben' || dir === 'debo' ? dir : null;
  if (nombraPrestamoAlgo(msg) && ((conPago && numerosDe(tt).length > 1) || pagoHechoJuntoAlPrestamo(tt, dirClara))) {
    return { pregunta: preguntaAbonoDudoso(msg) };
  }
  // Sin dirección y con un verbo de prestar, el préstamo es negado, futuro, en subjuntivo o de
  // terceros: null NO significa "confía en el clasificador", que lo anotaba igual (ítem 47).
  if (!dir) return prestamoSinDireccion(msg) ? { pregunta: preguntaPrestamoSinDireccion(msg) } : { intencion, datos };
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
  nombraPrestamoVerbal, nombraPrestamoAlgo, prestamoSinDireccion, tipoPorDeber, refiereDeudaExistente,
  preguntaDireccionPrestamo, preguntaDireccionDeuda, preguntaPrestamoSinDireccion, preguntaPrestamoOGasto, preguntaAbonoDudoso,
  preguntaSinContraparte, preguntaSinDeuda,
};
