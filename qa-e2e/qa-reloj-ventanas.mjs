// ¿La base sigue guardando sus timestamps sin zona en UTC?
//
// EL SUPUESTO QUE VIGILA. `usuarios.created_at` es `timestamp WITHOUT time zone`: no guarda
// offset, así que el instante que representa depende de la zona en que se escribió. El default
// de la columna evalúa `now()` en la zona de la SESIÓN que hace el INSERT, y para todo lo que
// entra por PostgREST esa zona es el GUC `TimeZone` de la base.
//
// QUIÉN DEPENDE. `checkRecordatorioOnboarding` (cron/checks.js) arma la ventana de elegibilidad
// del nudge de primer gasto con `toISOString()` —UTC— y la compara contra esa columna con
// `.gte()` / `.lte()`. Es correcto SÓLO mientras las dos puntas hablen de la misma zona. Con el
// GUC en 'America/Lima' los `created_at` nuevos quedarían 5 horas por detrás de la ventana y el
// nudge le erraría a su población entera.
//
// POR QUÉ VA AL CANARY Y NO A LA SUITE. El criterio es "lo que se rompe SIN un commit"
// (memoria `feedback_criterio_canary_diario`), y esto se cambia desde el dashboard de Supabase.
// Un test unitario no puede verlo: los tests mockean Supabase, así que el GUC real no
// participa — `tests/cron/nudge-primer-gasto.test.js` pasa idéntico con la base en cualquier
// zona. Y el modo de falla es el peor de este cron: no lanza, no loguea error y su población
// se vacía en silencio. Ya pasó por otro motivo, y costó 12 días de silencio.
//
// EL GUARD NO LEE EL COMENTARIO NI EL NOMBRE DE LA ZONA: mide HECHOS. Comparar el nombre
// contra 'UTC' falla por los dos lados a la vez — rechaza 'Etc/UTC', que es la misma zona con
// otro nombre (falsa alarma, y una falsa alarma diaria termina en que nadie mira el rojo), y
// acepta 'Europe/London', que hoy vale 0 y en julio no (verde hasta que cambie el reloj).
//
// Por eso deciden dos cosas y el nombre de la zona sólo se imprime:
//   · `desfase_segundos` — lo que la columna GUARDARÍA contra lo que el cron COMPARA, ahora.
//   · los offsets de enero y julio — que la zona sea UTC TODO EL AÑO, no sólo hoy.
//
// LO QUE NO VIGILA: que el cron seleccione bien. Eso es el test unitario. Acá sólo se responde
// si la premisa sobre la que ese test razona sigue siendo cierta en producción.
//
// Correr:  node qa-e2e/qa-reloj-ventanas.mjs   (desde app/)

import 'dotenv/config';

// `fetch` pelado contra PostgREST, sin `supabase-js` y sin `qa-guard`, por lo mismo que
// `qa-borrado-estructura.mjs`: acá no hay una sola escritura, y el cliente deja un socket
// abierto que en Windows hace salir con 127 al cerrar (assertion de libuv) — o sea todos los
// checks en verde y exit code de fallo, que es el modo de falla que un guard no puede tener.
async function reloj() {
  const url = process.env.SUPABASE_URL + '/rest/v1/rpc/reloj_ventanas';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_KEY,
      authorization: 'Bearer ' + process.env.SUPABASE_KEY,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}

