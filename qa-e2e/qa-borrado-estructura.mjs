// ¿Sigue en pie la estructura del borrado de cuenta?
//
// ES EL HERMANO BARATO DE `qa-borrado-cuenta.mjs`, y la división entre los dos es deliberada.
//
//   · `qa-borrado-cuenta` prueba que el borrado BORRA. Para eso tiene que sembrar: dos usuarios
//     reales, una identidad de auth y un objeto de Storage en producción. Y cada corrida deja
//     ~16 filas en `borrados_auditoria` — medido el 18-ago: 98 filas en un día de trabajo,
//     sobre una tabla de 727. Esa tabla es la caja negra del incidente del 01-ago y la 073 la
//     hizo, a propósito, imposible de limpiar desde el backend. A cadencia diaria el residuo de
//     QA la termina dominando. Por eso ese harness NO va al canary: se corre a mano al tocar el
//     borrado, y su disparador está escrito en `qa-e2e/README.md`.
//
//   · ESTE no siembra NADA. Es una llamada de solo lectura (`inventario_borrado_cuenta`,
//     migración 074) y una comparación contra una línea base congelada. Por eso sí va al canary.
//
// QUÉ VIGILA, y por qué justo eso. El criterio del canary es "lo que se rompe SIN un commit"
// (memoria `feedback_criterio_canary_diario`). El código del borrado no cambia sin commit; el
// ESQUEMA sí — `app/CLAUDE.md` documenta 8 migraciones aplicadas desde la consola que nunca
// pasaron por el árbol, y dos que ni siquiera dejaron fila en el ledger. Las cuatro formas:
//
//   1. Aparece una tabla nueva con FK a `usuarios`. El `residual` de `borrar_cuenta_total` la
//      delata, pero SOLO si alguien corre un borrado. Acá se ve al día siguiente.
//   2. Cambia un `ON DELETE` (CASCADE → SET NULL deja filas huérfanas apuntando a la lápida).
//   3. Alguien redefine las funciones desde el dashboard, o les mueve los permisos. En especial
//      `purgar_auditoria_usuario`, que NO debe ser ejecutable por `service_role`: la única
//      puerta al rastro de borrados es una baja de cuenta completa, y eso avisa al admin.
//   4. Alguien le da `DELETE` a `service_role` sobre las tablas append-only, o saca el trigger.
//      Cualquiera de las dos deshace el invariante "o están las filas, o está escrito por qué
//      no están".
//
// LO QUE NO VIGILA: que el borrado funcione. Un `DELETE` que se borre de la función cambia el
// hash y sale por acá, pero saber si lo que queda BORRA de verdad es el otro harness.
//
// Correr:  node qa-e2e/qa-borrado-estructura.mjs   (desde app/)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// `fetch` pelado contra PostgREST, sin `supabase-js` y sin `qa-guard`.
//
// Sin la barrera porque acá no hay una sola escritura: es una llamada de lectura al catálogo.
// Y sin el cliente por un motivo medido: con `supabase-js`, este harness terminaba imprimiendo
// todo en verde y salía con **127**, por una assertion de libuv en Windows
// (`!(handle->flags & UV_HANDLE_CLOSING)`) al cerrar el socket que el cliente deja abierto. El
// canary lee el exit code, así que eso es un rojo permanente con todos los checks pasando —
// justo el modo de fallo que un guard no puede tener. Una sola request no necesita un cliente.
async function inventario() {
  const url = process.env.SUPABASE_URL + '/rest/v1/rpc/inventario_borrado_cuenta';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_KEY,
      authorization: 'Bearer ' + process.env.SUPABASE_KEY,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) return { data: null, error: new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200)) };
  return { data: await res.json(), error: null };
}

