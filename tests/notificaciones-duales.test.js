import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guard del chokepoint de notificaciones, hermano de `tests/cron/lecturas-proactivas.test.js`
 * y de `webapp/src/lib/supabase/lectura-callsites.test.ts`.
 *
 * El hecho que lo obliga: el WhatsApp libre NO se entrega fuera de la ventana de 24h de Meta
 * (error 131047) y las plantillas están descartadas por decisión de producto (ver
 * docs/whatsapp-templates.md). O sea que un aviso que sale solo por WhatsApp no llega a quien
 * no escribió hoy — y quien no escribió hoy es justamente la población a la que se le quiere
 * avisar: el trial por vencer, el inactivo, el que ni sabe que le cargaron un gasto en un
 * espacio. La notificación in-app es el único canal que llega a todos.
 *
 * El modo de falla que este archivo previene: un envío proactivo NUEVO escrito con
 * `enviarWhatsapp` a secas. No se detecta mirando producción — el cron corre, no falla, y
 * `notification_deliveries` hasta registra 'sent' porque Meta aceptó el POST. Se ve igual que
 * un usuario al que se le avisó y que simplemente no reaccionó.
 *
 * Por eso la regla es binaria y no depende de leer la intención de nadie:
 *
 *   Ningún archivo del backend, fuera de los declarados abajo, llama `enviarWhatsapp`
 *   directamente. Todo aviso proactivo pasa por `notificarUsuario`, y `notificarUsuario` no
 *   se escribe sin declarar sus canales.
 *
 * Si agregas un envío y este archivo se pone rojo, la respuesta por defecto es
 * `notificarUsuario` con `CANALES.AMBOS`. Declararlo como excepción es la excepción, no el
 * atajo.
 */

const RAIZ = process.cwd();

/**
 * Directorios de runtime: TODOS los de primer nivel menos los que no corren en el server.
 *
 * Es lista NEGRA desde el 12-sep-2026, igual que la de `canal-unico-sin-cuenta-web.test.js`. Con
 * la lista blanca de antes, un `jobs/` nuevo con un `enviarWhatsapp(null, …, { usuarioId })` crudo
 * pasaba en verde (la revisión adversarial lo ejecutó), y desde ese día esa llamada SÍ entrega.
 * Una carpeta de runtime nueva tiene que entrar al barrido sola, no esperar a que alguien la anote.
 */
const NO_RUNTIME = new Set([
  'node_modules', 'webapp', 'qa-e2e', 'tests', 'migrations', 'scripts', 'docs', 'prompts',
  'coverage', 'assets', 'public',
]);
const DIRS = readdirSync(RAIZ).filter((n) =>
  !n.startsWith('.') && !NO_RUNTIME.has(n) && statSync(join(RAIZ, n)).isDirectory());
const SUELTOS = ['index.js', 'gmail.js'];

