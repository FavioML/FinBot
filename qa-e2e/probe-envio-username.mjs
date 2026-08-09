// ¿Se le puede escribir a alguien que activó un username de WhatsApp, usando el número que
// le guardamos ANTES?
//
// Toda la maquinaria del camino silencioso (services/registro-silencioso.js) asume que NO.
// Pero lo que está medido es otra cosa: que **direccionar por BSUID** falla (probado contra
// v19.0, v23.0, v24.0 y v25.0 el 08-ago-2026). El número guardado es una vía distinta y nadie
// la probó. Si funciona, sobra la mitad de esa maquinaria: al usuario se le puede confirmar el
// gasto, pedirle la captura correcta y avisarle que su Pro quedó activo.
//
// La medición pasiva NO alcanza, y se intentó primero (09-ago-2026): hacen falta las dos cosas
// a la vez —saber que alguien tiene username activo Y tener su número— y hoy esa intersección
// está VACÍA. Los 7 mensajes reales sin `from` (01, 05, 08 y 09-ago) vinieron todos de BSUIDs
// que no están en `usuarios`, y ninguno correlaciona con un usuario que haya dejado de escribir
// en esa ventana. O sea: los 30 usuarios con BSUID mapeado no han activado username todavía, y
// los que lo activaron no los conocemos.
//
// Por eso hace falta provocarlo: un número NUESTRO con username activo, que le escriba al bot
// (así queda su BSUID aprendido y se abre la ventana de 24h de Meta) y después correr esto.
//
//   1. Activá un username en el WhatsApp del número de prueba.
//   2. Desde ese número, escribile cualquier cosa al bot (+51 933 014 505).
//      Verificá en los logs que llegó SIN `from` — si trae número, el username no está activo
//      y la prueba no mide nada.
//   3. node qa-e2e/probe-envio-username.mjs <numero> --confirmar
//
// MANDA UN WHATSAPP DE VERDAD. Por eso exige `--confirmar` y por eso el texto es presentable:
// si termina en el teléfono de una persona, tiene que poder leerlo sin asustarse.
//
// Los tres veredictos, y el del medio es el que más engaña:
//   ENTREGADO       → la premisa es FALSA. Se le puede escribir. Hay que rever el diseño.
//   FALLÓ (code)    → la premisa se sostiene, y ahora con un número de error concreto.
//   SIN CALLBACK    → no concluye NADA. Un 200 de /messages nunca probó entrega: Meta encola
//                     y el fallo llega después por el callback. Ya pasó dos veces en este
//                     trabajo que un 200 sobre un destinatario inexistente casi produjo una
//                     conclusión falsa.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (m) => path.join(appRoot, m);

// Este probe solo LEE por el cliente (el guard deja pasar las lecturas). La única escritura
// —la fila de `notification_deliveries`— la hace `enviarWhatsapp` con su propio cliente, que
// queda fuera de la barrera: es el límite conocido de qa-guard, no un bypass. Va igual porque
// la barrera es la política del repo y porque apuntar este probe a un usuario REAL es
// exactamente el escenario para el que se escribió.
const supabase = instalarGuard(require, R('lib/db.js'));
const { enviarWhatsapp } = require(R('lib/whatsapp.js'));

const TIPO = 'probe_envio_username';
  const ESPERA_MS = 90000;   // el `delivered` suele llegar en segundos; el `failed` a veces tarda

