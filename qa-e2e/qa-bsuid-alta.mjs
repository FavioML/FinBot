// E2E LOCAL del alta por BSUID: alguien que oculta su número le escribe a Neto por primera vez.
//
// Es el caso que `qa-bsuid-username.mjs` saltea a propósito: contra producción, un BSUID
// DESCONOCIDO da de alta una fila real sin `is_test_user` y el bot le escribe a Meta. Acá corre
// contra el webhook EN PROCESO (`webhook-harness.mjs`): Express y Supabase reales, con
// `enviarWhatsapp` y Telegram stubeados. No toca el webhook de producción ni llama a Meta.
//
// Hasta este harness, el camino "BSUID desconocido → altaPorBsuid → onboarding → respuesta al
// BSUID" solo lo cubría `tests/handlers/webhook-sin-from.test.js`, con `resolverUsuarioEntrante`
// MOCKEADO: afirmaba que se llamaba, no que la fila naciera ni que el alta avanzara.
//
// Qué afirma:
//   1. un texto solo con `from_user_id` (sin `from`) crea UNA fila con `whatsapp` NULL y ese
//      BSUID; la creó el código de esta corrida, con el cuerpo `{ whatsapp: null, bsuid }` y sin
//      la marca, que es como nace en producción (lo registra la barrera);
//   2. toda respuesta va a ESE BSUID y a nadie más, incluidas las que lleguen tarde. Un aviso de
//      error al admin por WhatsApp saldría por el mismo stub con otro destino, y esto lo delata;
//   3. el segundo y el tercer mensaje no duplican a la persona;
//   4. el copy del alta no pide ni muestra un número (`lib/copy-sin-numero.mjs`, con sus
//      evasiones fijadas en `tests/qa-e2e-copy-sin-numero.test.js`);
//   5. el camino no deja filas en `errores`.
// Después borra la fila y sus hijas con un cliente REST propio y comprueba que se fueron.
//
// CÓMO CONVIVE CON LAS REGLAS DE SIEMBRA (`lib/qa-guard.mjs` y
// `tests/qa-e2e-siembra-marcada.test.js`). Este harness NO siembra `usuarios`: la fila la inserta
// `altaPorBsuid` sin la marca, y esa forma exacta es lo que se prueba. La barrera la deja pasar
// solo porque el BSUID se declara antes (`esperarAltaPorBsuid`), solo con esa forma exacta, una
// vez, y **la marca `is_test_user` en el mismo instante en que nace**, antes de devolverle la fila
// al código. O sea que la fila sin marca existe lo que dura el INSERT: una corrida que muera no
// deja un alta "real" en producción para los crons. La primera versión la marcaba el harness
// después del primer mensaje, y la revisión adversarial mostró que en ese hueco se le podía
// cambiar el `bsuid` o ponerle un plan.
//
// La marca no cambia lo que se prueba en el camino ejercitado: la leen `isTestUser` (stubeado
// acá) y el `registrarError` de un gasto fallido, que igual lo delataría el check de la
// transacción. La fila que el código tiene en memoria es la del INSERT, sin marca, como en prod.
//
// Ctrl+C (o SIGTERM/SIGHUP) limpia antes de salir; una segunda señal sale sin esperar. Y al
// arrancar se barren las filas `PE.qaalta*` sin número de más de 15 minutos (una más nueva es de
// otra corrida EN CURSO). Límite: la limpieza por señal no espera a que el webhook termine lo que
// estaba procesando, así que una escritura tardía puede quedar; la barre la corrida siguiente.
//
// RESIDUO QUE QUEDA A PROPÓSITO: una fila por corrida en `borrados_auditoria`. El gasto del tercer
// mensaje se borra (explícito o por cascade, da igual), y el trigger de la migración 055 guarda
// cada DELETE de `transacciones`. Esa tabla es forense y no se purga desde un harness.
//
// La limpieza usa un cliente REST propio y no el de la barrera, por dos motivos: es el oráculo
// (no comparte cliente con el código bajo prueba), y la barrera rechaza a propósito el DELETE
// de `errores` por `like`, que acá está acotado al sufijo aleatorio de ESTA corrida. Como no tiene
// barrera, comprueba la forma de la fila antes de borrar nada.
//
// Fuera del canary: escribe en producción, quema OpenAI (el tercer mensaje es un gasto) y solo
// se rompe con un commit.
//
//   node qa-e2e/qa-bsuid-alta.mjs        exit 0 ok · 1 falló · 2 no se pudo correr
import crypto from 'node:crypto';
import { startWebhookHarness } from './webhook-harness.mjs';
import { esperarAltaPorBsuid, altasRegistradas, resumenGuard } from './lib/qa-guard.mjs';
import { problemasDeCopy } from './lib/copy-sin-numero.mjs';