// ─── La línea base ───────────────────────────────────────────────────────────
//
// Cada FK que cuelga de `usuarios`, con su `ON DELETE` y con lo que el borrado HACE con ella.
// `c` = CASCADE, `n` = SET NULL, `a` = NO ACTION.
//
//   'borra'    → tras el borrado esa columna queda en 0 filas para el usuario.
//   'conserva' → la fila SOBREVIVE apuntando a la lápida, y eso es una DECISIÓN: o es
//                obligación contable (`pagos`), o es el hash que protege el cupo de Google
//                (`gmail_cuentas`), o es plata que vive dentro de un contenedor compartido con
//                otra persona (espacios, metas, gastos) y no es nuestra para borrarla.
//
// Las entradas 'conserva' son EXACTAMENTE la allowlist del `residual` en la migración vigente.
// Si agregás una tabla, clasificala acá Y en el SQL, o el borrado la va a dejar viva en
// silencio — el `residual` solo mira las que NO están en su allowlist.
const INVENTARIO = {
  'categorias_usuario.usuario_id':    ['c', 'borra'],
  'conversaciones.usuario_id':        ['c', 'borra'],
  'deudas.usuario_id':                ['c', 'borra'],
  'errores.usuario_id':               ['c', 'borra'],
  'gasto_participantes.usuario_id':   ['c', 'conserva'],
  'gastos_compartidos.creador_id':    ['c', 'conserva'],
  'gmail_cuentas.usuario_id':         ['c', 'conserva'],
  'gmail_excluidos.usuario_id':       ['c', 'borra'],
  'logros.usuario_id':                ['c', 'borra'],
  'meta_aportes.usuario_id':          ['c', 'conserva'],
  'meta_participantes.usuario_id':    ['c', 'borra'],
  'metas_ahorro.usuario_id':          ['c', 'conserva'],
  'neto_scores.user_id':              ['c', 'borra'],
  'nlp_errors.usuario_id':            ['n', 'borra'],
  'notificaciones.usuario_id':        ['c', 'borra'],
  'notification_deliveries.usuario_id': ['c', 'borra'],
  'pagos.usuario_id':                 ['c', 'conserva'],
  'presupuestos.usuario_id':          ['c', 'borra'],
  'recurrentes_overrides.usuario_id': ['c', 'borra'],
  'referidos.referido_id':            ['n', 'borra'],
  'referidos.referrer_id':            ['c', 'borra'],
  'reglas_comercio.usuario_id':       ['c', 'borra'],
  'shared_spaces.created_by':         ['c', 'conserva'],
  'space_expenses.paid_by':           ['c', 'conserva'],
  'space_members.user_id':            ['c', 'borra'],
  'space_settlements.from_user':      ['c', 'conserva'],
  'space_settlements.to_user':        ['c', 'conserva'],
  'spending_alerts.user_id':          ['c', 'borra'],
  'survey_events.user_id':            ['c', 'borra'],
  'tickets_soporte.usuario_id':       ['c', 'borra'],
  'transacciones.usuario_id':         ['c', 'borra'],
  'transacciones_eliminadas.usuario_id': ['c', 'borra'],
};

// El cuerpo VIVO de las dos funciones. Cambia con cualquier edición, incluido un comentario, y
// eso es a propósito: para la función que borra cuentas de forma irreversible, un cambio tiene
// que costar una línea de reconocimiento explícito acá. Si vos aplicaste la migración, actualizá
// el hash en el mismo commit.
const FUNCIONES_ESPERADAS = {
  borrar_cuenta_total:      { md5: 'a2d74e70c83fc9724598ae1d34f50ed6', ejecutaServiceRole: true },
  purgar_auditoria_usuario: { md5: 'b65994ad17ffbd25ce7b6c713f3ff961', ejecutaServiceRole: false },
};

const TRIGGERS_ESPERADOS = ['deuda_abonos', 'deudas', 'transacciones'];

/**
 * El cuerpo de una función tal como lo describe el REPO, con su md5 comparable contra el de la
 * base. Mismo criterio de "vigente" que `tests/services/account-deletion.test.js`: el archivo de
 * nombre más alto que la redefine, porque las migraciones son append-only.
 *
 * Dos detalles que hacen que el md5 sea comparable y no una cadena parecida:
 *   · Postgres guarda el cuerpo con LF; el working copy de este repo es CRLF (autocrlf). Sin
 *     normalizar, TODOS los md5 difieren y el check sería ruido permanente.
 *   · el cuerpo es lo que va ENTRE los dólar-quote, sin incluirlos: `AS $fn$\nDECLARE…END;\n$fn$`
 *     produce un `prosrc` que empieza en `\nDECLARE` y termina en `END;\n`.
 */
