// ¿Se le puede escribir a alguien usando su WhatsApp USERNAME como destinatario?
//
// Esta pregunta NO está medida, aunque la memoria y el CLAUDE.md se lean como si lo estuviera.
// Lo que se midió el 08-ago-2026 (v19.0, v23.0, v24.0 y v25.0) fue el **BSUID** como destino, y
// el BSUID es otro campo. El username nunca se probó — entre otras cosas porque hasta hoy no
// estaba claro que lo tuviéramos.
//
// **Lo tenemos.** Todas las filas de `errores` con `tag='WEBHOOK'` y "sin from" traen
// `clavesPerfil: ["name","username"]`, o sea que Meta manda `contacts[0].profile.username` en el
// mismo payload donde deja de mandar el número. `handlers/webhook.js` guarda solo los NOMBRES de
// las claves (decisión de privacidad sobre el nombre del perfil), así que el valor se descarta.
//
// ─── Por qué es DIFERENCIAL, y no una lista de intentos ────────────────────────────────────
//
// El dato que hace interpretable a todo esto ya está medido: **Meta IGNORA los campos que no
// conoce**. Un parámetro inventado junto a un `to` válido devuelve 200 y no pasa nada. La
// consecuencia es que un `#100 Invalid parameter` NO significa "ese valor está mal": significa
// "ese campo no existe y ahora falta el que sí existe".
//
// De ahí que un intento suelto no concluya nada. Lo que concluye es la COMPARACIÓN: se manda el
// mismo payload dos veces, una con el campo candidato (`username`) y otra con un campo
// garantizadamente inexistente (`zzz_campo_que_no_existe`). Si las dos respuestas son idénticas
// byte a byte, el candidato es tan desconocido como el inventado. Si difieren, Meta lo conoce —
// y ahí sí hay algo que perseguir.
//
// ─── Por qué no le llega a nadie ───────────────────────────────────────────────────────────
//
// El destinatario de todos los payloads es una cadena SIN UN SOLO DÍGITO. Importa porque Meta
// sanitiza `to` quitando lo no numérico (para tolerar "+51 999 888 777"): un destino sin dígitos
// se sanitiza a la cadena vacía y no puede alcanzar a nadie. El script se niega a arrancar si
// algún destino trae un dígito.
//
// La precaución no es teórica. En agosto se eligió `999999999999999` como "destinatario
// obviamente inválido", Meta lo ACEPTÓ con 200 y se encolaron 6 mensajes a nadie. Y en la misma
// tanda, un BSUID con forma real devolvió 200 con wamid y pareció funcionar: el wamid decodificaba
// a los 16 dígitos pelados, o sea que Meta lo había tratado como teléfono. Por eso acá **todo 200
// se trata como hallazgo grave**: se imprime el cuerpo entero y se decodifica el wamid antes de
// concluir nada.
//
// Un 200 tampoco probaría entrega: Meta encola y el fracaso llega después por el callback.
//
// Uso:  railway run node qa-e2e/probe-envio-por-username.mjs
//       (las credenciales META_* viven en Railway; el .env local NO las tiene)

const VERSIONES = ['v19.0', 'v25.0'];

// Sin un solo dígito, a propósito: ver el bloque de arriba.
const DESTINO_IMPOSIBLE = 'zzqxnohayusuarioasi';
// El control de "campo que Meta no conoce". Cualquier respuesta que un candidato comparta con
// este es, por definición, la respuesta a un campo inexistente.
const CAMPO_FALSO = 'zzz_campo_que_no_existe';
const VALOR_FALSO = 'zzz_valor_que_no_existe';

const texto = { body: 'probe' };

/**
 * Los casos van de a PARES: `candidato` y su `control`, con la única diferencia siendo el nombre
 * (o el valor) del campo que se está probando. Comparar respuestas entre pares distintos no
 * significaría nada — la comparación válida es siempre dentro del par.
 */
