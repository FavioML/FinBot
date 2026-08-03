// E2E — un usuario no puede terminar con DOS cuentas de Gmail vinculadas.
//
// La rama que se ejercita: `routes/public.js` rechaza con 409 cuando alguien autoriza con un
// correo distinto al que ya tiene vinculado, y suelta el grant sobrante en el acto. Hasta
// ahora solo la cubrían guards estáticos (`tests/gmail-una-cuenta.test.js`, que lee el fuente
// y verifica el ORDEN de las llamadas), porque ejercerla de verdad contra Google **cuesta un
// cupo a propósito** — es exactamente lo que este código existe para evitar.
//
// Cómo se corre sin gastar cupo: se ejercita el callback REAL montado en un Express real,
// contra la Supabase REAL, con el state firmado REAL. Lo único falso es lo que hablaría con
// Google:
//
//   · `oauth2Client.getToken`   → tokens de mentira (no hay `code` que canjear)
//   · `obtenerPerfilGoogle`     → devuelve el correo del "intruso"
//   · `oauth2Client.revokeToken`→ espía, para afirmar que se revoca
//   · `guardarTokens`           → espía puro, no escribe
//
// `guardarTokens` va como espía y no envuelto sobre el real a propósito: el invariante que
// importa —que la rama 409 no vincule nada— se afirma mejor por "no se llamó" que por "no
// escribió", porque es el ÚNICO camino que escribe en `gmail_cuentas` desde acá. El conteo de
// filas contra la base va igual, como red por si algún día aparece otro escritor.
//
// Lo que NO es falso, y es el punto: la comparación contra el historial la hace
// `emailGmailVinculado` de verdad, leyendo `gmail_cuentas` de producción.
//
// El control anti-vacuidad es el segundo caso: con el MISMO correo el callback NO responde 409
// y SÍ vincula. Sin él, un callback que rechazara todo pasaría este harness entero.
//
// Correr:  node qa-e2e/qa-gmail-segundo-correo.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const sello = Date.now();
const EMAIL_VINCULADO = 'qa-vinculado-' + sello + '@example.test';
const EMAIL_INTRUSO = 'qa-intruso-' + sello + '@example.test';

const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