const fallos = [];
const check = (nombre, cond, detalle) => {
  console.log((cond ? 'OK   ' : 'FALLA') + '  ' + nombre + (detalle ? '  — ' + detalle : ''));
  if (!cond) fallos.push(nombre + (detalle ? ' — ' + detalle : ''));
  return cond;
};

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    // Sin credenciales NO se sale en verde. Un guard que se vuelve no-op cuando le falta una
    // variable es verde por vacuidad, que es peor que no tenerlo: nadie vuelve a mirarlo.
    throw new Error('faltan SUPABASE_URL / SUPABASE_KEY');
  }
  const r = await reloj();

  const tipo = r.tipo_usuarios_created_at;
  // Si la columna pasa a llevar zona, la dependencia DESAPARECE y este guard deja de decidir
  // nada. Se dice en voz alta en vez de seguir vigilando algo que ya no importa — un guard que
  // sobrevive a su motivo es el que después nadie sabe por qué está.
  if (tipo !== 'timestamp without time zone') {
    console.log('NOTA  `usuarios.created_at` ahora es ' + JSON.stringify(tipo) + ', no `timestamp'
      + ' without time zone`. La comparación del nudge ya no depende del GUC: este harness sobra'
      + ' y hay que borrarlo junto con la migración 075.');
  }
  check('`usuarios.created_at` sigue sin zona (por eso existe este guard)',
    tipo === 'timestamp without time zone', 'tipo=' + tipo);

  // `Number()` NO alcanza como saneo, y la diferencia decide el veredicto: `Number(null)`,
  // `Number('')` y `Number(false)` valen **0**, o sea que los tres checks de abajo saldrían
  // VERDES sobre una función redefinida que devuelva nulls. (Una clave AUSENTE sí es segura:
  // `Number(undefined)` es `NaN` y todo `NaN === 0` es false.) Este guard vive en el canary
  // justamente porque la función se puede redefinir desde el dashboard sin un commit — su
  // hermano `qa-borrado-estructura.mjs` le saca md5 al cuerpo vivo por el mismo motivo — así
  // que "me contestó cualquier cosa" tiene que ser rojo y no verde.
  const num = (campo) => {
    const v = r[campo];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      fallos.push('la RPC no devolvió un número en `' + campo + '`: ' + JSON.stringify(v)
        + ' — `reloj_ventanas` cambió de forma o la redefinieron');
      console.log('FALLA  `' + campo + '` no es un número  — ' + JSON.stringify(v));
      return null;
    }
    return v;
  };

  // EL CHECK QUE DECIDE. Es el hecho, no el nombre de la zona.
  const desfase = num('desfase_segundos');
  if (desfase !== null) {
    check('lo que la base GUARDA y lo que el cron COMPARA son el mismo instante',
      desfase === 0,
      'desfase=' + desfase + 's' + (desfase === 0 ? '' : ' (' + (desfase / 3600).toFixed(1)
        + 'h) — la ventana del nudge de onboarding está corrida por ese tanto'));
  }

  // El desfase de HOY no alcanza: una zona con horario de verano puede valer 0 medio año. Los
  // dos offsets a seis meses son lo que separa "es UTC" de "hoy da lo mismo que UTC".
  const ene = num('offset_enero_segundos');
  const jul = num('offset_julio_segundos');
  if (ene !== null && jul !== null) {
    check('la zona es UTC todo el año, no sólo hoy',
      ene === 0 && jul === 0, 'offset enero=' + ene + 's julio=' + jul + 's');
  }

  // NO es un check: no decide nada (ver el encabezado). Se imprime porque un rojo tiene que
  // decir qué tocar.
  //
  // OJO con la fuente, que la primera versión eligió mal: NO es `pg_settings.reset_val`. Ése
  // es lo que un `RESET` restauraría EN ESTA SESIÓN, así que ya absorbe el `ALTER ROLE` y el
  // `ALTER DATABASE` — medido acá: `statement_timeout` tiene `boot_val = 0` y
  // `reset_val = 120000`. Con esa fuente, un `ALTER ROLE ... SET TimeZone` sobre el rol de
  // PostgREST dejaba los dos valores IGUALES y este hint afirmaba que no había override justo
  // en el caso que venía a detectar. La tabla que contesta la pregunta es `pg_db_role_setting`.
  const overrides = Array.isArray(r.overrides_timezone) ? r.overrides_timezone : null;
  console.log('INFO  zona de la sesión=' + r.timezone_sesion + '  ·  overrides por rol/base: '
    + (overrides === null ? '(no se pudo leer)'
      : overrides.length === 0 ? 'ninguno (el valor viene del postgresql.conf)'
      : JSON.stringify(overrides)));
}

// `process.exitCode` y NO `process.exit()`, por lo mismo que su hermano: matar el proceso con
// el socket todavía cerrándose sale con 127 en Windows, con todos los checks en verde.
main()
  .then(() => {
    if (fallos.length) {
      console.log('\n' + fallos.length + ' FALLA(S):');
      for (const f of fallos) console.log('  · ' + f);
      console.log('\nQué hacer: el nudge de onboarding (cron/checks.js) compara `created_at`,'
        + ' que no lleva zona, contra una ventana en UTC. Volvé el GUC a UTC, o migrá la columna'
        + ' a `timestamptz` y borrá este harness con su migración 075.');
      process.exitCode = 1;
      return;
    }
    console.log('\nEl reloj de la base y el de las ventanas son el mismo.');
  })
  .catch((e) => { console.error('\nERROR: ' + (e && e.message ? e.message : e)); process.exitCode = 2; });
