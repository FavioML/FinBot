// E2E de la respuesta a la pregunta fija de tipo (17-oct-2026, arreglo intermedio de
// `memory/reports/neto-nlp-arquitectura-2026-10-17.md`): "Gasto" contestando "¿Esos S/X entraron o
// salieron?" se perdía en el extractor, que no ve la conversación, y Neto contestaba "Eso no lo anoté".
//
// Corre por el webhook REAL firmado, con el usuario QA y la Supabase real: siembra en `conversaciones`
// un historial ADVERSO (una consulta y un gasto anteriores, que el clasificador vería en su ventana de
// 4) y encima el mensaje con el monto y la pregunta fija. Después manda la respuesta y mira tres cosas:
// la respuesta que ve la persona, la fila en `transacciones` y que ningún intercept del webhook se haya
// quedado con el mensaje (si alguno lo hiciera, no habría ✅ ni fila).
//
// Tres casos: "Gasto" → gasto; "Es un ingreso" → ingreso; y el CONTROL, la misma pregunta con texto
// pegado al final (ya no es la pregunta fija), que vuelve al camino de siempre y no registra. Montos únicos por corrida (centavos al azar)
// para encontrar y borrar exactamente lo que escribió este run.
//
// Escribe y borra. Cuesta pocas llamadas a OpenAI (la categoría, y en el control el clasificador y el
// extractor). Manual, fuera del canary.
//
// Correr:  node qa-e2e/qa-respuesta-tipo.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const R = (m) => path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), m);
const { hoyPeru } = require(R('lib/dates.js'));

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';

const unico = (base) => base + (10 + Math.floor(Math.random() * 90)) / 100;
const CASOS = [
  { nombre: 'gasto', monto: unico(28), respuesta: 'Gasto', tipo: 'gasto', minutos: 1, registra: true },
  { nombre: 'ingreso', monto: unico(41), respuesta: 'Es un ingreso', tipo: 'ingreso', minutos: 1, registra: true },
  // El control no usa el reloj (una pregunta de hace 40 minutos) porque el usuario QA lo comparten otras
  // sesiones, y cualquier turno suyo más nuevo hace que la ventana no termine en la siembra. La pregunta con
  // algo pegado tampoco es la pregunta fija, y eso no depende de nadie más. La ventana de 30 minutos la
  // fijan los tests de `tests/handlers/respuesta-pregunta-tipo.test.js`.
  { nombre: 'control: la pregunta con texto pegado', monto: unico(53), respuesta: 'Gasto', tipo: 'gasto', minutos: 1, registra: false, pegado: '\n\n💡 _Revisa tus gráficos en https://app.neto.pe_' },
];

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

const pregunta = (m) => '¿Esos S/' + m.toFixed(2) + ' entraron o salieron? Escríbemelo con el verbo: "gasté ' + m.toFixed(2) + ' en…" o "me pagaron ' + m.toFixed(2) + '".';
const sembrados = [];

async function sembrar(h, c) {
  const t = (minAtras) => new Date(Date.now() - minAtras * 60000).toISOString();
  const m = c.minutos;
  const filas = [
    { rol: 'usuario', mensaje: 'cuánto gasté hoy', created_at: t(m + 4) },
    { rol: 'neto', mensaje: 'Hoy llevas S/ 20.00 en 1 gasto.', created_at: t(m + 3.9) },
    { rol: 'usuario', mensaje: 'gasté 20 en pan', created_at: t(m + 3) },
    { rol: 'neto', mensaje: '✅ S/20.00 en Alimentación > Panaderia · ' + hoyPeru(), created_at: t(m + 2.9) },
    { rol: 'usuario', mensaje: c.monto.toFixed(2) + ', tarjeta de débito', created_at: t(m + 0.1) },
    { rol: 'neto', mensaje: pregunta(c.monto) + (c.pegado || ''), created_at: t(m) },
  ].map((f) => ({ usuario_id: QA_ID, ...f }));
  const { data, error } = await h.supabase.from('conversaciones').insert(filas).select('id');
  if (error) throw new Error('sembrar conversaciones: ' + error.message);
  sembrados.push(...data.map((d) => d.id));
  // La ventana que va a leer el pipeline tiene que terminar en ESTA pregunta: si otra corrida del
  // usuario QA escribió algo más nuevo, el control pasaría por el motivo equivocado.
  const { data: ult } = await h.supabase.from('conversaciones').select('mensaje').eq('usuario_id', QA_ID)
    .order('created_at', { ascending: false }).limit(1);
  return ult && ult[0] && ult[0].mensaje === pregunta(c.monto) + (c.pegado || '');
}

