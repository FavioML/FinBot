#!/usr/bin/env node
/**
 * ¿La resolución de invitaciones devuelve LO MISMO después de colapsarla a una consulta?
 *
 * Contexto: hasta el 22-ago-2026 cada vista pública de invitación hacía tres lecturas
 * encadenadas a Supabase (la fila, su padre, el nombre del creador o el conteo). Ahora hace
 * una sola con embeds de PostgREST (`webapp/src/lib/invitaciones.ts`). El resultado tiene que
 * ser idéntico campo por campo; la latencia no.
 *
 * POR QUÉ COMPARA CONTRA PRODUCCIÓN Y NO CONTRA UNA COPIA DE LA CONSULTA VIEJA
 *
 * Reescribir la consulta vieja acá dentro compararía el código nuevo contra MI versión del
 * viejo, no contra el que está sirviendo. Un guard que se mide contra su propia declaración
 * pasa verde aunque las dos mitades estén mal. Así que se corre en dos tiempos, contra el
 * MISMO endpoint público:
 *
 *   node qa-invitaciones-equivalencia.mjs capturar   → antes de desplegar (código viejo)
 *   node qa-invitaciones-equivalencia.mjs comparar   → después de desplegar (código nuevo)
 *
 * La captura se guarda en `qa-invitaciones-equivalencia.antes.json` (gitignoreado: trae
 * nombres y montos de usuarios reales).
 *
 * Los códigos NO se hardcodean: salen de la base, así que entran los que existan el día que
 * se corra, incluidos los casos que importan y que un fixture nuevo no tendría —una deuda ya
 * saldada, y una con `ya_confirmada: true`, que es el conteo por la FK de `deudas` a sí misma.
 *
 * Necesita `SUPABASE_SERVICE_ROLE_KEY` y `NEXT_PUBLIC_SUPABASE_URL` (los lee de
 * `webapp/.env.local`, igual que `qa-regla-lote.mjs`).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(AQUI, 'qa-invitaciones-equivalencia.antes.json');
const APP = process.env.NETO_URL || 'https://app.neto.pe';

const modo = process.argv[2];
if (!['capturar', 'comparar'].includes(modo)) {
  console.error('uso: node qa-invitaciones-equivalencia.mjs capturar|comparar');
  process.exit(2);
}

function env() {
  const ruta = join(AQUI, '..', 'webapp', '.env.local');
  if (!existsSync(ruta)) {
    console.error(`falta ${ruta}`);
    process.exit(2);
  }
  const vars = {};
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const m = linea.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

const { NEXT_PUBLIC_SUPABASE_URL: URL_SB, SUPABASE_SERVICE_ROLE_KEY: KEY } = env();
if (!URL_SB || !KEY) {
  console.error('faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en webapp/.env.local');
  process.exit(2);
}

async function tabla(path) {
  const res = await fetch(`${URL_SB}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** Todos los códigos vivos, con la ruta de API que los resuelve. */
async function codigosVivos() {
  const fuentes = [
    ['gasto_participantes', '/api/split/invite'],
    ['deudas', '/api/debts/invite'],
    ['metas_ahorro', '/api/goals/invite'],
    ['shared_spaces', '/api/spaces/invite'],
  ];
  const salida = [];
  for (const [tab, api] of fuentes) {
    const filas = await tabla(`${tab}?invite_code=not.is.null&select=invite_code`);
    for (const f of filas) salida.push({ tabla: tab, api, code: f.invite_code });
  }
  return salida;
}

async function vista({ api, code }) {
  const res = await fetch(`${APP}${api}?code=${encodeURIComponent(code)}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const vivos = await codigosVivos();
if (!vivos.length) {
  console.error('FALLO: no hay ningún código de invitación en la base — no hay nada que comparar,');
  console.error('y una corrida sin casos NO es una corrida verde. Sembrá fixtures antes.');
  process.exit(2);
}

const actual = {};
for (const c of vivos) actual[`${c.api}|${c.code}`] = await vista(c);

if (modo === 'capturar') {
  writeFileSync(SNAPSHOT, JSON.stringify({ cuando: new Date().toISOString(), vistas: actual }, null, 2));
  console.log(`capturados ${vivos.length} códigos vivos en ${SNAPSHOT}`);
  for (const c of vivos) console.log(`  ${c.tabla.padEnd(20)} ${c.api} ${c.code} → ${actual[`${c.api}|${c.code}`].status}`);
  process.exit(0);
}

if (!existsSync(SNAPSHOT)) {
  console.error(`falta ${SNAPSHOT}: corré primero "capturar" contra el código viejo.`);
  process.exit(2);
}
const antes = JSON.parse(readFileSync(SNAPSHOT, 'utf8')).vistas;

const clavesAntes = Object.keys(antes);
const soloAhora = Object.keys(actual).filter((k) => !clavesAntes.includes(k));
const diffs = [];
for (const clave of clavesAntes) {
  const a = antes[clave];
  const b = actual[clave];
  if (!b) {
    diffs.push(`${clave}: existía antes y ahora no se pudo resolver`);
    continue;
  }
  if (a.status !== b.status) diffs.push(`${clave}: status ${a.status} → ${b.status}`);
  const ja = JSON.stringify(a.body, Object.keys(a.body || {}).sort());
  const jb = JSON.stringify(b.body, Object.keys(b.body || {}).sort());
  if (ja !== jb) diffs.push(`${clave}:\n    antes: ${ja}\n    ahora: ${jb}`);
}

console.log(`comparados ${clavesAntes.length} códigos (${soloAhora.length} nuevos, ignorados)`);
if (diffs.length) {
  console.error(`\nFALLO — ${diffs.length} diferencia(s):`);
  for (const d of diffs) console.error('  ' + d);
  process.exit(1);
}
console.log('OK: la resolución nueva devuelve exactamente lo mismo que la vieja.');