function cuerpoEnMigraciones(nombre) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  let archivos = [];
  try {
    archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch (e) {
    return { archivo: null, md5: null, error: e.message };
  }
  // `CREATE OR REPLACE`, no `FUNCTION public.<nombre>(` a secas: esa forma también aparece en el
  // `REVOKE`/`GRANT` del final del archivo, y un `lastIndexOf` sobre ella caía ahí — donde no hay
  // ningún dólar-quote después. Daba `md5: null`, o sea el mismo FALLA que un drift real, con un
  // mensaje que mandaba a volcar de nuevo un archivo que ya estaba bien.
  const marca = 'CREATE OR REPLACE FUNCTION public.' + nombre + '(';
  for (let i = archivos.length - 1; i >= 0; i--) {
    const src = fs.readFileSync(path.join(dir, archivos[i]), 'utf-8').replace(/\r\n/g, '\n');
    const desde = src.lastIndexOf(marca);
    if (desde === -1) continue;
    // El dólar-quote que abre DESPUÉS del nombre, sea `$fn$`, `$function$` o `$$`.
    const m = src.slice(desde).match(/\bAS\s+(\$[A-Za-z_]*\$)/);
    if (!m) return { archivo: archivos[i], md5: null, error: 'no encontré el dólar-quote' };
    const ini = desde + src.slice(desde).indexOf(m[1]) + m[1].length;
    const fin = src.indexOf(m[1], ini);
    if (fin === -1) return { archivo: archivos[i], md5: null, error: 'dólar-quote sin cierre' };
    const cuerpo = src.slice(ini, fin);
    return { archivo: archivos[i], md5: crypto.createHash('md5').update(cuerpo, 'utf8').digest('hex') };
  }
  return { archivo: null, md5: null };
}

const fallos = [];
const check = (nombre, ok, detalle) => {
  if (ok) { console.log('  ok  ' + nombre); return; }
  fallos.push(nombre + (detalle ? ' — ' + detalle : ''));
  console.log('  FALLA  ' + nombre + (detalle ? ' — ' + detalle : ''));
};

