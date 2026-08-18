// Verifica CONTRA LA SUPABASE REAL que la guarda de borrado sin sujeto no borra un gasto
// cuando el mensaje no pidió borrarlo — y que sí borra cuando lo pide.
//
// POR QUÉ EXISTE. La guarda (`pideBorrarUnGasto`, handlers/intents/transacciones.js) se
// desplegó el 17-ago-2026 probada por mutación en la suite, y ahí termina: los tests corren
// contra un mock de supabase, así que afirman que el handler NO llama a `.delete()`. Lo que
// nadie verificaba es lo único que le importa a la persona del otro lado: **que la fila siga
// existiendo**. El único harness que despacha intents contra el registry real
// (`qa-handler-directo.mjs`) es read-only por construcción y su docblock prohíbe justo estos
// dos intents, así que este camino no tenía ninguna verificación de campo.
//
// El caso que lo originó (17-ago-2026, usuario real): escribió "Quiero reiniciar" y recibió
// "↩️ Deshecho: Eliminé Sueldo — S/ 480.00". Nunca volvió a escribir.
//
// LAS DOS PUERTAS, y por eso cada caso corre dos veces. `deshacer_ultimo` y
// `eliminar_transaccion` sin comercio/monto/fecha hacen lo mismo (borrar lo último que haya)
// y salen del MISMO tool de OpenAI (`manage_transaction`), así que cuál de las dos sale lo
// decide gpt-4o-mini. Verificar una sola deja la gemela abierta al mismo caso — es
// exactamente el agujero que tuvo la primera versión de la guarda.
//
// ESCRIBE en la Supabase real, y solo sobre transacciones que siembra él mismo (comercio
// QA_BORRADO_PROBE), sobre el usuario QA que ya existe. Limpia al final, pase o falle.
//
// NO SIEMBRA NINGÚN USUARIO, y eso es deliberado: sembrar una fila en `usuarios` con un
// celular peruano plausible deja al bot MUDO para siempre con esa persona el día que
// escriba, porque `obtenerOCrearUsuario` adopta la fila y hereda su `is_test_user`. Ya pasó
// con un harness que generaba `519` + 8 dígitos al azar. Acá no hace falta: el usuario QA
// tiene historial y es el sujeto correcto. Tampoco se envía un solo mensaje — el handler
// devuelve un string y es el webhook quien lo manda, así que llamándolo directo no hay
// destinatario posible.
//
// VISTO ROJO, no deducido (17-ago-2026). Con la guarda anulada en las DOS puertas
// (`if (false && !pideBorrarUnGasto(msg))`) el harness sale **exit 1 con 32 fallas**: los
// cuatro casos ambiguos por cada puerta, cada uno fallando las cuatro aserciones — la fila
// borrada, el texto afirmando el borrado, y el delta de filas en −1 donde debía ser 0. Con
// el código real, 12/12 en verde contra la Supabase de producción.
//
// LO QUE ESTE HARNESS NO PUEDE GARANTIZAR, para que nadie lo lea como más ancho de lo que es:
// cada delete de `transacciones` dispara `trg_audit_borrado`, que copia la fila a
// `borrados_auditoria` — y la migración 055 le revoca todo a `service_role` menos SELECT, así
// que esas filas NO se pueden limpiar. Son ~12 por corrida, con el comercio QA_BORRADO_PROBE
// como marca. Es el precio de ejercitar el borrado real contra la DB real.
//
// Correr:  node qa-e2e/qa-borrado-confirmacion.mjs   (desde app/)

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (m) => require(path.join(appRoot, m));

const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));
const log = R('lib/logger.js');
const { hoyPeru, ayerPeru, ultimoDiaMes } = R('lib/dates.js');
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = R('lib/constants.js');
const { validarMonto, normalizarCategoria } = R('lib/validators.js');
const { formatFecha } = R('lib/formatters.js');
const T = R('services/transactions.js');
const { getHandler } = R('handlers/intent-registry.js');

const QA_USER_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const MARCA = 'QA_BORRADO_PROBE';

// El orden importa y no es estético: los cuatro casos que NO deben borrar van primero. Si la
// guarda estuviera rota, el harness lo dice antes de haber borrado nada, y el reporte no
// queda contaminado por los dos casos que sí borran.
const CASOS = [
  { msg: 'Quiero reiniciar', borra: false,
    porque: 'el caso real del 17-ago: el clasificador lo mandó a undo y se borró un sueldo' },
  { msg: 'empecemos de cero', borra: false,
    porque: 'misma familia léxica, sin ninguna palabra de borrar' },
  { msg: 'quiero eliminar mi cuenta', borra: false,
    porque: 'el más caro de confundir: dice "eliminar", pero el destino correcto es la baja de cuenta' },
  { msg: 'borra todos mis datos', borra: false,
    porque: 'dice "borra" y habla de la cuenta: la guarda tiene que mirar el SUJETO, no solo la acción' },
  { msg: 'borra el último', borra: true,
    porque: 'la orden explícita que el mensaje de confirmación le pide a la persona' },
  { msg: 'deshaz eso, me equivoqué', borra: true,
    porque: 'la guarda no puede romper al que sí pide borrar' },
];

