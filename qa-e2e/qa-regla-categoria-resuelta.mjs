// E2E del hallazgo B30: la categoría de una regla por comercio PISA la que dedujo el
// clasificador, así que si entra cruda `reglas_comercio` es una TERCERA puerta que escribe
// `transacciones.categoria` sin pasar por el invariante de B28 ("canónica por el mapa, o el
// nombre crudo del usuario").
//
// El daño era real y está medido (12-ago-2026): un usuario tenía sus gastos de comida
// partidos en dos, 5 filas en 'Alimentacion' y 5 en 'Alimentación', y la línea del corte era
// exactamente qué comercios tenían regla.
//
// Qué ejercita, punta a punta y por el webhook REAL contra la Supabase real:
//   fase 1 (0 llamadas a OpenAI) — `/cambiar <comercio> alimentacion`
//       webhook firmado → cascada de comandos → recategorizarTransaccion → fila en DB
//   fase 2 (1 llamada a OpenAI) — "todo lo de <comercio> va en alimentacion"
//       → Function Calling → intent editar_categoria_comercio → guardarReglaComercio
//       → fila en `reglas_comercio` + retroaplicación sobre `transacciones`
//
// LA ASERCIÓN ES LA TILDE. 'Alimentacion' es lo que el usuario escribió y lo que el código
// viejo guardaba; 'Alimentación' es la canónica. Un HTTP 200 no distingue una de otra — por
// eso todo se verifica leyendo la fila, que es la lección que dejó `qa-regla-lote`.
//
// El comercio es aleatorio y SIN DÍGITOS a propósito: el handler rechaza como "gasto mal
// clasificado" cualquier comercio con un número, así que un tag tipo `qa-b30-123` haría fallar
// la fase 2 por un motivo que no tiene nada que ver con lo que se está midiendo.
//
// Escribe 1 transacción y 1 regla, y las borra. Cuesta ~1 llamada OpenAI (gpt-4o-mini).
//
// Correr:  node qa-e2e/qa-regla-categoria-resuelta.mjs   (desde app/)  → exit 0 si pasa.

import { startWebhookHarness } from './webhook-harness.mjs';

// Usuario QA de prueba (is_test_user=true → cero envíos Meta reales). Ver
// reference_neto_qa_test_user.
const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';

// Sin dígitos (ver arriba) y sin espacios: el patrón de la regla es el comercio en minúsculas.
const sufijo = Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const COMERCIO = 'qabtreinta' + sufijo;
const PATRON = COMERCIO.toLowerCase();
const MONTO = 30 + (10 + Math.floor(Math.random() * 90)) / 100;

// Lo que el usuario ESCRIBE y lo que tiene que quedar GUARDADO. La diferencia es todo el test.
const ESCRITO = 'alimentacion';
const CANONICA = 'Alimentación';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

const filas = async (h) => (await h.supabase.from('transacciones')
  .select('id, categoria, subcategoria, comercio').eq('usuario_id', QA_ID).eq('comercio', COMERCIO)).data || [];
const reglas = async (h) => (await h.supabase.from('reglas_comercio')
  .select('categoria, subcategoria').eq('usuario_id', QA_ID).eq('comercio_pattern', PATRON)).data || [];

async function limpiar(h) {
  await h.supabase.from('transacciones').delete().eq('usuario_id', QA_ID).eq('comercio', COMERCIO);
  await h.supabase.from('reglas_comercio').delete().eq('usuario_id', QA_ID).eq('comercio_pattern', PATRON);
}

async function run(h) {
  const { data: user } = await h.supabase.from('usuarios')
    .select('id, whatsapp, is_test_user, plan').eq('id', QA_ID).single();
  if (!check('usuario QA existe y es de prueba',
    user?.is_test_user === true && user?.whatsapp === QA_WHATSAPP,
    'whatsapp=' + user?.whatsapp + ' plan=' + user?.plan)) return;

  await limpiar(h);

  // Semilla: un gasto sin clasificar del comercio de este run.
  const { error: seedErr } = await h.supabase.from('transacciones').insert({
    usuario_id: QA_ID, tipo: 'gasto', monto: MONTO, monto_pen: MONTO, moneda: 'PEN',
    comercio: COMERCIO, categoria: 'Otros', subcategoria: 'Sin_categoria',
    fecha: new Date().toISOString().slice(0, 10), metodo_pago: 'Yape', confirmado: true,
  });
  if (!check('semilla: 1 gasto en Otros', !seedErr, seedErr ? seedErr.message : 'ok')) return;

  // NO VACUO: sin esto, un test que no hace nada "pasaría" si la regla ya existiera.
  if (!check('precondición: no existe regla para este comercio', (await reglas(h)).length === 0)) return;

  // ── Fase 1: `/cambiar`, el camino sin LLM ────────────────────────────────────
  let before = h.sent.length;
  check('el webhook acepta /cambiar', await h.postText('/cambiar ' + COMERCIO + ' ' + ESCRITO, QA_WHATSAPP) === 200);
  const reply1 = (await h.waitForReply(before)).trim();
  console.log('\n--- respuesta a /cambiar ---\n' + reply1 + '\n');

  const trasCambiar = await filas(h);
  check('/cambiar guardó la CANÓNICA, no la grafía que escribió el usuario',
    trasCambiar.length === 1 && trasCambiar[0].categoria === CANONICA,
    'categoria=' + (trasCambiar[0]?.categoria ?? '(sin fila)') + ' escrito=' + ESCRITO);

  // ── Fase 2: la regla, por el camino del clasificador ─────────────────────────
  before = h.sent.length;
  check('el webhook acepta el mensaje de regla',
    await h.postText('todo lo de ' + COMERCIO + ' va en ' + ESCRITO, QA_WHATSAPP) === 200);
  const reply2 = (await h.waitForReply(before)).trim();
  console.log('\n--- respuesta a la regla ---\n' + reply2 + '\n');

  // Si el clasificador no eligió `editar_categoria_comercio`, el resto no mide lo que dice
  // medir: se marca acá para no leer un rojo de NLP como un rojo de B30.
  if (!check('el clasificador entendió que era una REGLA (si esto falla, el resto no aplica)',
    /Regla creada/i.test(reply2), reply2.slice(0, 80))) return;

  const reglaFinal = await reglas(h);
  check('la regla nació con la CANÓNICA en `reglas_comercio`',
    reglaFinal.length === 1 && reglaFinal[0].categoria === CANONICA,
    'categoria=' + (reglaFinal[0]?.categoria ?? '(sin regla)'));

  check('la confirmación le muestra al usuario el nombre EFECTIVO de la regla',
    reply2.includes(CANONICA), reply2.slice(0, 120));

  // La retroaplicación tiene que escribir el MISMO nombre que la regla. Si difiere, el pasado
  // y el futuro del mismo comercio quedan en dos categorías distintas — que es el bug medido
  // dado vuelta, y es lo que pasaría resolviendo sólo dentro de `guardarReglaComercio`.
  const trasRegla = await filas(h);
  check('la retroaplicación escribió el mismo nombre que la regla',
    trasRegla.length === 1 && trasRegla[0].categoria === CANONICA,
    'fila=' + (trasRegla[0]?.categoria ?? '(sin fila)') + ' regla=' + (reglaFinal[0]?.categoria ?? '—'));
}

const h = await startWebhookHarness();
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await limpiar(h); } catch { /* la limpieza no cambia el veredicto */ }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