const PREFIJO = 'PE.qaalta';
const sufijo = crypto.randomBytes(6).toString('hex');
const BSUID = PREFIJO + sufijo;
const HIJAS = ['transacciones', 'notificaciones', 'notification_deliveries', 'conversaciones', 'errores'];

const fallos = [];
function check(ok, etiqueta, detalle = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${etiqueta}${detalle ? '  (' + detalle + ')' : ''}`);
  if (!ok) fallos.push(etiqueta);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// El `import` de webhook-harness ya cargó `.env` (dotenv), así que estas variables existen acá.
// Cada request lleva timeout: sin él, una Supabase colgada deja la limpieza esperando para siempre
// y la única salida es matar el proceso, que es justo lo que deja filas vivas.
function db() {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('INCONCLUSO: faltan SUPABASE_URL/SUPABASE_KEY en app/.env');
    process.exit(2);
  }
  const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
  const h = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
  const pedir = (tabla, query, init = {}) =>
    fetch(base + tabla + '?' + query, { ...init, headers: { ...h, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  return {
    async select(tabla, query) {
      const r = await pedir(tabla, query);
      if (!r.ok) throw new Error(`select ${tabla}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json();
    },
    async del(tabla, query) {
      const r = await pedir(tabla, query, { method: 'DELETE' });
      if (!r.ok) throw new Error(`delete ${tabla}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    },
  };
}

// Borrar y COMPROBAR, paso por paso. Cada DELETE lleva su propio try: con uno solo, el primer
// statement roto dejaba sin correr lo que venía después (clase `limpieza-que-corta-al-primer-fallo`).
// Las hijas se borran explícitas en vez de confiar en el cascade de la migración 016: si una FK
// cambia, el harness tiene que enterarse, no ensuciar producción en silencio.
//
// Y ANTES de borrar nada, la fila tiene que tener la forma del alta. Este cliente no pasa por la
// barrera, así que un id equivocado acá se lleva a una persona real con todas sus hijas. Los ids
// vienen de dos fuentes (el BSUID y lo que contó la barrera), y la revisión adversarial mostró que
// la segunda podía contaminarse con un upsert. El DELETE de `usuarios` repite la forma en el WHERE
// por el mismo motivo.
async function borrarVerificado(sb, id, bsuid, etiqueta) {
  const etiq = `se borró la fila del alta y sus hijas (${etiqueta})`;
  const b = encodeURIComponent(bsuid);
  let propia;
  try {
    propia = (await sb.select('usuarios', `id=eq.${id}&select=bsuid,whatsapp,email,supabase_auth_id`))[0];
  } catch (e) {
    check(false, etiq, 'no se pudo leer la fila ' + id + ', así que no se borra nada: ' + e.message);
    return;
  }
  if (propia && (propia.bsuid !== bsuid || propia.whatsapp !== null || propia.email !== null || propia.supabase_auth_id !== null)) {
    check(false, etiq, 'la fila ' + id + ' NO tiene la forma del alta (bsuid=' + propia.bsuid + '): no se toca, revísala a mano');
    return;
  }
  const errores = [];
  const paso = async (fn, que) => { try { await fn(); } catch (e) { errores.push(que + ': ' + e.message); } };
  if (propia) {
    for (const t of HIJAS) await paso(() => sb.del(t, `usuario_id=eq.${id}`), t);
    await paso(() => sb.del('usuarios', `id=eq.${id}&bsuid=eq.${b}&whatsapp=is.null&email=is.null&supabase_auth_id=is.null`), 'usuarios');
  }
  await paso(() => sb.del('errores', `bsuid=eq.${b}`), 'errores por bsuid');
  const quedan = [];
  await paso(async () => {
    for (const t of HIJAS) if ((await sb.select(t, `usuario_id=eq.${id}&select=id`)).length) quedan.push(t);
    if ((await sb.select('errores', `bsuid=eq.${b}&select=id`)).length) quedan.push('errores(bsuid)');
    if ((await sb.select('usuarios', `or=(id.eq.${id},bsuid.eq."${b}")&select=id`)).length) quedan.push('usuarios');
  }, 'verificación');
  check(errores.length === 0 && quedan.length === 0, etiq,
    [...errores, ...(quedan.length ? ['QUEDÓ en ' + quedan.join(', ') + ' — usuario ' + id + ', bórralo a mano YA'] : [])].join(' | '));
}

// Una corrida que murió antes de limpiar deja su fila viva en producción (ya marcada, por la
// barrera). Se reconoce por construcción: prefijo de este harness, sin número y sin cuenta Google.
// Y solo si tiene más de 15 minutos: una corrida entera dura uno, así que una fila más nueva es de
// otra corrida EN CURSO, y borrársela la haría fallar por algo que no es el código.
async function barrerCorridasMuertas(sb) {
  const corte = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const viejas = await sb.select('usuarios',
    `bsuid=like.${PREFIJO}*&whatsapp=is.null&supabase_auth_id=is.null&created_at=lt.${corte}&select=id,bsuid,created_at`);
  if (viejas.length) console.log(`  AVISO: una corrida anterior dejó ${viejas.length} fila(s) viva(s). Se borran.`);
  for (const v of viejas) await borrarVerificado(sb, v.id, v.bsuid, 'corrida anterior ' + v.created_at);
}

// El payload que manda Meta cuando la persona oculta su número: `from_user_id` y ningún `from`,
// ni en el mensaje ni en `contacts` (que trae `user_id` y el perfil, sin `wa_id`).
let seq = 0;
function sobre(texto) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'qa', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '51933014505', phone_number_id: 'qa' },
      contacts: [{ user_id: BSUID, profile: { name: 'QA Alta BSUID', username: 'qa_alta' } }],
      messages: [{
        id: 'wamid.qa-alta-' + sufijo + '-' + (seq++),
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text', text: { body: texto },
        from_user_id: BSUID,
      }],
    } }] }],
  };
}

// El webhook contesta 200 y procesa después. Se espera la primera respuesta y luego a que el
// stub quede quieto, porque un mensaje puede producir más de un envío.
async function mandar(h, texto) {
  const desde = h.sent.length;
  const status = await h.post(sobre(texto));
  check(status === 200, `el webhook acepta "${texto}" sin \`from\``, 'HTTP ' + status);
  const t0 = Date.now();
  while (h.sent.length === desde && Date.now() - t0 < 60000) await sleep(300);
  let visto = h.sent.length;
  let quieto = Date.now();
  while (Date.now() - quieto < 2500 && Date.now() - t0 < 90000) {
    await sleep(250);
    if (h.sent.length !== visto) { visto = h.sent.length; quieto = Date.now(); }
  }
  const respuestas = h.sent.slice(desde);
  for (const r of respuestas) console.log('    → ' + JSON.stringify(String(r.msg).slice(0, 160)));
  return respuestas;
}