const PUERTAS = ['deshacer_ultimo', 'eliminar_transaccion'];

// El `break` de adentro solo corta los CASOS: sin esta bandera el bucle exterior seguía con la
// segunda puerta, re-sembrando sobre un estado ya declarado contaminado — el mensaje decía
// "abortando" y el código no abortaba. Vive en el módulo porque el handler de señal la iza.
let abortado = false;

const fallos = [];
function check(nombre, ok, detalle) {
  console.log((ok ? '  OK   ' : '  FALLA') + '  ' + nombre + (detalle ? '  → ' + detalle : ''));
  if (!ok) fallos.push(nombre + (detalle ? ': ' + detalle : ''));
}

async function limpiar() {
  await supabase.from('transacciones').delete().eq('usuario_id', QA_USER_ID).eq('comercio', MARCA);
  const { data: snaps } = await supabase.from('transacciones_eliminadas').select('id, snapshot')
    .eq('usuario_id', QA_USER_ID);
  for (const s of snaps || []) {
    if (s.snapshot && s.snapshot.comercio === MARCA) {
      await supabase.from('transacciones_eliminadas').delete().eq('id', s.id);
    }
  }
  await supabase.from('gmail_excluidos').delete().eq('usuario_id', QA_USER_ID).eq('descripcion_original', MARCA);
}

/** Cuántas transacciones tiene el usuario QA ahora mismo. */
async function contarTx() {
  const { count, error } = await supabase.from('transacciones')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', QA_USER_ID);
  if (error) throw new Error('no pude contar las transacciones del usuario QA: ' + error.message);
  return count;
}

async function sembrar(monto) {
  const { data, error } = await supabase.from('transacciones').insert({
    usuario_id: QA_USER_ID,
    monto, monto_pen: monto, moneda: 'PEN', tipo_cambio: 1,
    comercio: MARCA, categoria: 'Otros', tipo: 'gasto',
    fecha: hoyPeru(), descripcion_original: MARCA,
  }).select().single();
  if (error || !data) throw new Error('no pude sembrar la tx de prueba: ' + (error && error.message));
  return data;
}

