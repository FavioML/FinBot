/**
 * Backfill one-time: cifra los tokens OAuth de Gmail que quedaron en texto plano
 * en filas anteriores al despliegue de lib/crypto.js.
 *
 * Reutiliza lib/crypto.js (mismo AES-256-GCM, misma ENCRYPTION_KEY hex) — NO genera
 * llave nueva ni cambia formato. Idempotente: salta lo que ya está cifrado.
 *
 * Columnas objetivo (NO toca *_expiry):
 *   usuarios.gmail_access_token / usuarios.gmail_refresh_token
 *   gmail_cuentas.access_token  / gmail_cuentas.refresh_token
 *
 * Uso (correr en Railway para que la llave nunca salga de la plataforma):
 *   DRY_RUN=1 railway run -- node scripts/backfill-encrypt-tokens.js   # default: solo reporta
 *   DRY_RUN=0 railway run -- node scripts/backfill-encrypt-tokens.js   # ejecuta
 *
 * NO loggea valores de token (solo ids + categoría).
 */
require('dotenv').config();
const { supabase } = require('../lib/db');
const { encrypt, decrypt } = require('../lib/crypto');

const DRY_RUN = process.env.DRY_RUN !== '0'; // default: dry-run salvo DRY_RUN=0 explícito

// Tablas/columnas a procesar. tipo: 'access' | 'refresh' (define prefijo esperado).
const TARGETS = [
  { table: 'usuarios',      pk: 'id', col: 'gmail_access_token',  tipo: 'access'  },
  { table: 'usuarios',      pk: 'id', col: 'gmail_refresh_token', tipo: 'refresh' },
  { table: 'gmail_cuentas', pk: 'id', col: 'access_token',        tipo: 'access'  },
  { table: 'gmail_cuentas', pk: 'id', col: 'refresh_token',       tipo: 'refresh' },
];

/**
 * Decide qué hacer con un valor. Devuelve { action, reason }.
 * action: 'skip' | 'encrypt' | 'null' | 'abort'
 */
function categorize(value, tipo) {
  if (value === null || value === undefined || value === '') return { action: 'skip', reason: 'vacío' };
  if (value.includes(':')) return { action: 'skip', reason: 'ya cifrado' };
  if (tipo === 'access') {
    if (value.startsWith('ya29.')) return { action: 'encrypt', reason: 'access plano (ya29.)' };
    if (value.length < 20) return { action: 'null', reason: `basura corta len=${value.length}` };
    return { action: 'abort', reason: `access plano inesperado len=${value.length}` };
  }
  // refresh
  if (value.startsWith('1//')) return { action: 'encrypt', reason: 'refresh plano (1//)' };
  return { action: 'abort', reason: `refresh plano inesperado len=${value.length}` };
}

function selfTest() {
  const sample = 'neto-selftest-' + 'x'.repeat(10);
  const round = decrypt(encrypt(sample));
  if (round !== sample) {
    throw new Error('Self-test de llave FALLÓ: encrypt→decrypt no es idéntico. Abortando sin tocar datos.');
  }
  console.log('[selftest] ENCRYPTION_KEY OK (round-trip idéntico).');
}

async function main() {
  console.log(`\n=== Backfill encrypt tokens Gmail Neto — modo ${DRY_RUN ? 'DRY-RUN (no escribe)' : 'EJECUCIÓN'} ===\n`);
  selfTest();

  const plan = []; // { table, col, tipo, pk, id, action, reason, original }
  let abortFlag = false;

  for (const t of TARGETS) {
    const { data, error } = await supabase.from(t.table).select(`${t.pk}, ${t.col}`);
    if (error) throw new Error(`Error leyendo ${t.table}.${t.col}: ${error.message}`);
    for (const row of data) {
      const value = row[t.col];
      const { action, reason } = categorize(value, t.tipo);
      if (action === 'abort') abortFlag = true;
      plan.push({ ...t, id: row[t.pk], action, reason, original: value });
    }
  }

  // Reporte agregado (sin valores de token)
  const summary = {};
  for (const p of plan) {
    const key = `${p.table}.${p.col} → ${p.action}`;
    summary[key] = (summary[key] || 0) + 1;
  }
  console.log('--- Resumen por tabla/columna/acción ---');
  for (const [k, n] of Object.entries(summary)) console.log(`  ${k}: ${n}`);
  console.log('');

  // Detalle de las que cambian (encrypt / null) y de los abort
  const cambios = plan.filter(p => p.action === 'encrypt' || p.action === 'null');
  const aborts = plan.filter(p => p.action === 'abort');
  console.log('--- Filas a modificar ---');
  for (const p of cambios) console.log(`  [${p.action}] ${p.table}.${p.col} id=${p.id} (${p.reason})`);
  if (cambios.length === 0) console.log('  (ninguna — todo ya cifrado)');
  if (aborts.length) {
    console.log('\n!!! VALORES INESPERADOS (requieren revisión manual) !!!');
    for (const p of aborts) console.log(`  [abort] ${p.table}.${p.col} id=${p.id} (${p.reason})`);
  }
  console.log('');

  if (abortFlag) {
    throw new Error('Hay valores inesperados (ver arriba). Abortando SIN escribir. Revísalos manualmente.');
  }

  if (DRY_RUN) {
    console.log('DRY-RUN: no se escribió nada. Re-correr con DRY_RUN=0 para ejecutar.\n');
    return;
  }

  // Ejecución real con verificación por fila
  let okEncrypt = 0, okNull = 0;
  for (const p of cambios) {
    if (p.action === 'encrypt') {
      const enc = encrypt(p.original);
      const { error: upErr } = await supabase.from(p.table).update({ [p.col]: enc }).eq(p.pk, p.id);
      if (upErr) throw new Error(`Update falló ${p.table}.${p.col} id=${p.id}: ${upErr.message}`);
      // Verificación: re-leer y descifrar === original
      const { data: rb, error: rbErr } = await supabase.from(p.table).select(`${p.col}`).eq(p.pk, p.id).single();
      if (rbErr) throw new Error(`Read-back falló ${p.table}.${p.col} id=${p.id}: ${rbErr.message}`);
      if (decrypt(rb[p.col]) !== p.original) {
        throw new Error(`VERIFICACIÓN FALLÓ ${p.table}.${p.col} id=${p.id}: decrypt(stored) != original. Abortando.`);
      }
      okEncrypt++;
      console.log(`  ✓ cifrado+verificado ${p.table}.${p.col} id=${p.id}`);
    } else if (p.action === 'null') {
      const { error: upErr } = await supabase.from(p.table).update({ [p.col]: null }).eq(p.pk, p.id);
      if (upErr) throw new Error(`Update NULL falló ${p.table}.${p.col} id=${p.id}: ${upErr.message}`);
      okNull++;
      console.log(`  ✓ NULL ${p.table}.${p.col} id=${p.id}`);
    }
  }
  console.log(`\nHecho. Cifrados: ${okEncrypt}, NULL: ${okNull}.\n`);
}

main().catch(err => {
  console.error('\n[ERROR]', err.message, '\n');
  process.exit(1);
});