// A quién le llega de verdad un envío. `to` manda; sin `to`, `opts.bsuid` es la dirección de
// respaldo; y sin ninguno, `enviarWhatsapp` busca el BSUID de `opts.usuarioId` — que para la
// fila de esta corrida es BSUID, y para cualquier otra es alguien más.
function destino(s, idNuevo) {
  const o = s.opts || {};
  if (s.to) return String(s.to);
  if (o.bsuid) return String(o.bsuid);
  if (o.usuarioId && o.usuarioId === idNuevo) return BSUID;
  return o.usuarioId ? 'usuario ' + o.usuarioId : '(sin destino)';
}

function revisarRespuestas(respuestas, etiqueta, idNuevo) {
  check(respuestas.length >= 1, `${etiqueta}: hubo respuesta`, respuestas.length + ' envío(s)');
  const ajenos = respuestas.map((s) => destino(s, idNuevo)).filter((d) => d !== BSUID);
  check(respuestas.length > 0 && ajenos.length === 0, `${etiqueta}: toda respuesta va al BSUID y a nadie más`,
    ajenos.length ? 'otros destinos: ' + ajenos.join(', ') : '');
  const problemas = respuestas.flatMap((s) => problemasDeCopy(s.msg, { bsuid: BSUID, sufijo }));
  check(problemas.length === 0, `${etiqueta}: el copy no pide ni muestra un número`, problemas.join('; '));
}