async function main() {
  const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', QA_USER_ID).single();
  if (!usuario) { console.error('Usuario QA no encontrado'); process.exit(1); }

  const hoyParts = hoyPeru().split('-');
  const ctx = {
    supabase, log,
    hoyPeru, fechaHoyPeru: () => hoyPeru(), fechaAyerPeru: () => ayerPeru(), formatFecha, ultimoDiaMes,
    mesActual: parseInt(hoyParts[1], 10), anioActual: parseInt(hoyParts[0], 10),
    CATEGORIAS_VALIDAS, CATEGORIA_MAP, validarMonto, normalizarCategoria,
    ...T,
  };

  await limpiar();

  let monto = 11.11;
  for (const puerta of PUERTAS) {
    if (abortado) break;
    const handler = getHandler(puerta);
    if (!handler) { console.error(puerta + ' sin handler registrado'); await limpiar(); process.exit(1); }

    for (const caso of CASOS) {
      if (abortado) break;
      const etiqueta = puerta + '  «' + caso.msg + '»';
      console.log('\n' + etiqueta + '   (' + (caso.borra ? 'DEBE borrar' : 'NO debe borrar') + ')');
      console.log('  ' + caso.porque);

      monto = Math.round((monto + 1.01) * 100) / 100;
      const sembrada = await sembrar(monto);

      // La aserción de abajo mira MI fila, así que antes hay que probar que mi fila es la
      // que el handler va a mirar. Sin esto, un caso destructivo que apunte a otra fila
      // pasaría en verde (la mía sigue viva) habiendo borrado un gasto que no es el sujeto
      // de la prueba. Es la misma lección que dejó `qa-bsuid-media` contando el total de
      // salientes en vez de mirar el destinatario.
      // Se lee DOS veces, y la segunda pegada al `await handler(...)`. El handler vuelve a
      // consultar `obtenerUltimaTransaccion` por su cuenta, así que entre mi comprobación y su
      // consulta hay una ventana: una fila insertada ahí (el cron de Gmail, otra sesión) hace
      // que los casos destructivos borren ESA fila y no la mía. Falla ruidoso —el delta sale
      // −1 y "la fila se borró" da FALSE— pero para cuando lo dice ya borró un gasto ajeno, y
      // el `delete` del handler va solo por `id`, así que `qa-guard` lo deja pasar. Dos
      // lecturas seguidas no cierran la ventana del todo (nada lo hace desde afuera del
      // handler), pero la reducen a milisegundos en vez de al tiempo del conteo previo.
      const ultima = await T.obtenerUltimaTransaccion(QA_USER_ID);
      if (!ultima || ultima.id !== sembrada.id) {
        check('la tx sembrada es la última del usuario QA', false,
          'la última es ' + (ultima ? ultima.id + ' (' + ultima.comercio + ')' : 'ninguna') +
          ' — otro proceso escribió sobre el usuario QA; abortando para no borrar lo que no es mío');
        abortado = true;
        break;
      }

      const antes = await contarTx();
      const reCheck = await T.obtenerUltimaTransaccion(QA_USER_ID);
      if (!reCheck || reCheck.id !== sembrada.id) {
        check('la tx sembrada sigue siendo la última justo antes de despachar', false,
          'cambió entre el conteo y el despacho; abortando sin llamar al handler');
        abortado = true;
        break;
      }
      const res = await handler({
        intencion: puerta, msg: caso.msg, datos: {}, usuario, from: usuario.whatsapp, ctx,
      });
      const despues = await contarTx();

      const { data: viva } = await supabase.from('transacciones').select('id').eq('id', sembrada.id);
      const sigueViva = !!(viva && viva.length === 1);

      // El veredicto sale del ESTADO de la DB, no del texto. Un mensaje que dice "no borré"
      // sobre una fila que ya no está es exactamente el fallo que este harness busca.
      if (caso.borra) {
        check('la fila se borró', !sigueViva, sigueViva ? 'sigue en `transacciones`' : 'ya no está');
        check('el mensaje lo confirma', /elimin|deshech/i.test(String(res || '')),
          JSON.stringify(String(res || '').slice(0, 90)));
      } else {
        check('la fila SIGUE VIVA', sigueViva, sigueViva ? '' : 'SE BORRÓ un gasto que nadie pidió borrar');
        check('el mensaje pide la orden explícita', /borra el último/i.test(String(res || '')),
          JSON.stringify(String(res || '').slice(0, 90)));
        check('el mensaje NO afirma un borrado', !/deshech|^listo\. elimin/i.test(String(res || '')),
          JSON.stringify(String(res || '').slice(0, 90)));
      }

      // El delta cubre lo que la aserción por id no puede ver: un borrado que se llevó otra
      // fila además (o en vez) de la mía. `-1` exacto en los casos destructivos, `0` en los
      // demás.
      const deltaEsperado = caso.borra ? -1 : 0;
      check('no tocó ninguna otra fila del usuario', (despues - antes) === deltaEsperado,
        'transacciones ' + antes + ' → ' + despues + ' (esperado ' + deltaEsperado + ')');

      // Si la fila quedó viva, la próxima siembra dejaría dos y `obtenerUltimaTransaccion`
      // apuntaría a la nueva: cada caso arranca de cero a propósito.
      if (sigueViva) await supabase.from('transacciones').delete().eq('id', sembrada.id);
    }
  }

  await limpiar();
  console.log('\nLimpieza hecha (tx + snapshots ' + MARCA + ' borrados).');

  if (fallos.length) {
    console.log('\n' + fallos.length + ' FALLA(S):');
    fallos.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nTodo OK: las dos puertas piden la orden explícita ante una frase ambigua, y borran cuando se les pide.');
  process.exit(0);
}

// El Ctrl-C NO limpia acá adentro, y la primera versión de este handler sí lo hacía: era
// estrictamente PEOR que el problema que arreglaba. `process.once(sig, async () => { await
// limpiar(); ... })` corre CONCURRENTE con `main()` —el primer await cede el control y main
// sigue avanzando—, así que un Ctrl-C entre el re-chequeo y el despacho de un caso destructivo
// borraba la fila QA_BORRADO_PROBE, el handler consultaba `obtenerUltimaTransaccion` por su
// cuenta, le salía la transacción REAL más reciente del usuario QA, y la borraba por id. La
// barrera lo deja pasar (salió de un SELECT fijado a un usuario permitido). O sea: destruía
// una fila que el harness no sembró, justo lo que su docblock promete que nunca hace.
//
// La señal solo IZA LA BANDERA. `main()` corta en el próximo borde de caso y llega a su propio
// `limpiar()`, que es el único punto donde no hay un handler a mitad de camino. Una fila
// huérfana por un segundo Ctrl-C se auto-cura igual: `limpiar()` corre PRIMERO en la próxima
// corrida.
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    if (abortado) process.exit(130);   // segunda vez: salida dura, sin limpiar
    abortado = true;
    console.log(String.fromCharCode(10) + senal + ': corto al terminar el caso en curso (otra vez = salida dura).');
  });
}

main().catch(async (e) => {
  console.error(e);
  try { await limpiar(); } catch {}
  process.exit(1);
});