const PARES = [
  {
    // ─── CONTROL POSITIVO. Va primero porque si este no distingue, nada de lo de abajo vale ───
    //
    // Todos los casos siguientes concluyen leyendo un "no se distinguen". Un comparador ciego
    // produce exactamente esa lectura sin haber mirado nada, y saldría "el username no sirve"
    // con la misma confianza aunque sirviera. Ver [[feedback_guards_que_no_ven]].
    //
    // Este par usa un valor que Meta SÍ acepta (`individual`, que está en el enum) contra uno
    // que no. El aceptado pasa de largo y falla más adelante por el `to`; el rechazado muere en
    // el enum. Si estas dos respuestas NO difieren, el instrumento no puede ver la diferencia
    // que todo el resto del probe afirma no encontrar, y el probe entero se descarta.
    nombre: 'CONTROL POSITIVO · recipient_type: "individual" (válido) vs uno inventado',
    esControlPositivo: true,
    candidato: { messaging_product: 'whatsapp', recipient_type: 'individual', to: DESTINO_IMPOSIBLE, type: 'text', text: texto },
    control: { messaging_product: 'whatsapp', recipient_type: VALOR_FALSO, to: DESTINO_IMPOSIBLE, type: 'text', text: texto },
  },
  {
    nombre: 'to = username',
    // Este no tiene par: es el camino que la doc de terceros afirmaba que funciona, y el que ya
    // demostró sanitizar el BSUID. Se corre solo para ver la forma base del rechazo.
    candidato: { messaging_product: 'whatsapp', to: DESTINO_IMPOSIBLE, type: 'text', text: texto },
    control: null,
  },
  {
    nombre: 'recipient_type: "username"',
    candidato: { messaging_product: 'whatsapp', recipient_type: 'username', to: DESTINO_IMPOSIBLE, type: 'text', text: texto },
    control: { messaging_product: 'whatsapp', recipient_type: VALOR_FALSO, to: DESTINO_IMPOSIBLE, type: 'text', text: texto },
  },
  {
    nombre: 'username como campo de primer nivel (sin `to`)',
    candidato: { messaging_product: 'whatsapp', username: DESTINO_IMPOSIBLE, type: 'text', text: texto },
    control: { messaging_product: 'whatsapp', [CAMPO_FALSO]: DESTINO_IMPOSIBLE, type: 'text', text: texto },
  },
  {
    nombre: 'username junto a `to` (¿lo ignora, como a los campos que no conoce?)',
    candidato: { messaging_product: 'whatsapp', to: DESTINO_IMPOSIBLE, username: DESTINO_IMPOSIBLE, type: 'text', text: texto },
    control: { messaging_product: 'whatsapp', to: DESTINO_IMPOSIBLE, [CAMPO_FALSO]: DESTINO_IMPOSIBLE, type: 'text', text: texto },
  },
  {
    nombre: 'recipient: { username }',
    candidato: { messaging_product: 'whatsapp', recipient: { username: DESTINO_IMPOSIBLE }, type: 'text', text: texto },
    control: { messaging_product: 'whatsapp', recipient: { [CAMPO_FALSO]: DESTINO_IMPOSIBLE }, type: 'text', text: texto },
  },
  {
    nombre: 'wa_username como campo de primer nivel',
    candidato: { messaging_product: 'whatsapp', wa_username: DESTINO_IMPOSIBLE, type: 'text', text: texto },
    control: { messaging_product: 'whatsapp', [CAMPO_FALSO]: DESTINO_IMPOSIBLE, type: 'text', text: texto },
  },
];

let hubo200 = false;

/** Decodifica un wamid para ver a QUIÉN se lo mandó Meta de verdad. */
function destinoDelWamid(wamid) {
  try {
    const crudo = Buffer.from(String(wamid).replace(/^wamid\./, ''), 'base64').toString('latin1');
    const legible = crudo.replace(/[^\x20-\x7E]/g, '·');
    return legible;
  } catch (e) {
    return '(no se pudo decodificar: ' + e.message + ')';
  }
}

