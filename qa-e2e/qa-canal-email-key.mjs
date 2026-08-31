// ¿La credencial del canal de correo que corre EN PRODUCCIÓN sigue sirviendo para enviar?
//
// ── Por qué existe, y por qué no alcanzaba el que ya había ────────────────────────────────────
//
// El 28-ago-2026 la `RESEND_API_KEY` entró a Railway con un carácter de más. Dominio verificado,
// DNS puesto, webhook entregando, y el canal muerto 22 horas: el cron de las 9am dejó 5 correos
// en `estado='error'` y esos 5 avisos se perdieron. `qa-canal-email-sano.mjs` nació de ahí y
// mira las filas de `notification_deliveries` de las últimas 26h, o sea que **sólo puede
// detectar la key rota cuando por casualidad hubo tráfico**.
//
// El 31-ago ese supuesto se cayó. El correo de deudas —que era el único emisor con cadencia
// diaria— pasó a un resumen SEMANAL, y medido sobre 30 días el canal entero tiene **10 filas,
// todas de `tipo='deuda'`, en 2 días**. O sea que el hermano va a decir "SIN TRAFICO" casi todos
// los días y la ventana de detección de una credencial rota pasa de ~1 día a ~7.
//
// Éste no depende del tráfico: le pregunta a Resend directamente.
//
// ── Las DOS decisiones que hacen que esto sirva, y la segunda se pagó ─────────────────────────
//
// **1. La key se lee de RAILWAY, no del `.env` local.** Es la diferencia entre un guard y un
// guard que no ve: el incidente fue una key mal copiada **en Railway**, con la local sana. Un
// canary que validara la de este disco habría dado verde durante las 22 horas del incidente que
// vino a atrapar — el modo de falla nº14 de `feedback_guards_que_no_ven` (*el ENTORNO donde mido
// no es el que quiero medir*). Hoy ni siquiera hay `RESEND_API_KEY` en el `.env` de este disco.
//
// **2. La sonda ejercita la capacidad de ENVIAR, que es la única que la credencial tiene.**
// La primera versión hacía `GET /domains` —parecía lo prolijo: read-only, no manda nada— y salió
// **exit 1 con el canal perfectamente sano**. Resend lo dijo textual:
// `{"statusCode":401,"name":"restricted_api_key","message":"This API key is restricted to only
// send emails"}`. La key de producción es *sending-only*, que es la configuración **más segura**,
// y no puede leer dominios. O sea que la sonda medía un permiso que la credencial no necesita
// tener, y su rojo no decía nada sobre lo que se quería saber.
//
// La sonda correcta es `POST /emails` con un body **deliberadamente inválido**: Resend valida
// primero la credencial y después el payload, así que
//   · `422 missing_required_field`  → la key sirve para enviar. Es el verde.
//   · `401`                          → la key está rechazada. Es el incidente del 28-ago.
// y no manda nada, porque sin `to` ni `from` no hay correo que armar. Medido contra la API antes
// de escribirlo, no deducido.
//
// ── Lo que NO cubre, dicho para que nadie lo suponga ──────────────────────────────────────────
//
// **La verificación del DOMINIO queda afuera.** Es el otro fallo que el `on_fail` del hermano
// nombra (`403 domain is not verified`) y con una key sending-only no se puede consultar: haría
// falta una de full access en el canary, o sea una credencial MÁS poderosa viviendo en una
// laptop para vigilar algo que cambia casi nunca y que además el propio envío reporta. El
// intercambio no vale; queda anotado acá en vez de fingir que está cubierto.
//
// No manda ningún correo. No toca la base — es el único harness de `qa-e2e/` que no abre
// Supabase, así que la barrera de `qa-guard` no le aplica. No imprime la key: sólo su longitud y
// el prefijo `re_`, que es lo que hace falta para el triage.
//
// Correr:  node qa-e2e/qa-canal-email-key.mjs   (desde app/)
//   exit 0 = la credencial de producción sirve para enviar
//   exit 1 = el canal de correo está roto AHORA (el próximo envío sale en estado='error')
//   exit 2 = no se pudo determinar (falta el token, red, Resend caído). NO es un PASS.

