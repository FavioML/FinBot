// Cliente mínimo de la API GraphQL de Railway, compartido.
//
// Existe porque hay DOS consumidores y la lección de esta semana fue justamente que una
// lógica escrita dos veces se desincroniza sin romperse:
//   - `scripts/verify-railway-gate.mjs` — ¿el toggle "Wait for CI" sigue prendido?
//   - `qa-e2e/backend-deploy-gated.mjs` — ¿el deploy que corre en prod esperó a su suite?
//
// Los tres IDs NO son secretos (son identificadores, como los VERCEL_*_ID que viven como
// repo variables) y van acá a propósito: el punto es que la config del deploy se lea desde
// el repo y no del dashboard.

export const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || 'e2aac0f3-c2ee-4347-892c-b36d8c76929e'; // peaceful-stillness
export const SERVICE_ID = process.env.RAILWAY_SERVICE_ID || '1085b433-8f29-4487-9ce7-3a66b64ef244'; // Neto.pe
export const ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID || '1600a753-bc8c-492c-aca7-27fdac946747'; // production

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

/**
 * Railway acepta dos formas de token y no se distinguen por el prefijo: los de cuenta/equipo
 * van como Bearer, los de proyecto en su propio header. Se prueban los dos en vez de pedirle
 * a quien configure el secret que sepa cuál tiene.
 *
 * Devuelve `{ auth, data }` si alguna funcionó, o `{ errores }` con el detalle de cada
 * intento. NUNCA tira: cada consumidor decide si un fallo es exit 1 (fallar cerrado) o
 * exit 2 (infra), y esa decisión no es la misma para los dos.
 *
 * `campoEsperado` es la clave de `data` que tiene que venir para considerar la respuesta
 * buena. Sin eso, una respuesta 200 con `{"data":{"deployments":null},"errors":[...]}`
 * pasaría como éxito y el consumidor leería `undefined` como "no hay nada", que es el
 * falso verde de siempre.
 */
export async function consultarRailway({ token, query, variables, campoEsperado }) {
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
        body: JSON.stringify({ query, variables }),
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

    if (body?.data?.[campoEsperado]) return { auth: nombre, data: body.data[campoEsperado] };
    errores.push(`${nombre}: ${body?.errors?.[0]?.message || `HTTP ${res.status}`}`);
  }

  return { errores };
}