async function postear(version, phoneId, token, payload) {
  const url = 'https://graph.facebook.com/' + version + '/' + phoneId + '/messages';
  let res, cuerpo;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    cuerpo = await res.text();
  } catch (e) {
    // Un fallo de red NO es un veredicto: es que el POST no llegó a Meta. Se marca como tal para
    // que no se lea como "el campo no existe".
    return { status: null, cuerpo: null, error: e.message };
  }
  return { status: res.status, cuerpo, error: null };
}

/**
 * Lo que se compara entre candidato y control: el par (código, subcódigo, mensaje).
 *
 * **El valor enviado se borra del mensaje antes de comparar, y sin eso el probe miente.** Para
 * `recipient_type`, Meta contesta con el valor ofensor incrustado ("...but got 'username'"), así
 * que candidato y control salen distintos SIEMPRE — no porque Meta reconozca el campo, sino
 * porque le está haciendo eco a lo que le mandé. La primera corrida (03-sep-2026) concluyó
 * "Meta SÍ conoce este campo" con dos mensajes que decían exactamente lo contrario.
 *
 * Es la clase de [[feedback_negativo_que_rechaza_por_otra_condicion]] dada vuelta: un
 * diferencial que difiere por otra condición que la que se está midiendo.
 */
function huella(r, distintivos = []) {
  if (r.error) return 'SIN_RESPUESTA:' + r.error;
  let j = null;
  try { j = JSON.parse(r.cuerpo); } catch (e) { /* Meta puede devolver HTML en un 5xx */ }
  const scrub = (s) => distintivos.reduce((acc, v) => acc.split(v).join('<eco>'), String(s));
  if (!j || !j.error) return String(r.status) + ':' + scrub(String(r.cuerpo).slice(0, 200));
  const e = j.error;
  return [r.status, e.code, e.error_subcode == null ? '-' : e.error_subcode, scrub(e.message)].join(' | ');
}

/** Todas las claves y valores string de un payload, en profundidad. */
function tokens(o, acc = new Set()) {
  if (o == null) return acc;
  if (typeof o === 'string') { acc.add(o); return acc; }
  if (typeof o !== 'object') return acc;
  for (const [k, v] of Object.entries(o)) { acc.add(k); tokens(v, acc); }
  return acc;
}

/**
 * Lo único que puede hacer que candidato y control difieran por ECO: los tokens que están en uno
 * y no en el otro. Se borran de los dos mensajes antes de comparar. Los tokens COMPARTIDOS
 * (`messaging_product`, `whatsapp`, `to`, el destino) se dejan intactos: borrarlos de más
 * escondería una diferencia real.
 */
function distintivosDelPar(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  return [...new Set([...ta, ...tb])].filter((t) => !(ta.has(t) && tb.has(t)));
}