import 'dotenv/config';

// Los tres ids del servicio del backend en Railway. Son los mismos que documenta el CLAUDE.md
// en su bloque de diagnóstico de deployments; se dejan acá como constantes porque son identidad
// de infraestructura, no configuración: si cambian, es que el servicio se recreó y este harness
// tiene que enterarse en vez de seguir consultando al que ya no existe.
const PROJECT_ID = 'e2aac0f3-c2ee-4347-892c-b36d8c76929e';
const ENVIRONMENT_ID = '1600a753-bc8c-492c-aca7-27fdac946747';
const SERVICE_ID = '1085b433-8f29-4487-9ce7-3a66b64ef244';

const TIMEOUT_MS = 15000;

/**
 * Override SÓLO para ejercitar la rama roja, y construido para que no pueda comprar un verde.
 *
 * Una rama de fallo que nunca se ejecutó es una rama que no se sabe si funciona, y la que
 * importa acá (401) no se puede provocar sin romper producción. Con esta variable se le pasa una
 * key cualquiera y se comprueba que el harness la rechaza.
 *
 * **Cuando está puesta, el éxito sale exit 2 y nunca 0.** Sin esa regla, alguien que la dejara
 * seteada con una key válida obtendría un PASS que no dice nada sobre Railway — que es
 * exactamente el agujero que este archivo existe para no tener.
 */
const KEY_OVERRIDE = process.env.NETO_EMAIL_KEY_OVERRIDE || null;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

class Inconcluso extends Error {}
const inconcluso = (motivo) => { throw new Inconcluso(motivo); };

async function pedir(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/** Las variables de entorno que el servicio del backend tiene HOY en Railway. */
async function variablesDeRailway(token) {
  const query = 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}';
  let res;
  try {
    res = await pedir('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { p: PROJECT_ID, e: ENVIRONMENT_ID, s: SERVICE_ID } }),
    });
  } catch (e) { inconcluso('no se pudo hablar con la API de Railway: ' + e.message); }
  if (!res.ok) inconcluso('Railway respondió HTTP ' + res.status + ' al pedir las variables del servicio');
  const cuerpo = await res.json().catch(() => null);
  // Un token vencido devuelve 200 con `errors`, no un status de error: sin mirar esto, el `?.`
  // de abajo dejaría `vars` en undefined y saldría como "la key no está en Railway", que es un
  // veredicto ROJO por una causa que es de infraestructura.
  if (!cuerpo || cuerpo.errors) {
    inconcluso('la API de Railway devolvió errores (¿RAILWAY_API_TOKEN vencido?): '
      + JSON.stringify(cuerpo?.errors || 'sin cuerpo').slice(0, 200));
  }
  const vars = cuerpo?.data?.variables;
  if (!vars || typeof vars !== 'object') inconcluso('la respuesta de Railway no trae el mapa de variables');
  return vars;
}

