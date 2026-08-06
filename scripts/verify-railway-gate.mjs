// ¿El deploy del backend en Railway sigue gateado por CI?
//
// CONTEXTO. Vercel dejó de desplegar `main` por su cuenta (webapp/vercel.json +
// el job `deploy-webapp`), pero Railway seguía sin gate: la integración de Git
// desplegaba a los pocos segundos del push, sin mirar si la suite estaba verde.
// El arreglo es el toggle **Wait for CI** de Railway (Settings → Deploy del
// servicio). Con él, un push pone el deployment en WAITING mientras corren los
// workflows y lo SKIPea si alguno falla.
//
// EL PROBLEMA QUE RESUELVE ESTE ARCHIVO. Ese toggle vive en el dashboard, o sea
// que es invisible desde el repo: nadie se entera si alguien lo apaga, y el
// síntoma —Railway volviendo a desplegar sin esperar— es justo el estado que
// creíamos haber arreglado. Esto lo hace visible y ruidoso: la API de Railway SÍ
// expone el flag (`DeploymentTrigger.checkSuites`), aunque no esté en el MCP,
// que mira `ServiceInstance` y ahí no está.
//
// LO QUE ESTO NO ES. No es el gate; es el testigo. Si el toggle está apagado,
// Railway ya desplegó para cuando este script corre — no hay nada que frenar. Su
// trabajo es que ese estado no pase inadvertido, no impedirlo.
//
// FALLA CERRADO, A PROPÓSITO. Cualquier error —API caída, token vencido, secret
// ausente— es exit 1. Corriendo dentro del check suite que Railway espera, eso
// significa que un blip de Railway puede SKIPear un deploy sano, y hay que
// recuperarlo a mano (Redeploy en Railway, o volver a pushear). Se eligió así
// porque el fallo es RUIDOSO: la suite queda roja en el commit. El argumento que
// descartó fallar cerrado en el "Ignored Build Step" de Vercel (ver ci.yml) era
// que ahí el skip era SILENCIOSO; acá no lo es, así que no aplica.
//
// Usage: node scripts/verify-railway-gate.mjs   (desde app/)
// Requiere: RAILWAY_API_TOKEN (token de cuenta/equipo o de proyecto).
//   Local:  export RAILWAY_API_TOKEN=$(...)  o  ~/.config/neto/railway.env
//   CI:     secrets.RAILWAY_API_TOKEN
//
// Los tres IDs NO son secretos (son identificadores, como los VERCEL_*_ID que
// viven como repo variables) y van hardcodeados a propósito: el punto del
// archivo es que la config del deploy se lea desde el repo.

const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || 'e2aac0f3-c2ee-4347-892c-b36d8c76929e'; // peaceful-stillness
const SERVICE_ID = process.env.RAILWAY_SERVICE_ID || '1085b433-8f29-4487-9ce7-3a66b64ef244'; // Neto.pe
const ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID || '1600a753-bc8c-492c-aca7-27fdac946747'; // production
const EXPECTED_REPO = process.env.NETO_REPO || 'FavioML/FinBot';
const EXPECTED_BRANCH = 'main';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

const QUERY = `query($p:String!,$s:String!,$e:String!){
  deploymentTriggers(projectId:$p, serviceId:$s, environmentId:$e){
    edges { node { id provider repository branch checkSuites validCheckSuites } }
  }
}`;

function fail(motivo, extra = {}) {
  console.error(`FAIL: ${motivo}`);
  if (Object.keys(extra).length) console.error(JSON.stringify(extra, null, 2));
  process.exitCode = 1;
  return false;
}

// Railway acepta dos formas de token y no se distinguen por el prefijo: los de
// cuenta/equipo van como Bearer, los de proyecto en su propio header. Se prueban
// los dos en vez de pedirle a quien configure el secret que sepa cuál tiene.
async function consultar(token) {
  const intentos = [
    ['Bearer', { Authorization: `Bearer ${token}` }],
    ['Project-Access-Token', { 'Project-Access-Token': token }],
  ];
  const errores = [];
  for (const [nombre, headers] of intentos) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: QUERY,
          variables: { p: PROJECT_ID, s: SERVICE_ID, e: ENVIRONMENT_ID },
        }),
      });
    } catch (e) {
      errores.push(`${nombre}: red — ${String(e).split('\n')[0]}`);
      continue;
    }
    let body;
    try {
      body = await res.json();
    } catch {
      errores.push(`${nombre}: HTTP ${res.status}, respuesta no-JSON`);
      continue;
    }
    if (body?.data?.deploymentTriggers) return { auth: nombre, data: body.data.deploymentTriggers };
    errores.push(`${nombre}: ${body?.errors?.[0]?.message || `HTTP ${res.status}`}`);
  }
  return { errores };
}