async function main() {
  const { data: inv, error } = await inventario();
  // Un fallo de lectura NO es "todo bien". Sin el inventario este harness no puede afirmar
  // nada, y salir en verde seria decir que se verifico algo que no se miro.
  if (error) {
    console.error('\nNo se pudo leer el inventario: ' + error.message);
    console.error('Si la funcion no existe, falta aplicar migrations/074_inventario_borrado.sql.');
    process.exitCode = 2;
    return;
  }
  if (!inv || !Array.isArray(inv.fks)) {
    console.error('\nEl inventario vino con una forma inesperada: ' + JSON.stringify(inv));
    process.exitCode = 2;
    return;
  }

  console.log('\n=== Las FK que cuelgan de `usuarios` ===');
  const vivo = new Map(inv.fks.map((f) => [f.ref, f.on_delete]));
  const base = new Map(Object.entries(INVENTARIO).map(([ref, [od]]) => [ref, od]));

  const nuevas = [...vivo.keys()].filter((r) => !base.has(r));
  const idas = [...base.keys()].filter((r) => !vivo.has(r));
  const cambiadas = [...vivo.entries()]
    .filter(([r, od]) => base.has(r) && base.get(r) !== od)
    .map(([r, od]) => r + ' (' + base.get(r) + ' → ' + od + ')');

  check('no hay FK NUEVAS sin clasificar', nuevas.length === 0,
    nuevas.join(', ') + ' · clasificala en INVENTARIO y en la allowlist del `residual`, o el borrado la va a dejar viva');
  check('no desapareció ninguna FK', idas.length === 0,
    idas.join(', ') + ' · si borraste la tabla, sacala de INVENTARIO');
  check('ningún ON DELETE cambió', cambiadas.length === 0, cambiadas.join(', '));
  console.log('  (' + vivo.size + ' FK vivas, ' +
    Object.values(INVENTARIO).filter(([, k]) => k === 'conserva').length + ' clasificadas como `conserva`)');

  console.log('\n=== Las funciones del borrado ===');
  for (const [nombre, esperado] of Object.entries(FUNCIONES_ESPERADAS)) {
    const f = inv.funciones && inv.funciones[nombre];
    if (!f) { check(nombre + ' existe', false, 'no está en el esquema'); continue; }
    check(nombre + ': sigue siendo SECURITY DEFINER de postgres',
      f.secdef === true && f.owner === 'postgres', 'secdef=' + f.secdef + ' owner=' + f.owner);
    const tieneSR = String(f.acl || '').includes('service_role=X');
    check(nombre + ': ' + (esperado.ejecutaServiceRole ? 'ES' : 'NO es') + ' ejecutable por service_role',
      tieneSR === esperado.ejecutaServiceRole, 'acl=' + f.acl);
    check(nombre + ': el cuerpo no cambió',
      f.src_md5 === esperado.md5,
      'vivo=' + f.src_md5 + ' esperado=' + esperado.md5 +
      ' · si vos aplicaste la migración, actualizá el hash acá EN EL MISMO COMMIT; si no, alguien la redefinió fuera del repo');

    // Y que el ARCHIVO del repo describa la función que corre. Es otra pregunta que la de
    // arriba y hasta el 03-sep-2026 nadie la hacía: el md5 vivo estaba sincronizado con esta
    // constante y aun así `073d_metas_gastos_nullable.sql` tenía **9896** caracteres contra los
    // **7768** del cuerpo vivo. O sea que el canary decía "nadie la redefinió" —cierto— mientras
    // el archivo del que el CLAUDE.md manda partir describía otra función.
    //
    // El daño no es hoy, es el próximo que la toque: partir del archivo desplegaba una versión
    // distinta, con el diff leyéndose como si solo agregara el cambio nuevo, sobre el borrado de
    // cuenta. Se cerró con el espejo `082_borrar_cuenta_total_espejo.sql` — y con esta línea,
    // porque un espejo que nadie compara vuelve a divergir el mes que viene.
    const enRepo = cuerpoEnMigraciones(nombre);
    check(nombre + ': el archivo del repo describe la función que CORRE',
      enRepo.md5 === f.src_md5,
      enRepo.archivo
        ? ('archivo=' + enRepo.archivo + ' md5=' + enRepo.md5 + ' vs vivo=' + f.src_md5 +
           ' · el repo y la base divergieron: volcá el `prosrc` vivo a una migración nueva (append-only, no edites la vieja)')
        : 'ninguna migración define esta función: el guard de tests/services/account-deletion.test.js está mirando el vacío');
  }

  console.log('\n=== El rastro de borrados sigue siendo append-only ===');
  for (const tabla of ['borrados_auditoria', 'purgas_auditoria']) {
    const g = (inv.grants_auditoria && inv.grants_auditoria[tabla]) || [];
    check(tabla + ': service_role solo tiene SELECT',
      g.length === 1 && g[0] === 'SELECT',
      'tiene ' + JSON.stringify(g) + ' · con INSERT/UPDATE/DELETE el backend puede reescribir el rastro del incidente del 01-ago');
  }

  const trig = (inv.triggers_auditoria || []).slice().sort();
  check('el trigger de auditoría sigue en las tres tablas',
    JSON.stringify(trig) === JSON.stringify(TRIGGERS_ESPERADOS),
    'está en ' + JSON.stringify(trig) + ' y se esperaba ' + JSON.stringify(TRIGGERS_ESPERADOS));
}

// `process.exitCode` y NO `process.exit()`. Medido en este mismo harness: con `process.exit()`
// imprimía los 10 checks en verde y salía con **127**, por una assertion de libuv en Windows
// (`!(handle->flags & UV_HANDLE_CLOSING)`) al matar el proceso con el socket HTTP todavía
// cerrándose. El canary lee el exit code, así que eso es un rojo permanente con todo pasando —
// exactamente el modo de fallo que un guard no puede tener. Asignando el código, Node drena el
// loop y sale solo con el valor correcto.
main()
  .then(() => {
    if (fallos.length) {
      console.log('\n' + fallos.length + ' FALLA(S):');
      for (const f of fallos) console.log('  · ' + f);
      process.exitCode = 1;
      return;
    }
    console.log('\nLa estructura del borrado sigue en pie. (Que BORRE lo prueba qa-borrado-cuenta.mjs)');
  })
  .catch((e) => { console.error('\nERROR: ' + (e && e.message ? e.message : e)); process.exitCode = 2; });
