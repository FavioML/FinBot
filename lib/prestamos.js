// La DIRECCIÓN de un préstamo la decide el VERBO, no el clasificador (07-oct-2026).
//
// Lo que pasó en prod (usuario d21c11e0): "Y preste 118 soles" → "Anotado. Le debes S/ 118.00 a
// desconocida" (era al revés: prestó ella, y lo corrigió sola); "Me preste 50 soles" entró como GASTO
// Finanzas > Prestamo; y con `tool_choice: 'required'` "Me pagó mi tío 150 que me debía" creaba una
// deuda NUEVA 3 de 3 en vez de abonar (docs/DEFECTOS.md, 30-sep). El modelo adivina la dirección; el
// verbo la dice. Cuando el verbo no la dice, se pregunta: anotar una deuda al revés es plata mal
// guardada, y una pregunta de más cuesta un mensaje.
//
// LA REGLA:
//   me deben   "presté", "le/les/te/se lo presté" (con o sin tilde si hay pronombre), "yo preste",
//              "preste N a X" (sin tilde pero con destinatario), "le he prestado", "me pidió prestado"
//   debo       "me prestó", "me prestaron", "me prestaste", "me ha prestado", "pedí prestado"
//   ambiguo    "me presté" (en Perú se usa para "pedí prestado" y también para un gasto), "preste" sin
//              tilde, sin pronombre y sin destinatario, "presté" con un origen y sin destinatario
//              ("presté 5000 del banco"), y un mensaje con las dos direcciones
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
'use strict';

const LETRA = 'a-záéíóúüñ';
const NLA = '(?<![' + LETRA + '])';
const NLD = '(?![' + LETRA + '])';

const CLITICOS = new Set(['me', 'te', 'le', 'les', 'se', 'lo', 'la', 'los', 'las', 'nos']);
const NEGACIONES = new Set(['no', 'nunca', 'jamás', 'jamas', 'ni']);
// Delante de "preste" sin tilde marcan subjuntivo o hipótesis: no es plata que ya se movió.
const SUBJUNTIVO = new Set(['que', 'si', 'cuando', 'apenas']);
const CORTE_CLAUSULA = /[,.;:!?¿¡()]/;

/** Minúsculas, sin lo citado (lo dijo otro) y con los espacios colapsados. */
function prepararTexto(msg) {
  return String(msg == null ? '' : msg).toLowerCase()
    .replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Las palabras de la cláusula que termina justo antes de `idx`. */
function palabrasAntes(t, idx) {
  const tramo = t.slice(0, idx).split(CORTE_CLAUSULA).pop();
  return tramo.split(new RegExp('[^' + LETRA + ']+')).filter(Boolean);
}

/** Lo que sigue a la forma, hasta el fin de la cláusula. */
function clausulaDespues(t, idx) {
  return t.slice(idx).split(/[.;!?]|\sy\s|\spero\s/)[0];
}

// "a mi madre", "a Juan" — pero no "a las 3" ni "a la semana".
const RE_DESTINATARIO = new RegExp('(?:^|\\s)a\\s+(?!las?\\s+\\d)(?!la\\s+(?:semana|quincena|tarde|noche|mañana)' + NLD + ')[' + LETRA + ']');
// "del banco", "de la caja", "de mi tarjeta": de dónde salió la plata.
const RE_ORIGEN = /(?:^|\s)del?\s/;

const RE_FORMA = new RegExp(NLA + 'prest(é|e|ó|o|aron|aste|ado)' + NLD, 'g');

/**
 * Qué dirección dice cada forma de "prestar" del mensaje.
 * @returns {Array<'me_deben'|'debo'|'ambiguo'>}
 */
function direccionesDichas(t) {
  const dirs = [];
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
      const destinatario = RE_DESTINATARIO.test(despues);
      if (fin === 'é' || previa === 'yo') dirs.push(destinatario || !RE_ORIGEN.test(despues) ? 'me_deben' : 'ambiguo');
      else dirs.push(destinatario ? 'me_deben' : 'ambiguo');
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
  const dirs = direccionesDichas(prepararTexto(msg));
  if (!dirs.length) return null;
  if (dirs.includes('ambiguo')) return 'ambiguo';
  const unicas = new Set(dirs);
  return unicas.size === 1 ? dirs[0] : 'ambiguo';
}

// ─── El abono a una deuda que ya existe ─────────────────────────────────────────────────────────
const VERBOS_PAGO_A_MI = 'pag[oó]|pagaron|devolvi[oó]|devolvieron|abon[oó]|abonaron|di[oó]|dieron|yape[oó]|yapearon|'
  + 'pline[oó]|plinearon|transfiri[oó]|transfirieron|deposit[oó]|depositaron|pas[oó]|pasaron|cancel[oó]|'
  + '(?:ha|han)\\s+(?:pagado|devuelto|abonado|dado|yapeado|transferido|depositado|pasado|cancelado)';
const VERBOS_PAGO_MIO = 'pagu[eé]|devolv[ií]|abon[eé]|yape[eé]|pline[eé]|transfer[ií]|deposit[eé]|cancel[eé]|'
  + 'he\\s+(?:pagado|devuelto|abonado|dado|yapeado|transferido|depositado|cancelado)';
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
  return (refMe ? 'me_deben' : 'debo') === lado ? lado : null;
}