const sb = db();
if (process.env.POSTHOG_KEY) {
  // `altaPorBsuid` emite `wa_user_registered`: con la key cargada, cada corrida fabricaría un
  // alta falsa en el embudo de PostHog, y ese evento no se puede borrar después.
  console.error('INCONCLUSO: POSTHOG_KEY está cargada; el alta mandaría un evento real a PostHog. Corre sin ella.');
  process.exit(2);
}

console.log('Barriendo filas de corridas muertas...');
try {
  await barrerCorridasMuertas(sb);
} catch (e) {
  console.error('INCONCLUSO: no se pudo barrer las filas de corridas anteriores: ' + e.message);
  process.exit(2);
}

esperarAltaPorBsuid(BSUID);
const h = await startWebhookHarness();
let idNuevo = null;
const filasDelBsuid = () => sb.select('usuarios',
  `bsuid=eq.${encodeURIComponent(BSUID)}&select=id,whatsapp,bsuid,nombre,is_test_user,onboarding_paso,onboarding_completado`);

// Limpieza única: la llaman el `finally` y las señales, lo que pase primero.
let limpieza = null;
function limpiar() {
  if (limpieza) return limpieza;
  limpieza = (async () => {
    await h.close();
    console.log('\nLimpiando...');
    // Por BSUID y por lo que contó la barrera: si el alta se hubiera escrito con otro BSUID, el
    // id igual está en `altasRegistradas`. `borrarVerificado` no toca una fila sin la forma del alta.
    const ids = new Set((altasRegistradas(BSUID)?.ids) || []);
    try { for (const f of await filasDelBsuid()) ids.add(f.id); } catch (e) { check(false, 'se pudo buscar la fila para borrarla', e.message); }
    for (const id of ids) await borrarVerificado(sb, id, BSUID, 'esta corrida');
    // Lo que un código viejo deja sin dueño: la fila "sin from" del webhook guarda el BSUID solo
    // en `detalle`. El `like` va por el sufijo aleatorio de ESTA corrida, no alcanza a nadie más.
    try {
      const sucias = await sb.select('errores', `detalle=like.*${sufijo}*&select=id`);
      if (sucias.length) await sb.del('errores', `detalle=like.*${sufijo}*`);
      const restan = await sb.select('errores', `detalle=like.*${sufijo}*&select=id`);
      check(restan.length === 0, 'no quedan filas de `errores` del sufijo', `borradas ${sucias.length}, quedan ${restan.length}`);
    } catch (e) {
      check(false, 'no quedan filas de `errores` del sufijo', e.message);
    }
  })();
  return limpieza;
}
// SIGHUP es lo que llega en Windows al cerrar la ventana de la terminal. La segunda señal sale sin
// esperar: si la limpieza se colgó, que Ctrl+C otra vez no obligue a matar el proceso a mano.
for (const [senal, codigo] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(senal, () => {
    if (limpieza) { console.log(`\n${senal} otra vez: salgo sin terminar de limpiar.`); process.exit(codigo); }
    console.log(`\n${senal}: limpiando antes de salir... (otra vez para salir ya)`);
    limpiar().finally(() => process.exit(codigo));
  });
}