async function main() {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.log('Faltan META_ACCESS_TOKEN / META_PHONE_NUMBER_ID.');
    console.log('El .env local NO los tiene: correr con `railway run node qa-e2e/probe-envio-por-username.mjs`.');
    return 2;
  }

  // La guarda que hace que esto no le llegue a nadie. Va antes de cualquier POST.
  if (/\d/.test(DESTINO_IMPOSIBLE)) {
    console.log('ABORTA: el destino de prueba tiene un dígito y Meta sanitiza `to` a dígitos.');
    console.log('Con un dígito adentro, esto puede encolar un mensaje a una persona real.');
    return 2;
  }

  console.log('destino de prueba: "' + DESTINO_IMPOSIBLE + '" (sin dígitos: no puede alcanzar a nadie)');
  console.log('phone number id:   ' + phoneId + '\n');

  const conclusiones = [];

  for (const version of VERSIONES) {
    console.log('═══ ' + version + ' ' + '═'.repeat(60 - version.length));
    for (const par of PARES) {
      const distintivos = par.control ? distintivosDelPar(par.candidato, par.control) : [];
      const rc = await postear(version, phoneId, token, par.candidato);
      const hc = huella(rc, distintivos);
      if (rc.status === 200) hubo200 = true;
      console.log('\n· ' + par.nombre);
      console.log('    candidato → ' + hc);
      if (rc.status === 200) {
        console.log('    ⚠ 200. Cuerpo completo: ' + rc.cuerpo);
        const m = (rc.cuerpo || '').match(/"id"\s*:\s*"(wamid\.[^"]+)"/);
        if (m) console.log('    ⚠ wamid decodificado → ' + destinoDelWamid(m[1]));
      }

      if (!par.control) {
        conclusiones.push({ version, caso: par.nombre, veredicto: 'SIN CONTROL (forma base)', detalle: hc });
        continue;
      }

      const rk = await postear(version, phoneId, token, par.control);
      const hk = huella(rk, distintivos);
      if (rk.status === 200) hubo200 = true;
      console.log('    control   → ' + hk);

      // Si el POST no llegó, no hay nada que comparar. Tratarlo como "idéntico" diría "el campo
      // no existe" sin haber medido nada — la misma clase de error que ya cerró D10.
      if (rc.error || rk.error) {
        conclusiones.push({ version, caso: par.nombre, veredicto: 'NO CONCLUYE (el POST no llegó a Meta)', detalle: rc.error || rk.error });
        continue;
      }
      const iguales = hc === hk;
      if (par.esControlPositivo) {
        conclusiones.push({
          version, caso: par.nombre, esControlPositivo: true,
          veredicto: iguales
            ? '⛔ EL INSTRUMENTO ESTÁ CIEGO — no distingue un valor válido de uno inventado'
            : 'OK: el comparador SÍ distingue lo conocido de lo inventado',
          detalle: iguales ? hc : ('válido: ' + hc + '   ///   inventado: ' + hk),
        });
        continue;
      }
      conclusiones.push({
        version, caso: par.nombre,
        veredicto: iguales ? 'CAMPO DESCONOCIDO (idéntico al inventado)' : '⚠ DIFIERE — Meta conoce este campo',
        detalle: iguales ? hc : ('candidato: ' + hc + '   ///   control: ' + hk),
      });
    }
    console.log('');
  }

  console.log('\n═══ RESUMEN ' + '═'.repeat(55));
  for (const c of conclusiones) {
    console.log('[' + c.version + '] ' + c.caso);
    console.log('   → ' + c.veredicto);
    console.log('     ' + c.detalle);
  }

  const difieren = conclusiones.filter((c) => c.veredicto.startsWith('⚠'));
  const ciego = conclusiones.filter((c) => c.esControlPositivo && c.veredicto.startsWith('⛔'));
  console.log('\n' + '─'.repeat(66));
  // Antes que cualquier veredicto: si el control positivo no distinguió, todos los "no se
  // distinguen" de abajo son vacuos y no se pueden leer como evidencia.
  if (ciego.length) {
    console.log('VEREDICTO: NINGUNO. El control positivo falló en ' + ciego.length + ' versión(es):');
    console.log('el comparador no distingue un `recipient_type` válido de uno inventado, así que');
    console.log('los "campo desconocido" de arriba no prueban nada. Arreglar el instrumento primero.');
    return 2;
  }
  if (hubo200) {
    console.log('VEREDICTO: hubo al menos un 200. NO celebrar todavía — mirar el wamid decodificado');
    console.log('de arriba. En agosto un 200 con wamid resultó ser Meta tratando el identificador');
    console.log('como teléfono después de sanitizarlo. Y un 200 nunca probó entrega.');
    return 1;
  }
  if (difieren.length === 0) {
    console.log('VEREDICTO: el username NO es direccionable. Ninguna de las formas probadas se');
    console.log('distingue de un campo inventado, en ninguna de las dos versiones de la API.');
    console.log('Es el mismo desenlace que el BSUID, ahora medido y no supuesto.');
    return 0;
  }
  console.log('VEREDICTO: ' + difieren.length + ' forma(s) que Meta SÍ reconoce. Seguir por ahí.');
  return 1;
}

// `process.exit()` con handles abiertos revienta libuv en Windows y se lleva el exit code
// (un exit(2) salió 127). Se sale por `exitCode`, como el probe hermano.
main().then((c) => { process.exitCode = c; }).catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