async function main() {
  const [numeroArg, ...flags] = process.argv.slice(2);
  const confirmado = flags.includes('--confirmar');

  if (!numeroArg) {
    console.log('Uso: node qa-e2e/probe-envio-username.mjs <numero> --confirmar');
    console.log('Antes: activá un username en ese WhatsApp y escribile al bot desde ahí.');
    return 2;
  }

  const numero = numeroArg.replace(/\D/g, '');
  if (!numero) { console.log('Número inválido: ' + numeroArg); return 2; }

  const { data: usuario, error } = await supabase.from('usuarios')
    .select('id, whatsapp, bsuid, nombre, plan').eq('whatsapp', numero).maybeSingle();
  if (error) { console.log('No se pudo leer el usuario: ' + error.message); return 2; }
  if (!usuario) {
    console.log('Ese número no está en `usuarios`. El probe necesita un usuario real para poder');
    console.log('mirar su fila de entrega — y sin fila previa tampoco tendríamos su número.');
    return 2;
  }

  console.log('usuario:  ' + usuario.id + '  (' + (usuario.nombre || 'sin nombre') + ', plan ' + usuario.plan + ')');
  console.log('número:   ' + usuario.whatsapp);
  console.log('bsuid:    ' + (usuario.bsuid || '— NO mapeado'));
  if (!usuario.bsuid) {
    console.log('\nSin BSUID aprendido no hay evidencia de que este número tenga username activo,');
    console.log('así que un `delivered` acá no probaría nada. Escribile al bot primero.');
    return 2;
  }

  if (!confirmado) {
    console.log('\nEsto MANDA UN WHATSAPP REAL a ese número. Volvé a correrlo con --confirmar.');
    return 2;
  }

  const mensaje = 'Hola 👋 Soy Neto. Esto es una prueba técnica de entrega, no necesitas responder nada. ' +
    'Si te llegó, todo funciona bien de nuestro lado. Gracias por la paciencia.';

  const r = await enviarWhatsapp(numero, mensaje, { tipo: TIPO, usuarioId: usuario.id });
  console.log('\nenviarWhatsapp →', JSON.stringify(r));

  // `is_test_user` devuelve {ok:true, skipped:'test_user'} SIN llamar a Meta. Sin este chequeo,
  // el probe seguiría al poll y saldría "SIN CALLBACK", que se lee como "no concluye" cuando en
  // realidad no se envió nada. Un ok:true que no salió es la peor forma de no medir.
  if (r && r.skipped) {
    console.log('\nVEREDICTO: NO SE ENVIÓ NADA (skipped: ' + r.skipped + '). La prueba no midió nada.');
    console.log(r.skipped === 'test_user'
      ? 'Ese número está marcado is_test_user, así que lib/whatsapp.js saltea el envío a Meta.'
      : 'El número está vacío en la fila del usuario.');
    return 2;
  }

  // 131047 = fuera de la ventana de 24h. Es un rechazo por CADENCIA, no por identidad: no dice
  // nada sobre el username, y confundirlo con "no se le puede escribir" cerraría la pregunta con
  // la respuesta equivocada.
  if (r && r.ok === false && r.code === 131047) {
    console.log('\nVEREDICTO: VENTANA DE 24h CERRADA (131047). NO MIDE LO QUE QUERÉS.');
    console.log('Pedile al número de prueba que le escriba al bot y volvé a correr esto en el momento.');
    return 2;
  }

  if (!r || r.ok === false) {
    console.log('\nVEREDICTO: RECHAZADO EN EL ENVÍO — code ' + (r && r.code) + ' (' + (r && r.error) + ').');
    console.log('Meta no lo aceptó ni para encolar. La premisa se sostiene, y con un error concreto.');
    return 0;
  }

  // El 200 solo dice que Meta lo encoló. Lo que decide es el callback.
  console.log('\nEncolado (wamid ' + r.msgId + '). Esperando el callback de status (hasta ' + (ESPERA_MS / 1000) + 's)...');
  const t0 = Date.now();
  let fila = null;
  for (;;) {
    const { data } = await supabase.from('notification_deliveries')
      .select('wamid, estado, delivered_at, read_at, failed_at, fail_code, error, created_at')
      .eq('usuario_id', usuario.id).eq('tipo', TIPO)
      .order('created_at', { ascending: false }).limit(1);
    fila = data && data[0];
    if (fila && (fila.delivered_at || fila.failed_at || fila.read_at)) break;
    if (Date.now() - t0 > ESPERA_MS) break;
    await new Promise((res) => setTimeout(res, 3000));
  }

  console.log('\nfila de entrega:', JSON.stringify(fila, null, 2));

  if (fila && (fila.delivered_at || fila.read_at)) {
    console.log('\nVEREDICTO: **ENTREGADO**.');
    console.log('La premisa del camino silencioso es FALSA: a un usuario con username activo SÍ');
    console.log('se le puede escribir al número que le guardamos. Hay que rever el diseño de');
    console.log('services/registro-silencioso.js y la sección BSUID del CLAUDE.md.');
  } else if (fila && fila.failed_at) {
    console.log('\nVEREDICTO: FALLÓ — code ' + fila.fail_code + ' (' + fila.error + ').');
    console.log('La premisa se sostiene, y ahora con un número de error en vez de una suposición.');
  } else {
    console.log('\nVEREDICTO: SIN CALLBACK en ' + (ESPERA_MS / 1000) + 's. NO CONCLUYE NADA.');
    console.log('El 200 de /messages no prueba entrega. Revisá la fila más tarde:');
    console.log("  select * from notification_deliveries where tipo = '" + TIPO + "' order by created_at desc;");
  }
  return 0;
}

// `process.exit()` con el cliente de Supabase todavía abierto revienta libuv en Windows
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") y **se lleva puesto el código de
// salida**: medido, un `process.exit(2)` salía como 127. Un probe cuyo exit code miente no
// sirve para nada. Por eso main() DEVUELVE el código y se sale por `exitCode`, dejando que el
// proceso termine solo.
process.exitCode = await main();