// Stubs de salida ANTES de cargar el router: el callback dispara un setTimeout que manda
// WhatsApp y arranca un barrido de Gmail. Ninguna de las dos cosas tiene que pasar de verdad.
for (const [rel, exports] of [
  ['lib/whatsapp.js', { enviarWhatsapp: async () => {} }],
  ['services/gmail-scanner.js', {
    escanearGmailYRegistrar: async () => null,
    escanearHistoricoInicial: async () => null,
    escaneoAutomatico: async () => {},
  }],
]) {
  const p = require.resolve(path.join(appRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// gmail.js se carga REAL y se le parchean solo las piezas que hablarían con Google. Va antes de
// requerir el router, que destructura estos nombres al cargarse.
const gmail = require(path.join(appRoot, 'gmail.js'));
const revocados = [];
const vinculados = [];
let perfilEmail = EMAIL_INTRUSO;

gmail.obtenerPerfilGoogle = async () => ({ nombre: 'QA Intruso', email: perfilEmail });
gmail.oauth2Client.getToken = async () => ({
  tokens: { access_token: 'qa-at-' + sello, refresh_token: 'qa-rt-' + sello, expiry_date: Date.now() + 3600_000 },
});
gmail.oauth2Client.revokeToken = async (t) => { revocados.push(t); };
gmail.guardarTokens = async (usuarioId, tokens, email) => { vinculados.push({ usuarioId, email }); };

const publicRouter = require(path.join(appRoot, 'routes/public.js'));
const express = require('express');
const { esProPagado } = require(path.join(appRoot, 'lib/trial.js'));

const results = [];
function check(nombre, ok, detalle = '') {
  results.push({ nombre, ok });
  console.log((ok ? '  OK   ' : '  FALLA') + '  ' + nombre + (detalle ? '  [' + detalle + ']' : ''));
}

/** El state firmado de verdad, sacado de la URL que emite el backend. */
function stateFirmado(whatsapp) {
  const url = gmail.generarUrlAutorizacion(whatsapp, 'inicial', 'web', QA_ID, EMAIL_VINCULADO);
  return new URL(url).searchParams.get('state');
}

let server = null;
let filaThrowaway = null;

async function main() {
  const { data: qa } = await supabase.from('usuarios').select('*').eq('id', QA_ID).single();
  if (!qa) throw new Error('no existe el usuario QA ' + QA_ID);
  check('el usuario QA es de prueba y es Pro PAGADO (si no, el gate de arriba corta antes)',
    qa.is_test_user === true && esProPagado(qa),
    'is_test_user=' + qa.is_test_user + ' plan=' + qa.plan + ' trial=' + qa.trial_estado);

  // Barrido previo: si una corrida anterior murió de golpe (Ctrl-C, kill), su `finally` no
  // corrió y quedó una fila sembrada. `gmail_cuentas` es el marcador de cupos, así que una
  // sobra ahí hace que el conteo mienta. Se limpia ANTES de medir el baseline.
  const { data: sobrasPrevias } = await supabase.from('gmail_cuentas').select('id, email').eq('usuario_id', QA_ID);
  for (const f of sobrasPrevias || []) {
    console.log('  (limpiando sobra de una corrida anterior: ' + f.email + ')');
    await supabase.from('gmail_cuentas').delete().eq('id', f.id);
  }

  const { count: baseline } = await supabase.from('gmail_cuentas').select('id', { count: 'exact', head: true });

  // La cuenta "ya vinculada". Es la precondición de la rama: sin ella no hay con qué comparar.
  const { data: creada, error: errIns } = await supabase.from('gmail_cuentas')
    .insert({ usuario_id: QA_ID, email: EMAIL_VINCULADO, activa: true })
    .select('id').single();
  if (errIns) throw new Error('no se pudo sembrar la cuenta vinculada: ' + errIns.message);
  filaThrowaway = creada.id;

  server = express().use(publicRouter).listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;

  // ── Caso 1: autoriza con OTRO correo ────────────────────────────────────────
  perfilEmail = EMAIL_INTRUSO;
  revocados.length = 0; vinculados.length = 0;
  const r409 = await fetch(base + '/auth/callback?code=qa-fake-code&state=' + encodeURIComponent(stateFirmado(qa.whatsapp)), { redirect: 'manual' });
  const html409 = await r409.text();

  check('un segundo correo se rechaza con 409', r409.status === 409, 'status=' + r409.status);
  check('el rechazo le dice CUÁL es su cuenta vinculada', html409.includes(EMAIL_VINCULADO));
  check('no le ofrece cambiarla por su cuenta (eso se resuelve por soporte)',
    /escríbenos/i.test(html409) && !html409.includes(EMAIL_INTRUSO));
  check('el grant sobrante se revoca en el acto', revocados.length === 1, 'revocados=' + revocados.length);
  check('no se vincula nada: guardarTokens ni se llama', vinculados.length === 0);

  const { data: intrusa } = await supabase.from('gmail_cuentas')
    .select('id').eq('usuario_id', QA_ID).eq('email', EMAIL_INTRUSO);
  check('no quedó fila del correo intruso en gmail_cuentas', (intrusa || []).length === 0);

  // ── Caso 2 (control): el MISMO correo pasa ──────────────────────────────────
  // Sin esto, un callback que respondiera 409 a todo pasaría el harness completo.
  perfilEmail = EMAIL_VINCULADO;
  revocados.length = 0; vinculados.length = 0;
  const rOk = await fetch(base + '/auth/callback?code=qa-fake-code&state=' + encodeURIComponent(stateFirmado(qa.whatsapp)), { redirect: 'manual' });

  check('reconectar el MISMO correo no se rechaza (es el caso de invalid_grant)', rOk.status !== 409, 'status=' + rOk.status);
  check('reconectar el mismo correo SÍ vincula', vinculados.length === 1 && vinculados[0].email === EMAIL_VINCULADO);
  check('reconectar el mismo correo NO revoca (sería tumbar el grant recién emitido)', revocados.length === 0);
}

main()
  .catch((e) => { console.error('\nEXPLOTÓ: ' + e.message); results.push({ nombre: 'el harness terminó', ok: false }); })
  .finally(async () => {
    if (server) server.close();
    // Limpieza incondicional: la fila sembrada no puede sobrevivir a una corrida fallida, o el
    // conteo de gmail_cuentas (que es el marcador de cupos) queda mintiendo.
    if (filaThrowaway) {
      const { error } = await supabase.from('gmail_cuentas').delete().eq('id', filaThrowaway);
      if (error) console.error('OJO: no se pudo borrar la fila sembrada ' + filaThrowaway + ': ' + error.message);
    }
    const { count: final } = await supabase.from('gmail_cuentas').select('id', { count: 'exact', head: true });
    const { data: sobras } = await supabase.from('gmail_cuentas').select('id').eq('usuario_id', QA_ID);
    check('gmail_cuentas queda como estaba: el harness no deja cupos fantasma',
      (sobras || []).length === 0, 'filas totales=' + final + ' filas del QA=' + (sobras || []).length);

    const ok = results.filter((r) => r.ok).length;
    console.log('\n' + ok + '/' + results.length + ' checks');
    process.exit(ok === results.length ? 0 : 1);
  });