// ─── Lo que se le pregunta ───────────────────────────────────────────────────────────────────────
const numerosDe = (msg) => String(msg == null ? '' : msg).match(/\d+(?:[.,]\d+)*/g) || [];

function preguntaDireccionPrestamo(msg) {
  const nums = numerosDe(msg);
  const x = nums.length === 1 ? nums[0] : '100';
  const cabeza = nums.length === 1
    ? '¿Esos ' + x + ' los prestaste tú o te los prestaron a ti?'
    : '¿Ese préstamo lo hiciste tú o te lo hicieron a ti?';
  return cabeza + ' Para no anotarlo al revés, dímelo así:\n'
    + '_"le presté ' + x + ' a mi mamá"_ si te lo deben\n'
    + '_"mi mamá me prestó ' + x + '"_ si lo debes tú\n\n'
    + 'Y si fue un gasto: _"gasté ' + x + ' en el taxi"_.';
}

const PREGUNTA_SEPARAR = 'Ese mensaje junta un préstamo con otra cosa y no quiero anotarlo mal. '
  + 'Mándame el préstamo aparte, por ejemplo _"le presté 50 a Juan"_.';

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
// Solo desde los intents que REGISTRAN: un préstamo que el clasificador mandó a `registrar_manual`
// sería un gasto, y uno en `registrar_deuda` podría ir al revés. Las lecturas, las ediciones y el
// resto de los intents de deudas ("ya le pagué todo a Juan") no se tocan.
const DE_REGISTRO = new Set(['registrar_manual', 'registrar_deuda']);

/**
 * @returns {{ intencion: string, datos: object } | { pregunta: string }}
 */
function enrutarPorVerbo({ intencion, datos, msg }) {
  const d = datos || {};
  if (DE_REGISTRO.has(intencion) || intencion === 'abonar_deuda') {
    const lado = abonoDeDeudaExistente(msg);
    if (lado) {
      // Del clasificador solo sirven la persona y el monto; el tipo lo dice el verbo de pago.
      const base = intencion === 'registrar_manual' ? {} : { contraparte: d.contraparte };
      return { intencion: 'abonar_deuda', datos: { ...base, monto: d.monto, tipo: lado } };
    }
  }
  if (intencion === 'abonar_deuda') {
    const lado = ladoDelPago(msg);
    return { intencion, datos: lado ? { ...d, tipo: lado } : d };
  }
  if (!DE_REGISTRO.has(intencion)) return { intencion, datos };
  const dir = direccionPrestamo(msg);
  if (!dir) return { intencion, datos };
  if (dir === 'ambiguo') return { pregunta: preguntaDireccionPrestamo(msg) };
  // Desde `registrar_manual` los datos son de un gasto: con dos cifras no hay cómo saber cuál es la
  // del préstamo ("almuerzo 15 y le presté 50 a Juan" anotaría una deuda de 15).
  if (intencion === 'registrar_manual' && numerosDe(msg).length > 1) return { pregunta: PREGUNTA_SEPARAR };
  const base = intencion === 'registrar_deuda' ? d : { monto: d.monto, moneda: d.moneda };
  return { intencion: 'registrar_deuda', datos: { ...base, tipo: dir } };
}

module.exports = {
  direccionPrestamo, ladoDelPago, abonoDeDeudaExistente, enrutarPorVerbo,
  preguntaDireccionPrestamo, preguntaSinContraparte, preguntaSinDeuda, PREGUNTA_SEPARAR,
};