const inicio = h.sent.length;
try {
  console.log(`\n1. primer mensaje, solo con from_user_id = ${BSUID} (desconocido)`);
  const r1 = await mandar(h, 'hola');
  const f1 = await filasDelBsuid();
  check(f1.length === 1, 'se creó UNA fila con ese BSUID', f1.length + ' filas');
  if (f1.length === 1) {
    idNuevo = f1[0].id;
    check(f1[0].whatsapp === null, 'la fila nace SIN número', 'whatsapp=' + f1[0].whatsapp);
    check(f1[0].onboarding_paso === 100, 'el alta quedó esperando el nombre', 'onboarding_paso=' + f1[0].onboarding_paso);
    check(f1[0].is_test_user === true, 'la barrera la marcó como de prueba al nacer', 'is_test_user=' + f1[0].is_test_user);
  }
  const altas1 = altasRegistradas(BSUID);
  check(altas1.ids.length === 1 && altas1.ids[0] === String(idNuevo).toLowerCase(),
    'esa fila la insertó el código de esta corrida, una sola vez', JSON.stringify({ intentos: altas1.intentos, ids: altas1.ids }));
  const cuerpo = altas1.cuerpos[0] || {};
  check(altas1.cuerpos.length === 1 && Object.keys(cuerpo).sort().join() === 'bsuid,whatsapp' &&
    cuerpo.bsuid === BSUID && cuerpo.whatsapp === null,
  'el código la insertó como en producción: { whatsapp: null, bsuid } y sin la marca', JSON.stringify(altas1.cuerpos));
  revisarRespuestas(r1, 'mensaje 1', idNuevo);

  console.log('\n2. segundo mensaje: el nombre');
  const r2 = await mandar(h, 'Ana');
  const f2 = await filasDelBsuid();
  check(f2.length === 1 && f2[0].id === idNuevo, 'no se duplicó la persona', f2.length + ' filas');
  check(altasRegistradas(BSUID).ids.length === 1, 'el código no insertó otra fila', JSON.stringify(altasRegistradas(BSUID).ids));
  if (f2.length === 1) {
    check(f2[0].nombre === 'Ana' && f2[0].onboarding_completado === true, 'el alta se cerró con el nombre',
      `nombre=${f2[0].nombre} completado=${f2[0].onboarding_completado}`);
  }
  revisarRespuestas(r2, 'mensaje 2', idNuevo);

  console.log('\n3. tercer mensaje: el primer gasto');
  const r3 = await mandar(h, 'gasté 12.50 en taxi');
  const f3 = await filasDelBsuid();
  check(f3.length === 1 && f3[0].id === idNuevo && f3[0].whatsapp === null, 'sigue siendo UNA fila, sin número', f3.length + ' filas');
  check(altasRegistradas(BSUID).ids.length === 1, 'el código no insertó otra fila', JSON.stringify(altasRegistradas(BSUID).ids));
  const txs = idNuevo ? await sb.select('transacciones', `usuario_id=eq.${idNuevo}&select=monto,tipo`) : [];
  check(txs.length === 1 && Number(txs[0].monto) === 12.5 && txs[0].tipo === 'gasto', 'se registró el gasto con su monto',
    JSON.stringify(txs));
  revisarRespuestas(r3, 'mensaje 3', idNuevo);

  // Lo que llegó DESPUÉS de la ventana de silencio de cada mensaje no lo revisó nadie arriba.
  await sleep(3000);
  const todos = h.sent.slice(inicio);
  const ajenos = todos.map((s) => destino(s, idNuevo)).filter((d) => d !== BSUID);
  check(ajenos.length === 0, 'en toda la corrida nada salió hacia otro destino',
    ajenos.length ? ajenos.join(', ') : todos.length + ' envíos');

  // Un camino sano no deja rastro en `errores`. Esto mira por las tres puertas por las que una
  // fila de este flujo puede quedar: el usuario, el BSUID (antes de tener usuario) y el sufijo.
  const errs = await sb.select('errores',
    `or=(bsuid.eq."${encodeURIComponent(BSUID)}"${idNuevo ? `,usuario_id.eq.${idNuevo}` : ''},detalle.like.*${sufijo}*)&select=tag,mensaje`);
  check(errs.length === 0, 'el camino no dejó filas en `errores`', errs.map((e) => e.tag + ': ' + e.mensaje).join(' | '));
  if (h.telegrams.length) console.log('  (Telegrams capturados: ' + h.telegrams.length + ')\n    ' + h.telegrams.join('\n    ').slice(0, 600));
} finally {
  await limpiar();
}

console.log('\n' + resumenGuard());
console.log(fallos.length === 0 ? '\nOK: el alta por BSUID crea una persona, le contesta a su BSUID y no le pide número' : '\nFALLOS: ' + fallos.join(' | '));
process.exit(fallos.length === 0 ? 0 : 1);