async function main() {
  const token = process.env.RAILWAY_API_TOKEN;
  // Sin token no hay nada que preguntar. Es exit 2 y NO exit 0: un guard que se vuelve no-op
  // cuando le falta una credencial es verde por vacuidad, que es peor que no tenerlo.
  if (!token) inconcluso('falta RAILWAY_API_TOKEN (vive en el .env de app/ y en el secret de CI)');

  const vars = await variablesDeRailway(token);

  const keyReal = vars.RESEND_API_KEY;
  // La ausencia SÍ es un veredicto rojo, no un inconcluso: sin la variable, `enviarEmail` hace
  // no-op y deja `skipped_sin_proveedor`. El canal está apagado en producción, con rastro pero
  // sin que nadie lo mire.
  check('la RESEND_API_KEY existe en el servicio de Railway', !!keyReal,
    keyReal ? 'len=' + keyReal.length : 'AUSENTE: el canal de correo está apagado en producción');
  if (!keyReal) return;

  const key = KEY_OVERRIDE || keyReal;
  if (KEY_OVERRIDE) {
    console.log('OVERRIDE ACTIVO (NETO_EMAIL_KEY_OVERRIDE): se está validando una key de prueba, '
      + 'NO la de Railway. El veredicto bueno sale exit 2 a propósito.');
  }

  // Forma antes que función: si la key no empieza con `re_`, el 401 de abajo llegaría igual, pero
  // el triage sería "Resend la rechazó" en vez de "acá hay pegado algo que no es una key".
  check('tiene forma de key de Resend (re_…)', key.startsWith('re_'),
    'prefijo=' + key.slice(0, 3) + ' len=' + key.length);

  // La sonda. Body vacío a propósito: sin `to` ni `from` no hay correo que armar, así que esto
  // no puede enviar nada ni gastar cuota. Ver el bloque 2 del encabezado para por qué NO es un
  // `GET /domains`.
  let res;
  try {
    res = await pedir('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (e) { inconcluso('no se pudo hablar con la API de Resend: ' + e.message); }

  const cuerpo = await res.json().catch(() => null);
  const nombre = cuerpo?.name || '(sin name)';

  // 422 = pasó la credencial y se plantó en el payload, que es exactamente lo que se buscaba.
  if (res.status === 422) {
    check('Resend acepta la credencial de producción para ENVIAR', true, 'HTTP 422 ' + nombre);
    return;
  }
  // 401/403 es el veredicto que este harness existe para dar. Se imprime el `name` de Resend
  // porque separa las dos causas y piden cosas distintas: `invalid_api_key` es el incidente del
  // 28-ago (mal copiada o rotada sin actualizar Railway); `restricted_api_key` sobre ESTE
  // endpoint significaría que la key perdió el permiso de enviar, o sea que alguien la degradó.
  if (res.status === 401 || res.status === 403) {
    check('Resend acepta la credencial de producción para ENVIAR', false,
      'HTTP ' + res.status + ' ' + nombre + ' — la key que corre en Railway no puede enviar. '
      + 'Revisá que no se haya copiado con un carácter de más ni rotado sin actualizar Railway.');
    return;
  }
  // Cualquier otro status es de Resend y no nuestro: no puede leerse como "la credencial está
  // rota". Un 200 acá sería peor todavía —significaría que un body vacío armó un correo— y cae
  // en la misma rama a propósito: es un supuesto roto, no un veredicto.
  inconcluso('Resend respondió HTTP ' + res.status + ' ' + nombre + ' a un body vacío; se esperaba '
    + '422 (key sana) o 401 (key rechazada). Cambió la API: revisá la sonda antes de creerle a este harness.');
}

(async () => {
  let fatal = null;
  let infra = null;
  try { await main(); } catch (e) {
    if (e instanceof Inconcluso) { infra = e; console.log('INCONCLUSO — ' + e.message); }
    else { fatal = e; console.log('FAIL excepción — ' + e.message); }
  }

  const fallidos = results.filter((r) => !r.pass);
  console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
  if (fatal) console.log(fatal.stack);

  // Mismo orden que los demás harness: un check rojo gana sobre el inconcluso, porque lo ya
  // medido es un veredicto y no se degrada a "no pude opinar".
  //
  // `process.exitCode` y NO `process.exit()`: en Windows, salir con sockets keep-alive de fetch
  // abiertos devuelve 127 y el canary lo lee como fallo desconocido.
  if (fallidos.length || fatal) {
    console.log('==> CANAL DE CORREO ROTO (exit 1)');
    process.exitCode = 1;
  } else if (infra) {
    console.log('==> INCONCLUSO (exit 2) — ' + infra.message);
    process.exitCode = 2;
  } else if (KEY_OVERRIDE) {
    // El verde con override no puede salir 0: no dice nada sobre la credencial de Railway.
    console.log('==> OK, PERO CON OVERRIDE (exit 2): esto validó una key de prueba, no la de producción.');
    process.exitCode = 2;
  } else {
    console.log('==> OK');
    process.exitCode = 0;
  }
})();
