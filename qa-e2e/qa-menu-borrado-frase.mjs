// Verifica por el WEBHOOK REAL, contra la Supabase de producción y con el clasificador de
// OpenAI real, que el menú de desconexión/borrado (paso -1) ya no borra la cuenta por un
// número: sólo con la frase fija. Ítem 39, fila del 30-sep-2026 en `docs/DEFECTOS.md`.
//
// POR QUÉ EXISTE. El defecto era de DESPACHO: `handlers/onboarding.js` leía la respuesta con
// `parseInt`, así que "1.50 pan" valía 1 y, con cero cuentas Gmail, el 1 era el borrado total.
// Los tests de `webhook-onboarding.test.js` lo cubren con Supabase mockeada y el usuario
// armado a mano. Lo que no ven: que el menú lo abra de verdad el intent del NLP, que el paso
// -1 quede ESCRITO en la fila, que el webhook re-lea ese estado en el mensaje siguiente, y
// que ningún intercept del webhook (OTP, referidos, soporte) se meta en el medio.
//
// QUÉ NO HACE, a propósito: borrar la cuenta QA. `borrarCuenta` (services/account-deletion.js)
// se reemplaza por un espía ANTES de cargar la app, porque `onboarding.js` lo destructura al
// cargar. Borrarla de verdad dejaría una lápida que rompe a todos los demás harness y ~16
// filas en `borrados_auditoria`, que es append-only. Lo que se afirma es que el borrado se
// DESPACHA o no; qué se lleva puesto lo mide `qa-borrado-cuenta.mjs` con usuarios propios.
// `revocarAccesoGmail` también es espía, por si el usuario QA tiene un Gmail conectado: el "1"
// lo revocaría en Google.
//
// HISTORIAL ADVERSO. Producción le pasa al clasificador los últimos 4 turnos, así que antes
// de abrir el menú se siembran cuatro turnos de gastos con números — el contexto en el que
// alguien ignora el menú y sigue anotando.
//
// Limpia al final, pase o falle: repone `onboarding_paso` y borra los turnos de
// `conversaciones` y cualquier `transacciones` que esta corrida haya creado.
//
// Correr:  node qa-e2e/qa-menu-borrado-frase.mjs   (desde app/)  → exit 0 si pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (m) => path.join(appRoot, m);

const QA_USER_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';

// ── Espías sobre los dos efectos irreversibles, ANTES de que index.js cargue onboarding.js ──
const llamadasBorrar = [];
const adPath = require.resolve(R('services/account-deletion.js'));
const adReal = require(adPath);
require.cache[adPath].exports = {
  ...adReal,
  borrarCuenta: async (usuario, opts) => {
    llamadasBorrar.push({ id: usuario && usuario.id, opts });
    return { ok: true, tieneGmail: false, gmailSinSoltar: false, resumen: {}, sucio: [] };
  },
};
const llamadasRevocar = [];
const gmPath = require.resolve(R('gmail.js'));
const gmReal = require(gmPath);
require.cache[gmPath].exports = {
  ...gmReal,
  revocarAccesoGmail: async (usuarioId, opts) => {
    llamadasRevocar.push({ usuarioId, opts });
    return { revocadas: 1, emails: ['qa@x.com'] };
  },
};

const { startWebhookHarness } = await import('./webhook-harness.mjs');

const fallos = [];
function check(nombre, ok, detalle) {
  console.log((ok ? '  OK   ' : '  FALLA') + '  ' + nombre + (detalle ? '  → ' + detalle : ''));
  if (!ok) fallos.push(nombre + (detalle ? ': ' + detalle : ''));
}

let h;
let pasoOriginal = null;
const inicio = new Date().toISOString();

async function paso() {
  const { data } = await h.supabase.from('usuarios').select('onboarding_paso').eq('id', QA_USER_ID).single();
  return data ? data.onboarding_paso : undefined;
}
async function fijarPaso(v) {
  const { error } = await h.supabase.from('usuarios').update({ onboarding_paso: v }).eq('id', QA_USER_ID);
  if (error) throw new Error('no pude fijar onboarding_paso: ' + error.message);
}
async function enviar(texto, from) {
  const desde = h.sent.length;
  const status = await h.postText(texto, from);
  if (status !== 200) throw new Error('webhook devolvió ' + status);
  return h.waitForReply(desde, 60000);
}