const ENVIO_CRUDO = /\benviarWhatsapp\s*\(/g;
/**
 * El canal de correo (27-ago-2026) entra por la MISMA puerta y con la misma regla. No es
 * simetría por prolijidad: `enviarEmail` es quien escribe la fila `canal='email'` de
 * `notification_deliveries`, o sea la única instrumentación que separa "Resend aceptó" de
 * "llegó". Un envío suelto por fuera del chokepoint reproduce el hallazgo B23 con otro
 * proveedor — 100% de entrega reportada sobre un canal que nadie está midiendo.
 */
const ENVIO_EMAIL_CRUDO = /\benviarEmail\s*\(/g;
/**
 * Un canal de correo declarado SIN asunto no manda nada. `notificarUsuario` lo loguea como
 * error del programador y sigue; el castigo de verdad vive acá, igual que con `motivo`.
 *
 * **Se extrae el objeto con LLAVES BALANCEADAS, no con un `[^{}]`.** La primera versión usaba
 * `/email\s*:\s*\{(?:(?!asunto)[^{}])*\}/`, y una revisión adversarial la evadió sin esfuerzo:
 * `email: { to: x, headers: { a: 1 } }` no matchea nada —el `[^{}]` se corta en la llave
 * anidada— así que un canal sin asunto pasaba en VERDE. Es la clase
 * `la-unidad-del-barrido-no-es-la-linea` con otra cara: la unidad no es "texto sin llaves",
 * es el objeto.
 *
 * Y un `email:` que NO abre llave (`email: opts`, `email: armarEmail(u)`) se marca también:
 * desde acá no se puede saber si ese valor trae asunto, y un guard que no puede decidir tiene
 * que fallar cerrado. Escribir el literal es barato; la alternativa es no vigilar nada.
 */
function canalesDeCorreoSinAsunto(arg) {
  const out = [];
  for (const m of arg.matchAll(/\bemail\s*:\s*/g)) {
    let i = m.index + m[0].length;
    if (arg[i] !== '{') { out.push('email: <no es un literal>'); continue; }
    let prof = 0;
    const desde = i;
    while (i < arg.length) {
      if (arg[i] === '{') prof++;
      else if (arg[i] === '}') { prof--; if (prof === 0) { i++; break; } }
      i++;
    }
    const objeto = arg.slice(desde, i);
    if (!/\basunto\s*:/.test(objeto)) out.push(objeto);
  }
  return out;
}

/**
 * Todo canal de correo manda a una dirección PROBADA (15-sep-2026).
 *
 * `usuarios.email` no es una columna de direcciones probadas: las filas nacidas en WhatsApp
 * traían el correo que la persona dictó en el alta viejo, y nadie lo verificó. Un error de
 * tipeo que cae en la bandeja real de otra persona le manda a un desconocido los avisos de
 * plata de alguien más, y en `trial_d11`/`trial_d14` el link de activación de su cuenta.
 *
 * Por eso el `to:` de TODO canal de correo es exactamente `correoVerificado(<expresión>)`
 * (`lib/email.js`), que sólo devuelve la dirección si la fila tiene cuenta web. Se marca:
 *   · un `to:` que no es esa llamada (`u.email`, `x || y`, una variable);
 *   · la llamada con algo pegado (`correoVerificado(u) || u.email`);
 *   · un argumento que arme una fila a mano (`correoVerificado({ ...u, supabase_auth_id: 1 })`):
 *     sólo se admiten identificadores, puntos y un ternario;
 *   · la forma corta `{ to, asunto }` y un spread dentro del objeto, que pueden pisar el `to`.
 *
 * Las comas se cortan a NIVEL CERO y fuera de comillas: el asunto de un correo puede llevar
 * una coma o un paréntesis, y cortarlo ahí partiría el objeto por donde no es.
 */
const TO_VERIFICADO = /^correoVerificado\(\s*[\w$.?:\s]*\)$/;

function partesDeNivelCero(txt) {
  const partes = [];
  let prof = 0;
  let desde = 0;
  let comilla = null;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (comilla) {
      if (c === '\\') i++;
      else if (c === comilla) comilla = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { comilla = c; continue; }
    if (c === '(' || c === '{' || c === '[') prof++;
    else if (c === ')' || c === '}' || c === ']') prof--;
    else if (c === ',' && prof === 0) { partes.push(txt.slice(desde, i)); desde = i + 1; }
  }
  partes.push(txt.slice(desde));
  return partes.map((p) => p.trim()).filter(Boolean);
}

function correosSinVerificar(arg) {
  const out = [];
  // Las dos formas que la revisión adversarial usó para que un emisor NUEVO pasara la suite
  // entera en verde mandando a `u.email` crudo: el barrido de abajo sólo ve `email:` sin
  // comillas, así que `{ ..., email }` (el objeto armado arriba) y `'email': {...}` no existían
  // para él. No se intenta entenderlas: se marcan, y el literal es la forma que se escribe.
  if (/[{,]\s*email\s*(?=[,}])/.test(arg)) out.push('email <abreviado: el objeto se armó fuera de la llamada>');
  if (/['"`]email['"`]\s*:/.test(arg)) out.push("'email': <clave entre comillas>");
  for (const m of arg.matchAll(/\bemail\s*:\s*/g)) {
    let i = m.index + m[0].length;
    if (arg[i] !== '{') { out.push('email: <no es un literal>'); continue; }
    let prof = 0;
    const desde = i;
    while (i < arg.length) {
      if (arg[i] === '{') prof++;
      else if (arg[i] === '}') { prof--; if (prof === 0) { i++; break; } }
      i++;
    }
    const objeto = arg.slice(desde, i);
    const partes = partesDeNivelCero(objeto.slice(1, -1));
    const tos = partes.filter((p) => /^to\s*:/.test(p));
    const valor = tos.length === 1 ? tos[0].replace(/^to\s*:/, '').trim() : null;
    const conSpread = partes.some((p) => p.startsWith('...'));
    if (conSpread || valor === null || !TO_VERIFICADO.test(valor)) out.push(objeto);
  }
  return out;
}

/**
 * Un spread entre los argumentos de `notificarUsuario` esconde lo que declara (ítem 35(b)).
 *
 * `...opts` puede traer un `email` que ningún guard de este archivo ve, y un
 * `...(cond ? extra : {})` lo mismo con un paso más. Lo único que se admite es la forma que ya
 * usan el upsell y el muro: `...(condición ? { literal } : {})`, cuyo literal SÍ entra al
 * barrido porque el texto del objeto está en el argumento.
 */
function spreadsOpacos(arg) {
  const out = [];
  for (const m of arg.matchAll(/\.\.\.\s*/g)) {
    let i = m.index + m[0].length;
    if (arg[i] !== '(') { out.push(arg.slice(m.index, m.index + 40)); continue; }
    let prof = 0;
    const desde = i;
    while (i < arg.length) {
      if (arg[i] === '(') prof++;
      else if (arg[i] === ')') { prof--; if (prof === 0) { i++; break; } }
      i++;
    }
    const grupo = arg.slice(desde + 1, i - 1).trim();
    const partes = /^[^?]+\?\s*(\{[\s\S]*\})\s*:\s*\{\s*\}$/.exec(grupo);
    if (!partes) out.push('...(' + grupo.slice(0, 60) + ')');
  }
  return out;
}

/**
 * Los argumentos de cada `notificarUsuario(...)`, con paréntesis balanceados.
 *
 * `EMAIL_SIN_ASUNTO` se aplica SOLO acá adentro, y la primera corrida explicó por qué: sobre
 * el archivo entero marcaba `handlers/neto-tools.js`, donde `email: { type: 'string', ... }`
 * es una propiedad del JSON Schema de un tool de OpenAI y no tiene nada que ver con avisos.
 * Un guard que grita por lo que no es se termina ignorando, así que la unidad de análisis es
 * la LLAMADA, no el archivo. Mismo molde que `argumentosDeRespuesta` en
 * `tests/gmail-oauth-gates.test.js`, y por el mismo motivo.
 */
function llamadasAlChokepoint(src) {
  const out = [];
  for (const m of src.matchAll(/\bnotificarUsuario\s*\(/g)) {
    let i = m.index + m[0].length;
    const desde = i;
    let prof = 1;
    while (i < src.length && prof > 0) {
      if (src[i] === '(') prof++;
      else if (src[i] === ')') prof--;
      i++;
    }
    out.push(src.slice(desde, i - 1));
  }
  return out;
}
const IN_APP_CRUDO = /\bcrearNotificacion\s*\(/g;
const CHOKEPOINT = /\bnotificarUsuario\s*\(/g;

/** El chokepoint declara canales como PRIMERA clave. Eso es lo que hace la regex exacta. */
const CON_CANALES = /\bnotificarUsuario\(\s*\{\s*canales\s*:/g;
const CANAL_UNICO = /CANALES\.SOLO_\w+/g;
/**
 * `motivo` va inmediatamente después de `canales`. El look-ahead negativo impide que el match
 * se cuele hasta el `motivo` de la LLAMADA SIGUIENTE cuando la actual no lo tiene.
 *
 * Consecuencia práctica a documentar (falla cerrada, o sea rojo y no verde): un comentario
 * largo entre las dos claves rompe el match. Poné el `motivo` pegado al `canales`.
 */
const UNICO_CON_MOTIVO = /canales\s*:\s*CANALES\.SOLO_\w+\s*,(?:(?!canales\s*:)[\s\S]){0,400}?motivo\s*:\s*['"`]/g;
const AMBOS_CON_MOTIVO = /canales\s*:\s*CANALES\.AMBOS\s*,(?:(?!canales\s*:)[\s\S]){0,200}?motivo\s*:/g;

/**
 * Los ÚNICOS archivos que pueden llamar `enviarWhatsapp` crudo, por familia.
 *
 * `usos` está fijado a propósito: agregar una llamada rompe este test. Si lo que agregaste es
 * una RESPUESTA, subí el número acá. Si es un EMPUJE, no lo subas — usá `notificarUsuario`.
 * Excluir el archivo entero en vez de fijar el conteo dejaría el agujero justo donde más
 * duele: alguien mete un push proactivo dentro de `webhook.js` y nadie se entera.
 *
 * · TRANSPORTE — la definición y el chokepoint.
 * · RESPUESTA  — turno de conversación. El usuario acaba de escribir (o acaba de autorizar en
 *                el navegador): la ventana de 24h está abierta por construcción y no hay nada
 *                que espejar en la campana.
 * · ADMIN      — le escriben a Favio, que no tiene bandeja in-app.
 * · SOPORTE    — hilo humano; la webapp no tiene bandeja de soporte donde aterrizarlo.
 * · VOLUMEN    — la tarjeta por transacción. El dato ya vive en /dashboard/transacciones y es
 *                la única fuente de alto volumen del sistema (una por gasto detectado, no una
 *                por evento): una fila por transacción convierte la campana en ruido.
 */
const WHATSAPP_CRUDO = new Map([
  ['lib/whatsapp.js', { usos: 1, familia: 'TRANSPORTE', motivo: 'la definición de enviarWhatsapp' }],
  ['lib/notify-user.js', { usos: 1, familia: 'TRANSPORTE', motivo: 'el chokepoint: el único autorizado a llamarlo' }],
  ['lib/admin-notify.js', { usos: 1, familia: 'ADMIN', motivo: 'notificarAdmin escribe al número de Favio, no a un usuario' }],
  // Sigue en 26 tras el cambio del 14-ago-2026, y el neto engaña: se fue una respuesta (las dos
  // de "no reconocí un pago / ninguna transacción" se fusionaron en un ternario al sacar
  // `esperando_comprobante` de la decisión) y entraron dos (la captura de pago que llega con una
  // solicitud ya pendiente, y el monto ilegible de quien esperaba comprobante). Las tres son
  // RESPUESTA a un mensaje del usuario, no empujes.
  // 27 -> 30 el 25-ago-2026 (item 9B-ter), las tres en el bloque del OTP inverso y las tres
  // RESPUESTA a un mensaje que la persona acaba de mandar: las dos lecturas que antes elegian
  // rama a ciegas ahora contestan "no pude verificar tu codigo, sigue siendo valido" en vez de
  // declararlo invalido o intentar el link directo, y el link directo con cero filas dice "no
  // pude terminar de vincular" en vez de confirmar un vinculo que no ocurrio. Ninguna es empuje.
  // 30 -> 31 el 12-sep-2026: el acuse del OTP sin número. Es RESPUESTA —contesta el código que la
  // persona acaba de mandar— y sale por BSUID porque no hay número. Antes ese camino no contestaba
  // nada porque se creía que Meta no dejaba escribir por BSUID.
  ['handlers/webhook.js', { usos: 31, familia: 'RESPUESTA', motivo: 'turnos de conversación: imágenes, audios, OTP, onboarding' }],
  // Baja de 5 a 4: se fue el aviso de "cuenta Gmail adicional conectada", que preguntaba por
  // WhatsApp cómo agrupar los reportes. Un usuario tiene UNA cuenta (cada una cuesta un cupo
  // de por vida), así que esa rama del callback ya no existe.
  ['routes/public.js', { usos: 4, familia: 'RESPUESTA', motivo: 'callback de OAuth de Gmail: el usuario acaba de autorizar en el navegador' }],
  ['routes/admin.js', { usos: 1, familia: 'ADMIN', motivo: 'mensaje manual que el operador decide mandarle a un usuario' }],
  ['lib/pro-payment.js', { usos: 1, familia: 'RESPUESTA', motivo: '"comprobante recibido" contesta la captura que el usuario acaba de mandar' }],
  ['lib/support-tickets.js', { usos: 2, familia: 'SOPORTE', motivo: 'el hilo de soporte vive en WhatsApp; la webapp no tiene bandeja donde aterrizarlo' }],
  ['services/notifications.js', { usos: 1, familia: 'VOLUMEN', motivo: 'tarjeta "Nuevo gasto": el dato ya está en /dashboard/transacciones y es una por transacción' }],
]);

/**
 * Los ÚNICOS que pueden escribir la in-app cruda.
 *
 * Existe para que nadie "cierre un hueco" pegando un `crearNotificacion` al lado de un
 * `enviarWhatsapp` — que es exactamente cómo se escribió el patrón que este chokepoint viene
 * a reemplazar, y por qué 19 avisos se quedaron sin la mitad in-app.
 */
/**
 * Los ÚNICOS que pueden mandar correo. Dos, y por construcción no debería haber un tercero:
 * la definición y el chokepoint. Un emisor nuevo va por `notificarUsuario({ email: {...} })`.
 *
 * A diferencia del mapa de WhatsApp, acá NO hay familia `RESPUESTA`: el correo no tiene
 * turno de conversación. Todo correo que Neto manda es un empuje, así que la excepción que
 * justifica los 30 usos de `webhook.js` no tiene análogo de este lado.
 */
const EMAIL_CRUDO = new Map([
  ['lib/email.js', { usos: 1, motivo: 'la definición de enviarEmail' }],
  ['lib/notify-user.js', { usos: 1, motivo: 'el chokepoint: el único autorizado a llamarlo' }],
]);

const IN_APP_CRUDA = new Map([
  ['lib/notifications-db.js', { usos: 1, motivo: 'la definición de crearNotificacion' }],
  ['lib/notify-user.js', { usos: 1, motivo: 'el chokepoint' }],
  ['services/notifications.js', { usos: 1, motivo: 'la nota de "gasto inusual" se ADJUNTA a un mensaje que arma otro; no es un envío propio' }],
]);

function archivosJs(dir) {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (statSync(full).isDirectory()) return archivosJs(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

const cuenta = (txt, re) => (txt.match(re) || []).length;

const FUENTES = [
  ...DIRS.filter((d) => existsSync(join(RAIZ, d))).flatMap((d) => archivosJs(join(RAIZ, d))),
  ...SUELTOS.filter((f) => existsSync(join(RAIZ, f))).map((f) => join(RAIZ, f)),
].map((full) => ({
  rel: relative(RAIZ, full).replace(/\\/g, '/'),
  src: readFileSync(full, 'utf-8'),
}));

describe('chokepoint de notificaciones proactivas', () => {
  // ── Antivacuidad ──────────────────────────────────────────────────────────────
  it('el barrido encuentra el backend (si esto se rompe, todo lo de abajo miente)', () => {
    expect(FUENTES.length).toBeGreaterThan(40);
    const rels = FUENTES.map((f) => f.rel);
    for (const obligatorio of [
      'cron/checks.js',
      'services/shared-spaces.js',
      'services/survey-triggers.js',
      'services/referrals.js',
      'lib/notify-user.js',
    ]) {
      expect(rels, obligatorio + ' no entró al barrido').toContain(obligatorio);
    }
    // Y encuentra envíos: un barrido que no ve ninguno está roto, no limpio.
    const totalChoke = FUENTES.reduce((s, f) => s + cuenta(f.src, CHOKEPOINT), 0);
    expect(totalChoke).toBeGreaterThanOrEqual(30);
  });

  it('el detector reconoce un envío crudo y una declaración válida (contraprueba)', () => {
    // Sin esto, los tests de abajo podrían estar verdes solo porque la regex dejó de matchear.
    expect(cuenta("await enviarWhatsapp(u.whatsapp, msg, { tipo: 'x' });", ENVIO_CRUDO)).toBe(1);
    expect(cuenta("const { enviarWhatsapp } = require('./whatsapp');", ENVIO_CRUDO)).toBe(0);

    const bueno = 'await notificarUsuario({ canales: CANALES.AMBOS, usuarioId: u.id });';
    expect(cuenta(bueno, CHOKEPOINT)).toBe(1);
    expect(cuenta(bueno, CON_CANALES)).toBe(1);

    const malo = 'await notificarUsuario({ usuarioId: u.id, mensaje: msg });';
    expect(cuenta(malo, CHOKEPOINT)).toBe(1);
    expect(cuenta(malo, CON_CANALES)).toBe(0);

    // Un canal único sin motivo NO puede robarse el motivo de la llamada siguiente.
    const robo = "notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, tipo: 'a' });\n" +
      "notificarUsuario({ canales: CANALES.SOLO_IN_APP, motivo: 'x' });";
    expect(cuenta(robo, CANAL_UNICO)).toBe(2);
    expect(cuenta(robo, UNICO_CON_MOTIVO)).toBe(1);
  });

  // ── Sin clasificar ────────────────────────────────────────────────────────────
  it('nadie llama enviarWhatsapp crudo sin estar declarado', () => {
    const sinDeclarar = FUENTES
      .filter((f) => cuenta(f.src, ENVIO_CRUDO) > 0)
      .map((f) => f.rel)
      .filter((rel) => !WHATSAPP_CRUDO.has(rel));

    expect(sinDeclarar).toEqual([]);
  });

  /**
   * `ENVIO_CRUDO` cuenta el NOMBRE `enviarWhatsapp(`, así que cualquier otra forma de llegar a la
   * función lo esquiva: un alias al importar, una asignación, una clave en un objeto de
   * dependencias, un parámetro por defecto. Desde el 12-sep-2026 `enviarWhatsapp(null, …,
   * { usuarioId })` SÍ entrega (resuelve el BSUID), así que cualquiera de esas es un empuje que
   * funciona sin la campana.
   *
   * **La regla está INVERTIDA a propósito.** La primera versión enumeraba formas de alias y la
   * segunda revisión adversarial la evadió con cuatro formas comunes que no estaban en la lista.
   * Ahora se enumera lo PERMITIDO, que son dos cosas: la llamada y el import con su nombre. Todo
   * lo demás es rojo, con los comentarios blanqueados antes para no marcar prosa.
   */
  const sinComentariosJs = (src) =>
    src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  function usosQueNoSonLlamada(src) {
    const limpio = sinComentariosJs(src);
    const out = [];
    for (const m of limpio.matchAll(/\benviarWhatsapp\b/g)) {
      const antes = limpio.slice(0, m.index);
      const despues = limpio.slice(m.index + m[0].length);
      if (/^\s*\(/.test(despues)) continue;                                      // la llamada
      const importConSuNombre = /(?:const|let|var)\s*\{[^{}]*$/.test(antes)
        && /^[^{}:]*\}\s*=\s*require\(/.test(despues);                          // { enviarWhatsapp, … } = require(
      if (importConSuNombre) continue;
      out.push(antes.split('\n').length);
    }
    return out;
  }
  /** Los que pasan la función por referencia a propósito, con el motivo. */
  const REFERENCIA_EXENTA = new Map([
    ['handlers/message-processor.js', 'arma el `ctx` de los intents con `enviarWhatsapp` adentro. Un intent que lo llame aparece como `ctx.enviarWhatsapp(` y lo cuenta ENVIO_CRUDO en su propio archivo'],
  ]);
  it('fuera de los declarados, enviarWhatsapp solo aparece como llamada o en su import', () => {
    const conReferencia = FUENTES
      .filter((f) => !WHATSAPP_CRUDO.has(f.rel) && !REFERENCIA_EXENTA.has(f.rel))
      .map((f) => ({ rel: f.rel, lineas: usosQueNoSonLlamada(f.src) }))
      .filter((f) => f.lineas.length > 0)
      .map((f) => f.rel + ':' + f.lineas.join(','));
    expect(conReferencia).toEqual([]);
  });
  it('contraprueba: las formas de alias que evadieron la versión anterior salen rojas', () => {
    for (const alias of [
      "const { enviarWhatsapp: avisarWa } = require('../lib/whatsapp');",
      "const avisar = require('../lib/whatsapp').enviarWhatsapp;",
      "const { enviarWhatsapp } = require('../lib/whatsapp'); const avisar = enviarWhatsapp;",
      "const deps = { enviar: wa.enviarWhatsapp };",
      "async function f(u, { enviar = enviarWhatsapp } = {}) {}",
      "const avisar = require('../lib/whatsapp')\n  .enviarWhatsapp;",
    ]) expect(usosQueNoSonLlamada(alias).length, alias).toBeGreaterThan(0);
    // Lo legítimo no cuenta: el import con su nombre (también en varias líneas), la llamada
    // directa y por el módulo, y un comentario que lo nombra.
    for (const ok of [
      "const { enviarWhatsapp, procesarStatuses } = require('./whatsapp');",
      "const {\n  enviarWhatsapp,\n  procesarStatuses,\n} = require('./whatsapp');",
      "await enviarWhatsapp(n, m);",
      "await wa.enviarWhatsapp(n, m);",
      "// enviarWhatsapp: no lanza por contrato",
    ]) expect(usosQueNoSonLlamada(ok), ok).toEqual([]);
  });

  it('nadie escribe la in-app cruda sin estar declarado', () => {
    const sinDeclarar = FUENTES
      .filter((f) => cuenta(f.src, IN_APP_CRUDO) > 0)
      .map((f) => f.rel)
      .filter((rel) => !IN_APP_CRUDA.has(rel));

    expect(sinDeclarar).toEqual([]);
  });

  // ── Anti-fantasma + conteos fijados ───────────────────────────────────────────
  it('no hay exenciones fantasma, y los conteos declarados son los reales', () => {
    const reales = new Map(
      FUENTES.filter((f) => cuenta(f.src, ENVIO_CRUDO) > 0)
        .map((f) => [f.rel, cuenta(f.src, ENVIO_CRUDO)]),
    );
    expect(
      [...WHATSAPP_CRUDO.keys()].filter((rel) => !reales.has(rel)),
      'exenciones que ya no llaman enviarWhatsapp: bórralas',
    ).toEqual([]);

    // Si esto falla porque agregaste una RESPUESTA, subí el número.
    // Si agregaste un EMPUJE, no lo subas: usá notificarUsuario.
    expect(
      [...WHATSAPP_CRUDO.entries()]
        .filter(([rel, d]) => reales.get(rel) !== d.usos)
        .map(([rel, d]) => rel + ': declarado ' + d.usos + ', real ' + reales.get(rel)),
    ).toEqual([]);

    const inAppReales = new Map(
      FUENTES.filter((f) => cuenta(f.src, IN_APP_CRUDO) > 0)
        .map((f) => [f.rel, cuenta(f.src, IN_APP_CRUDO)]),
    );
    expect([...IN_APP_CRUDA.keys()].filter((rel) => !inAppReales.has(rel))).toEqual([]);
    expect(
      [...IN_APP_CRUDA.entries()]
        .filter(([rel, d]) => inAppReales.get(rel) !== d.usos)
        .map(([rel]) => rel),
    ).toEqual([]);
  });

  it('toda exención declara familia y motivo de verdad', () => {
    for (const [rel, d] of WHATSAPP_CRUDO) {
      expect(d.familia, rel + ' sin familia').toBeTruthy();
      expect(String(d.motivo).length, rel + ' sin motivo real').toBeGreaterThan(15);
    }
  });

  // ── La declaración de canales es obligatoria ──────────────────────────────────
  it('toda llamada a notificarUsuario declara canales como primera clave', () => {
    const sinCanales = FUENTES
      .filter((f) => f.rel !== 'lib/notify-user.js')   // ahí vive la definición
      .map((f) => ({ rel: f.rel, total: cuenta(f.src, CHOKEPOINT), ok: cuenta(f.src, CON_CANALES) }))
      .filter((f) => f.total !== f.ok)
      .map((f) => f.rel + ': ' + f.total + ' llamadas, ' + f.ok + ' con `canales:` primero');

    expect(sinCanales).toEqual([]);
  });

  it('todo canal único lleva su motivo, y AMBOS no lo lleva', () => {
    const sinMotivo = FUENTES
      .filter((f) => f.rel !== 'lib/notify-user.js')
      .map((f) => ({
        rel: f.rel,
        unicos: cuenta(f.src, CANAL_UNICO),
        conMotivo: cuenta(f.src, UNICO_CON_MOTIVO),
      }))
      .filter((f) => f.unicos !== f.conMotivo)
      .map((f) => f.rel + ': ' + f.unicos + ' canales únicos, ' + f.conMotivo + ' con motivo');
    expect(sinMotivo).toEqual([]);

    // Un `motivo` sobre el default es ruido: diluye el grep que audita las excepciones.
    expect(FUENTES.filter((f) => cuenta(f.src, AMBOS_CON_MOTIVO) > 0).map((f) => f.rel)).toEqual([]);
  });

  // ── Nominales: los huecos del incidente, uno por uno ──────────────────────────
  // Si alguien revierte uno, este test dice cuál y por qué importaba.
  it.each([
    ['services/shared-spaces.js', 3, 'nuevo miembro, reparto editado, reglas editadas, gasto compartido, liquidación'],
    ['services/referrals.js', 1, 'el referrer gana un mes irreversible y solo se enteraba por WhatsApp'],
    // Bajó de 5 a 3 el 14-sep-2026, cuando se apagaron los dos wake_up (ver
    // `tests/services/wake-up-apagados.test.js`). Los 4 recordatorios comparten una llamada.
    ['services/survey-triggers.js', 3, 'los 4 recordatorios (enviarYRegistrar) + webapp_invite_10tx + feedback_30tx'],
    ['services/gmail-scanner.js', 2, 'Gmail desconectado: el usuario deja de registrar gastos sin saberlo'],
    ['routes/internal.js', 1, 'activación web completada'],
    // El piso se quedó en 19 cuando el recordatorio de inactividad se apagó (01-sep-2026):
    // este barrido afirma que nadie manda WhatsApp crudo, no cuántos avisos hay, y bajar el
    // piso a la cuenta exacta lo volvería un test de inventario que hay que tocar en cada PR.
    ['cron/checks.js', 19, 'los 15 duales + trial + pro_upsell_d28'],
  ])('%s manda por el chokepoint (>=%i llamadas): %s', (rel, minimo) => {
    const f = FUENTES.find((x) => x.rel === rel);
    expect(f, rel + ' ya no existe: actualiza este test').toBeDefined();
    expect(cuenta(f.src, ENVIO_CRUDO), rel + ' volvió a llamar enviarWhatsapp crudo').toBe(0);
    expect(cuenta(f.src, CHOKEPOINT)).toBeGreaterThanOrEqual(minimo);
  });

  // ── El canal de correo, con la misma regla ────────────────────────────────────
  it('el barrido ve el canal de correo (antivacuidad)', () => {
    // Si `lib/email.js` desaparece del barrido, las dos aserciones de abajo pasan sin mirar
    // nada — y la de "nadie manda correo crudo" se cumpliría trivialmente.
    const rels = FUENTES.map((f) => f.rel);
    expect(rels).toContain('lib/email.js');
    const total = FUENTES.reduce((s, f) => s + cuenta(f.src, ENVIO_EMAIL_CRUDO), 0);
    expect(total, 'nadie llama enviarEmail: el barrido está roto o el canal murió').toBe(2);
  });

  it('el detector de correo reconoce un envío crudo y un canal sin asunto (contraprueba)', () => {
    expect(cuenta("await enviarEmail(u.email, { asunto: 'x' });", ENVIO_EMAIL_CRUDO)).toBe(1);
    expect(cuenta("const { enviarEmail } = require('./email');", ENVIO_EMAIL_CRUDO)).toBe(0);
    // El asunto: sin él no hay correo. La forma buena NO se marca.
    expect(canalesDeCorreoSinAsunto("email: { to: u.email, asunto: 'Tu deuda vence hoy' },")).toEqual([]);
    expect(canalesDeCorreoSinAsunto('email: { to: u.email },')).toHaveLength(1);
    // Y el `asunto` de la llamada SIGUIENTE no puede tapar al que falta en ésta.
    expect(canalesDeCorreoSinAsunto("email: { to: a } }, email: { to: b, asunto: 'y' }")).toHaveLength(1);
    // ── Las evasiones que encontró la revisión adversarial ────────────────────────────
    // Una llave ANIDADA: con el `[^{}]` de la primera versión esto pasaba en verde.
    expect(canalesDeCorreoSinAsunto('email: { to: x, headers: { a: 1 } },')).toHaveLength(1);
    // Y no se marca de más: el mismo objeto anidado CON asunto está bien.
    expect(canalesDeCorreoSinAsunto("email: { to: x, headers: { a: 1 }, asunto: 'z' },")).toEqual([]);
    // Un `email:` que no abre llave no se puede verificar desde acá: falla cerrado.
    expect(canalesDeCorreoSinAsunto('email: opts,')).toHaveLength(1);
    expect(canalesDeCorreoSinAsunto('email: armarEmail(u),')).toHaveLength(1);
    // El extractor acota el barrido a la llamada: un `email:` de un JSON Schema no es un canal.
    const schema = "const T = { properties: { email: { type: 'string' } } };";
    expect(llamadasAlChokepoint(schema)).toEqual([]);
    expect(canalesDeCorreoSinAsunto(schema), 'sin acotar, el schema de un tool sale marcado').toHaveLength(1);
    // Y con parentesis balanceados: el `)` de `x.split(' ')` no puede cortar el argumento.
    const conParen = "notificarUsuario({ titulo: n.split(' ')[0], email: { to: a } });";
    expect(canalesDeCorreoSinAsunto(llamadasAlChokepoint(conParen)[0])).toHaveLength(1);
  });

  it('nadie manda correo por fuera del chokepoint', () => {
    const infractores = FUENTES
      .map((f) => ({ rel: f.rel, usos: cuenta(f.src, ENVIO_EMAIL_CRUDO) }))
      .filter((f) => f.usos > 0)
      .filter((f) => {
        const declarado = EMAIL_CRUDO.get(f.rel);
        return !declarado || declarado.usos !== f.usos;
      })
      .map((f) => f.rel + ': ' + f.usos + ' llamadas a enviarEmail');
    expect(
      infractores,
      'un envío de correo fuera de notificarUsuario no deja fila en notification_deliveries ' +
      'con el resto del aviso, y el canal vuelve a reportar solo lo que el proveedor aceptó',
    ).toEqual([]);
  });

  it('todo canal de correo declarado trae su asunto', () => {
    const sinAsunto = FUENTES
      .flatMap((f) => llamadasAlChokepoint(f.src).map((arg) => ({ rel: f.rel, arg })))
      .flatMap(({ rel, arg }) => canalesDeCorreoSinAsunto(arg).map((o) => rel + ': ' + o));
    expect(sinAsunto).toEqual([]);
  });

  it('el detector de dirección probada decide en las dos direcciones (contraprueba)', () => {
    const ok = [
      "email: { to: correoVerificado(usuario), asunto: 'x' }",
      "email: { to: correoVerificado(grupo.usuario), asunto: 'Deudas: S/ 10, US$ 2 (esta semana)' }",
      "email: { asunto: 'x', to: correoVerificado(avisar ? ventana : null) }",
    ];
    for (const a of ok) expect(correosSinVerificar(a), a).toEqual([]);
    const malos = [
      "email: { to: usuario.email || null, asunto: 'x' }",
      "email: { to: correo, asunto: 'x' }",
      "email: { to: correoVerificado(u) || u.email, asunto: 'x' }",
      "email: { to: correoVerificado({ ...u, supabase_auth_id: 'x' }), asunto: 'x' }",
      "email: { to, asunto: 'x' }",
      "email: { to: correoVerificado(u), ...extra, asunto: 'x' }",
      "email: { to: correoVerificado(u), to: u.email, asunto: 'x' }",
      'email: opts',
    ];
    for (const a of malos) expect(correosSinVerificar(a), a).toHaveLength(1);
    // Las dos que la revisión adversarial coló con la suite entera en verde (15-sep): el
    // barrido por `email:` no las veía porque no hay `email:` sin comillas que ver.
    expect(correosSinVerificar("{ canales: x, usuarioId: u.id, email }")).toHaveLength(1);
    expect(correosSinVerificar("{ canales: x, email, titulo: 't' }")).toHaveLength(1);
    expect(correosSinVerificar("{ canales: x, 'email': { to: u.email, asunto: 'x' } }").length).toBeGreaterThanOrEqual(1);
    // Y no se marca de más: `emailRes` o `datos: { correo }` no son el canal.
    expect(correosSinVerificar("{ canales: x, emailRes, titulo: 't' }")).toEqual([]);
  });

  it('nadie más nombra `enviarEmail`, ni siquiera con un alias (revisión adversarial, 15-sep)', () => {
    // `ENVIO_EMAIL_CRUDO` cuenta LLAMADAS, así que `const { enviarEmail: mandar } = require(...)`
    // y después `mandar(u.email, ...)` pasaba en verde: la llamada no se llama `enviarEmail`.
    // Cualquier referencia fuera de la definición y del chokepoint es roja, se use como se use.
    const fuera = FUENTES
      .filter((f) => f.rel !== 'lib/email.js' && f.rel !== 'lib/notify-user.js')
      // Sin comentarios: nombrarla en prosa ("a `enviarEmail` no se llega") no es un alias.
      .filter((f) => /\benviarEmail\b/.test(
        f.src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')))
      .map((f) => f.rel);
    expect(fuera).toEqual([]);
  });

  it('todo canal de correo manda a una dirección probada (correoVerificado)', () => {
    const llamadas = FUENTES
      .flatMap((f) => llamadasAlChokepoint(f.src).map((arg) => ({ rel: f.rel, arg })));
    // Antivacuidad: seis emisores al 15-sep-2026 (upsell, d11/d14, muro, resumen de deudas,
    // inactividad, soporte). Si el barrido deja de verlos, el test de abajo pasa sin mirar.
    expect(llamadas.filter(({ arg }) => /\bemail\s*:/.test(arg)).length).toBeGreaterThanOrEqual(6);
    // El detector corre sobre TODAS las llamadas, no sobre las que ya traen `email:`. Filtrar
    // primero era justo lo que dejaba pasar `{ ..., email }` y `'email': {...}`: sin un `email:`
    // pelado la llamada ni llegaba al detector que las sabe reconocer (re-mutado el 15-sep).
    const sinVerificar = llamadas.flatMap(({ rel, arg }) => correosSinVerificar(arg).map((o) => rel + ': ' + o));
    expect(
      sinVerificar,
      'El `to` de un correo sale de `correoVerificado(usuario)` y de nada más. `usuarios.email` ' +
      'puede traer una dirección dictada por WhatsApp que nadie probó, y un typo le manda a un ' +
      'desconocido los avisos de plata de otra persona.',
    ).toEqual([]);
  });

  it('el detector de spreads opacos decide en las dos direcciones (contraprueba, ítem 35b)', () => {
    expect(spreadsOpacos("{ canales: x, ...(conCorreo ? { email: { to: a, asunto: 'b' } } : {}) }")).toEqual([]);
    expect(spreadsOpacos('{ canales: x, ...opts }')).toHaveLength(1);
    expect(spreadsOpacos('{ canales: x, ...(conCorreo ? extra : {}) }')).toHaveLength(1);
    expect(spreadsOpacos('{ canales: x, ...(conCorreo ? { a: 1 } : otro) }')).toHaveLength(1);
    expect(spreadsOpacos('{ canales: x, ...armar(u) }')).toHaveLength(1);
  });

  it('ninguna llamada al chokepoint esconde argumentos en un spread (ítem 35b)', () => {
    const opacos = FUENTES
      .flatMap((f) => llamadasAlChokepoint(f.src).map((arg) => ({ rel: f.rel, arg })))
      .flatMap(({ rel, arg }) => spreadsOpacos(arg).map((s) => rel + ': ' + s));
    expect(
      opacos,
      'Un spread que no es `...(cond ? { literal } : {})` esconde lo que declara: un `email` ' +
      'armado en una variable no lo ve ningún guard (ni el asunto, ni la columna, ni la dirección ' +
      'probada). Escribí el literal.',
    ).toEqual([]);
  });

  it('el extractor de llamadas trae el argumento ENTERO (antivacuidad)', () => {
    const llamadas = FUENTES.flatMap((f) => llamadasAlChokepoint(f.src));
    // Si el balanceo se rompiera, cortaría en el primer `)` interno y los argumentos serían
    // fragmentos: `EMAIL_SIN_ASUNTO` no encontraría nada y el test de arriba pasaría vacío.
    expect(llamadas.length).toBeGreaterThanOrEqual(30);
    expect(llamadas.some((a) => a.includes('email:') && a.includes('asunto:'))).toBe(true);
    // Y un argumento con paréntesis adentro (un ternario, una llamada) llega completo.
    expect(llamadas.some((a) => a.includes('(') && a.includes('link:'))).toBe(true);
  });

  // El caso que sostiene la regla del módulo de espacios: cualquier miembro puede cambiar el
  // reparto, y lo que hace que eso sea seguro no es el permiso, es que se ANUNCIE.
  it('los avisos de espacios no filtran por whatsapp antes de notificar', () => {
    const f = FUENTES.find((x) => x.rel === 'services/shared-spaces.js');
    // Estos filtros dejaban al miembro web-only sin enterarse de que su parte se movió.
    expect(f.src).not.toMatch(/if\s*\(\s*!\s*m\.usuarios\?\.whatsapp\s*\)\s*continue/);
    expect(f.src).not.toMatch(/if\s*\(\s*toUsuario\?\.whatsapp\s*\)/);
  });

  // El conteo total de canales únicos por archivo. Se fija para que uno nuevo tenga que
  // pasar por acá; POR QUÉ es cada uno lo dice el desglose de abajo.
  it.each([
    ['cron/checks.js', 4, 'checkActivacionDia2, checkRecordatorioOnboarding, checkResumenDeudasSemanal y checkRecordatorioInactividadSemanal'],
    // Era 2 hasta el 14-sep-2026: la otra era la rama sin cuenta web de `wake_up_onboarding`,
    // que se apagó entero ese día.
    ['services/survey-triggers.js', 1, 'webapp_invite_10tx'],
  ])('%s tiene exactamente %i exenciones de canal (%s)', (rel, esperadas) => {
    const f = FUENTES.find((x) => x.rel === rel);
    expect(cuenta(f.src, CANAL_UNICO)).toBe(esperadas);
  });

  /**
   * El conteo de arriba subió a 3 el 31-ago-2026 y a 4 el 01-sep-2026, y el número solo no
   * habría dicho lo que pasó, porque las clases no son intercambiables.
   *
   * · `SOLO_WHATSAPP` (2) — destinatarios que por construcción no tienen dónde recibir una
   *   in-app: la query que los selecciona exige que NO tengan cuenta web. Ésa es la afirmación
   *   que `canal-unico-sin-cuenta-web.test.js` verifica una por una.
   * · `SOLO_IN_APP` (2) — los dos correos agrupados por persona, y en los dos el canal que
   *   falta es el de WhatsApp:
   *     · `checkResumenDeudasSemanal`: el toque fechado de cada deuda ya sale por ahí desde
   *       `checkRecordatorioDeudas`, así que mandar además el resumen agrupado sería repetir
   *       el mismo contenido en el mismo canal — la ráfaga que el resumen vino a sacar, un
   *       nivel más arriba.
   *     · `checkRecordatorioInactividadSemanal`: el motivo está MEDIDO, no supuesto. Este
   *       mismo aviso salía por WhatsApp hasta el 01-sep-2026 y entregaba **4 de 190 intentos
   *       en 30 días**, porque su destinatario está definido como el que lleva días sin
   *       escribir, o sea fuera de la ventana de 24h de Meta. El canal que sí llega es el
   *       correo, que se declara aparte.
   *
   * Separarlos importa porque las dos clases tienen guards distintos: si mañana uno de los
   * resúmenes pasara a `SOLO_WHATSAPP` sin tocar nada más, el conteo total seguiría en 4 y el
   * hermano `canal-unico-sin-cuenta-web` lo marcaría por no filtrar `supabase_auth_id`. Fijar
   * el desglose hace que se vea acá también, que es donde se lee el reparto de canales.
   */
  it('el reparto por clase de canal único en cron/checks.js', () => {
    const f = FUENTES.find((x) => x.rel === 'cron/checks.js');
    expect(cuenta(f.src, /CANALES\.SOLO_WHATSAPP/g)).toBe(2);
    expect(cuenta(f.src, /CANALES\.SOLO_IN_APP/g)).toBe(2);
  });
});
