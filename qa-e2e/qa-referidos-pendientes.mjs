// ¿Hay algún premio de referido DEBIDO y no pagado? — READ-ONLY, cero escrituras.
//
// Por qué existe. La migración 062 separó "el referido pagó" (`convertido_pro`) de
// "al referrer se le acreditó su mes" (`premio_otorgado_at`), y `services/referrals.js`
// avisa al admin cuando queda en el medio. Pero ese aviso es **best-effort**:
// `notificarAdmin` intenta Telegram y cae a WhatsApp, traga su propia excepción y
// devuelve `undefined` tanto si entregó como si no. O sea que el único detector de
// un mes de Pro perdido era un mensaje que se puede perder, y encima justo el día
// en que algo anda mal (que es cuando Telegram también puede estar caído).
//
// Esto lo convierte en una pregunta que se hace sola todos los días. No reemplaza
// al aviso: el aviso llega en el momento y con el SQL para arreglarlo; esto es la
// red por si el aviso no llegó.
//
// ── Lo que afirma, y por qué son DOS cosas ────────────────────────────────────
//   1. La columna `premio_otorgado_at` EXISTE en prod. Este check no es paranoia:
//      hoy `referidos` está VACÍA, así que el check 2 estaría verde por vacuidad
//      para siempre — verde porque no hay filas, no porque no haya premios
//      perdidos. Si la 062 no estuviera aplicada, PostgREST responde 400 "column
//      does not exist" y eso es lo que se caza acá. La ausencia del error es la
//      prueba de que el check 2 está mirando algo real.
//   2. Cero filas con `convertido_pro = true AND premio_otorgado_at IS NULL`.
//      Usa el índice parcial `idx_referidos_premio_pendiente` de la 062.
//
// Cuando falla el 2, cada fila es plata: un referrer que ganó un mes de Pro y no
// lo tiene. Se arregla a mano con el SQL que imprime el propio JSON.
//
// Exit 0 = no hay premios pendientes. Exit 1 = los hay (o la columna no existe:
// el detector estaría ciego). Exit 2 = infra (falta la service-role key, red).
//
// Usage: node qa-referidos-pendientes.mjs
//
// Nota: `process.exitCode`, no `process.exit()`. En Windows, salir de golpe con el
// socket keep-alive de fetch aún abierto dispara una assertion de libuv y devuelve
// 127 en vez del código real.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* archivo ausente → {} y el caller decide */ }
  return env;
}

const fileEnv = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const pick = (k) => process.env[k] ?? fileEnv[k];

/** Igual que el resto de los harness: entorno, y si no, webapp/.env.local. */
function serviceKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const localPath = new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  return loadEnv(localPath).SUPABASE_SERVICE_ROLE_KEY;
}

// Se deja parametrizable SOLO para poder probar que este harness tiene dientes
// contra una columna que no existe. En la corrida normal es el nombre real.
const COL = process.env.NETO_COL_PREMIO || 'premio_otorgado_at';

function done(code, payload) {
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = code;
  return code;
}

async function main() {
  const SERVICE = serviceKey();
  const SUPA = pick('NETO_QA_URL');
  if (!SERVICE || !SUPA) {
    return done(2, {
      verdict: 'falta la service-role key o NETO_QA_URL',
      hint: 'SUPABASE_SERVICE_ROLE_KEY en el entorno o en webapp/.env.local; NETO_QA_URL en ~/.config/neto/qa.env',
    });
  }
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

  // 1) Antivacuidad: la columna existe. Sin esto, el check 2 sobre una tabla vacía
  //    está verde pase lo que pase, incluso si la 062 se revirtió.
  try {
    const r = await fetch(`${SUPA}/rest/v1/referidos?select=${COL}&limit=1`, { headers });
    if (!r.ok) {
      const detalle = await r.text().catch(() => '');
      return done(1, {
        verdict: `la columna referidos.${COL} NO responde: el detector de premios perdidos está CIEGO`,
        status: r.status,
        detalle: detalle.slice(0, 300),
        hint: '¿Se aplicó migrations/062_referidos_premio_otorgado_at.sql en prod?',
      });
    }
  } catch (e) {
    return done(2, { verdict: 'no se pudo consultar Supabase', error: String(e).split('\n')[0] });
  }

  // 2) La pregunta.
  let pendientes;
  let total = null;
  try {
    const q = `${SUPA}/rest/v1/referidos?select=id,referrer_id,referido_id,convertido_pro_at`
      + `&convertido_pro=is.true&${COL}=is.null`;
    const r = await fetch(q, { headers });
    if (!r.ok) {
      return done(2, { verdict: 'la consulta de pendientes falló', status: r.status, detalle: (await r.text()).slice(0, 300) });
    }
    pendientes = await r.json();
    // Contexto para el humano que lea el reporte: 0 pendientes sobre 0 filas no
    // significa lo mismo que 0 sobre 40.
    const rc = await fetch(`${SUPA}/rest/v1/referidos?select=id&limit=1`, {
      headers: { ...headers, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = rc.headers.get('content-range');
    total = cr ? Number(cr.split('/')[1]) : null;
  } catch (e) {
    return done(2, { verdict: 'no se pudo consultar Supabase', error: String(e).split('\n')[0] });
  }

  if (pendientes.length === 0) {
    return done(0, { verdict: 'PASS', pendientes: 0, filasEnReferidos: total });
  }

  return done(1, {
    verdict: 'PREMIOS DE REFERIDO DEBIDOS Y NO OTORGADOS',
    pendientes: pendientes.length,
    filasEnReferidos: total,
    filas: pendientes,
    hint: 'Cada fila es un referrer que ganó un mes de Pro y no lo tiene. El aviso al admin '
      + 'salió cuando ocurrió (con el SQL), pero es best-effort: si Telegram falló, esto es lo único que queda.',
    sql: pendientes.map((p) => (
      "update usuarios set plan='premium', "
      + "premium_vence = (greatest(coalesce(premium_vence, current_date), current_date) + interval '1 month')::date, "
      + 'referidos_meses_otorgados = coalesce(referidos_meses_otorgados,0)+1'
      + ` where id = '${p.referrer_id}';`
      + ` update referidos set premio_otorgado_at=now() where referido_id = '${p.referido_id}';`
    )),
  });
}

await main();