async function main() {
  const token = process.env.RAILWAY_API_TOKEN;
  // Sin token NO se saltea: un guard que se vuelve no-op cuando falta un secret
  // es verde por vacuidad, que es indistinguible de un guard que pasa.
  if (!token) {
    return fail('falta RAILWAY_API_TOKEN', {
      hint: 'CI: gh secret set RAILWAY_API_TOKEN. Local: token de https://railway.com/account/tokens',
    });
  }

  const { auth, data, errores } = await consultar(token);
  if (!data) {
    return fail('no se pudo leer deploymentTriggers de la API de Railway', {
      intentos: errores,
      hint: '¿Token vencido o sin alcance sobre el proyecto peaceful-stillness?',
    });
  }

  const triggers = (data.edges || []).map((e) => e.node);

  // Cero triggers = el repo está desconectado del servicio. No es "no hay nada
  // que gatear": es que Railway dejó de desplegar y el backend se va quedando
  // viejo en silencio (backend-deploy-fresh.mjs lo vería recién horas después).
  if (triggers.length === 0) {
    return fail('el servicio no tiene ningún trigger de GitHub: Railway no está auto-desplegando', {
      projectId: PROJECT_ID, serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID,
    });
  }

  // Más de uno = hay un camino al deploy que este guard no está mirando. El
  // toggle es POR trigger, así que un segundo trigger sin `checkSuites` es un
  // agujero completo aunque el primero esté perfecto.
  if (triggers.length > 1) {
    return fail(`hay ${triggers.length} triggers de deploy; se esperaba 1`, { triggers });
  }

  const t = triggers[0];
  const problemas = [];
  if (t.repository !== EXPECTED_REPO) problemas.push(`repo=${t.repository} (se esperaba ${EXPECTED_REPO})`);
  if (t.branch !== EXPECTED_BRANCH) problemas.push(`branch=${t.branch} (se esperaba ${EXPECTED_BRANCH})`);
  // ESTE es el invariante. Todo lo demás es contexto para no dar un falso verde
  // sobre un trigger que resultó ser de otro repo o de otra rama.
  if (t.checkSuites !== true) problemas.push('checkSuites=false → "Wait for CI" está APAGADO: Railway despliega sin esperar la suite');

  // Y este es el otro estado que hay que descartar, porque es PEOR que el toggle
  // apagado: prendido pero ciego. La propia UI de Railway avisa que el feature
  // exige aceptar unos permisos actualizados de su app de GitHub (lectura de
  // Checks). Sin eso el switch queda en ON y no gatea nada, o sea que un guard
  // que solo mire `checkSuites` daría PASS sobre un gate sin dientes.
  // `validCheckSuites` es Int (no Boolean, pese al nombre) y es el conteo de
  // check suites que Railway ve. Valía 1 el 05-ago-2026, con el gate funcionando.
  if (!(t.validCheckSuites >= 1)) {
    problemas.push(`validCheckSuites=${t.validCheckSuites} → Railway no ve ningún check suite: el toggle está prendido pero no gatea`);
  }

  if (problemas.length) {
    return fail('la config del deploy de Railway derivó', {
      problemas,
      trigger: t,
      arreglo: 'Railway → servicio Neto.pe → Settings → Source → "Wait for CI" ON + aceptar los permisos de GitHub que enlaza ahí debajo',
    });
  }

  console.log(JSON.stringify({
    verdict: 'PASS',
    auth,
    repo: t.repository,
    branch: t.branch,
    waitForCI: t.checkSuites,
    validCheckSuites: t.validCheckSuites,
  }, null, 2));
  return true;
}

await main();