async function filas(h, monto) {
  const { data, error } = await h.supabase.from('transacciones').select('id, monto, tipo, fecha, moneda')
    .eq('usuario_id', QA_ID).eq('monto', monto);
  if (error) throw new Error('leer transacciones: ' + error.message);
  return data || [];
}

async function run(h) {
  const { data: user } = await h.supabase.from('usuarios').select('id, whatsapp, is_test_user').eq('id', QA_ID).single();
  if (!check('usuario QA existe y es de prueba', user?.is_test_user === true && user?.whatsapp === QA_WHATSAPP)) return;

  for (const c of CASOS) {
    console.log('\n── ' + c.nombre + ' (S/' + c.monto.toFixed(2) + ') ──');
    if (!check(c.nombre + ': la ventana termina en la pregunta sembrada', await sembrar(h, c))) continue;
    const antes = h.sent.length;
    const status = await h.postText(c.respuesta, QA_WHATSAPP);
    check(c.nombre + ': el webhook acepta el mensaje', status === 200, 'status=' + status);
    const reply = (await h.waitForReply(antes, 90000)).trim();
    console.log('> ' + c.respuesta + '\n< ' + reply.replace(/\n/g, '\n< '));
    const rows = await filas(h, c.monto);
    if (c.registra) {
      check(c.nombre + ': la persona ve el ✅ con el monto preguntado', reply.startsWith('✅ S/' + c.monto.toFixed(2)), reply.slice(0, 60));
      check(c.nombre + ': una sola fila, con el tipo de la respuesta, en soles y de hoy',
        rows.length === 1 && rows[0].tipo === c.tipo && rows[0].moneda === 'PEN' && rows[0].fecha === hoyPeru(),
        JSON.stringify(rows));
    } else {
      check(c.nombre + ': no se registra nada', rows.length === 0, rows.length + ' filas');
      check(c.nombre + ': la respuesta no es una confirmación', !/^✅/.test(reply), reply.slice(0, 60));
    }
    // Cada caso arranca con su propia ventana: lo que escribió este (la siembra y los dos turnos del
    // webhook) se borra antes del siguiente. El webhook guarda su respuesta DESPUÉS de mandarla, así
    // que se espera a que esa fila exista: sin eso quedaba más nueva que la siembra siguiente.
    await esperarRespuestaGuardada(h);
    await borrarTurnos(h);
  }
}

async function esperarRespuestaGuardada(h) {
  for (let i = 0; i < 20; i++) {
    const { data } = await h.supabase.from('conversaciones').select('id').eq('usuario_id', QA_ID).eq('rol', 'neto').gte('created_at', inicio).limit(1);
    if (data && data.length) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function borrarTurnos(h) {
  const { data: turnos } = await h.supabase.from('conversaciones').select('id').eq('usuario_id', QA_ID).gte('created_at', inicio).limit(100);
  const ids = [...new Set([...sembrados, ...(turnos || []).map((t) => t.id)])];
  if (ids.length) await h.supabase.from('conversaciones').delete().in('id', ids);
  sembrados.length = 0;
}

async function limpiar(h) {
  for (const c of CASOS) {
    const rows = await filas(h, c.monto);
    if (rows.length) await h.supabase.from('transacciones').delete().in('id', rows.map((r) => r.id));
  }
  await borrarTurnos(h);
  const { data: cats } = await h.supabase.from('categorias_usuario').select('id, padre_id').eq('usuario_id', QA_ID).gte('created_at', inicio).limit(50);
  for (const grupo of [(cats || []).filter((x) => x.padre_id), (cats || []).filter((x) => !x.padre_id)]) {
    if (grupo.length) await h.supabase.from('categorias_usuario').delete().in('id', grupo.map((x) => x.id));
  }
  let quedan = 0;
  for (const c of CASOS) quedan += (await filas(h, c.monto)).length;
  check('limpieza: no quedan transacciones de la corrida', quedan === 0, quedan + ' filas');
}

// Lo que el pipeline escribe nace después de esto; lo sembrado (que puede ser más viejo) se borra por id.
const inicio = new Date().toISOString();
const h = await startWebhookHarness();
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await limpiar(h); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