async function main() {
  h = await startWebhookHarness();
  const { obtenerCuentasGmail } = require(R('gmail.js'));

  const { data: usuario } = await h.supabase.from('usuarios').select('*').eq('id', QA_USER_ID).single();
  if (!usuario || !usuario.is_test_user || !usuario.whatsapp) {
    console.error('Usuario QA no encontrado, sin is_test_user o sin whatsapp'); process.exit(1);
  }
  pasoOriginal = usuario.onboarding_paso;
  const from = usuario.whatsapp;
  const cuentas = await obtenerCuentasGmail(QA_USER_ID);
  console.log('usuario QA: paso=' + pasoOriginal + ', cuentas Gmail activas=' + cuentas.length);
  await fijarPaso(0);

  // Historial adverso: cuatro turnos de gastos con números.
  const turnos = [
    ['user', 'gasté 12.50 en almuerzo'], ['assistant', '✅ Anoté S/ 12.50 en Almuerzo.'],
    ['user', '1.20 pasaje'], ['assistant', '✅ Anoté S/ 1.20 en Pasaje.'],
  ];
  for (const [rol, mensaje] of turnos) {
    await h.supabase.from('conversaciones').insert({ usuario_id: QA_USER_ID, rol, mensaje });
  }

  // "borrar mi cuenta" es el PEDIDO: es la frase que nombra la pista, así que el NLP tiene que
  // abrir el menú con ella. Y por eso la confirmación es otra frase (revisión del 30-sep).
  // ("Desconecta mi cuenta de Gmail" lo manda el clasificador a reconectar Gmail, medido el
  // 30-sep en la primera corrida de este harness.)
  console.log('\n1) El NLP abre el menú con el pedido que nombra la pista');
  const menu = await enviar('borrar mi cuenta', from);
  console.log('     ' + menu.replace(/\n/g, ' ⏎ ').slice(0, 300));
  check('el menú pide la frase de confirmación', menu.includes('*confirmo borrar mi cuenta*'), menu.slice(0, 80));
  const numeradas = menu.split('\n').filter((l) => /^\s*\d+(\uFE0F?\u20E3|\.)/.test(l));
  check('ninguna opción numerada es borrar', numeradas.every((l) => !/elimin|borr/i.test(l)), numeradas.join(' | '));
  check('el paso -1 quedó escrito en la fila', (await paso()) === -1, 'paso=' + (await paso()));
  check('el pedido NO borró', llamadasBorrar.length === 0);

  console.log('\n2) Repite el pedido con el menú abierto (el bot tardó)');
  const r2b = await enviar('borrar mi cuenta', from);
  console.log('     ' + r2b.replace(/\n/g, ' ⏎ '));
  check('repetir el pedido NO borra', llamadasBorrar.length === 0, 'llamadas=' + llamadasBorrar.length);
  check('le dice la frase de confirmación', r2b.includes('*confirmo borrar mi cuenta*'));
  check('el menú se cerró (paso 0)', (await paso()) === 0);

  console.log('\n3) Con el menú abierto, anota un gasto que empieza con 1');
  await fijarPaso(-1);
  const r2 = await enviar('1.50 pan', from);
  console.log('     ' + r2.replace(/\n/g, ' ⏎ '));
  check('NO se despachó el borrado', llamadasBorrar.length === 0, 'llamadas=' + llamadasBorrar.length);
  check('NO se revocó Gmail', llamadasRevocar.length === 0);
  check('contesta que canceló y la cuenta sigue igual', r2.startsWith('Cancelado. Tu cuenta sigue igual'));
  check('el menú se cerró (paso 0)', (await paso()) === 0);

  console.log('\n4) Un "1" solo (menú del número viejo, o el Gmail ya revocado)');
  await fijarPaso(-1);
  const r3 = await enviar('1', from);
  console.log('     ' + r3.replace(/\n/g, ' ⏎ '));
  check('NO se despachó el borrado', llamadasBorrar.length === 0);
  if (cuentas.length === 0) {
    check('dice que no encontró Gmail', /No encontré ningún Gmail conectado/.test(r3));
    check('y cómo se borra', r3.includes('*confirmo borrar mi cuenta*'));
    check('NO se revocó nada', llamadasRevocar.length === 0);
  } else {
    check('desconecta (hay Gmail)', llamadasRevocar.length === 1 && /desconectado/i.test(r3));
  }
  check('el menú se cerró (paso 0)', (await paso()) === 0);

  console.log('\n5) "2", el borrado del menú viejo con una cuenta');
  await fijarPaso(-1);
  const revocarAntes = llamadasRevocar.length;
  const r4 = await enviar('2', from);
  console.log('     ' + r4.replace(/\n/g, ' ⏎ '));
  check('NO se despachó el borrado', llamadasBorrar.length === 0);
  check('NO se revocó nada', llamadasRevocar.length === revocarAntes);
  check('le dice la frase', r4.includes('*confirmo borrar mi cuenta*'));

  console.log('\n6) La frase de confirmación');
  await fijarPaso(-1);
  const r5 = await enviar('Confirmo borrar mi cuenta', from);
  console.log('     ' + r5.replace(/\n/g, ' ⏎ ').slice(0, 200));
  check('se despachó el borrado, una vez, del usuario QA',
    llamadasBorrar.length === 1 && llamadasBorrar[0].id === QA_USER_ID && llamadasBorrar[0].opts.origen === 'whatsapp',
    JSON.stringify(llamadasBorrar));
  check('contesta cuenta eliminada', /Cuenta eliminada/.test(r5));
}

async function limpiar() {
  if (!h) return;
  try { if (pasoOriginal !== null) await fijarPaso(pasoOriginal); } catch (e) { console.error('restaurar paso:', e.message); }
  for (const t of ['conversaciones', 'transacciones']) {
    const { data } = await h.supabase.from(t).select('id').eq('usuario_id', QA_USER_ID).gte('created_at', inicio);
    for (const f of data || []) await h.supabase.from(t).delete().eq('id', f.id);
    console.log('limpieza ' + t + ': ' + (data || []).length + ' filas');
  }
  await h.close();
}

try {
  await main();
} catch (e) {
  check('la corrida terminó', false, e.stack || e.message);
} finally {
  await limpiar();
}
console.log('\n' + (fallos.length ? 'FALLAS: ' + fallos.length + '\n  - ' + fallos.join('\n  - ') : 'TODO OK'));
process.exit(fallos.length ? 1 : 0);
