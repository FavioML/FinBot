import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// TODOS los archivos que corren en un cron y leen `usuarios`, no solo `cron/checks.js`.
// La primera version de este guard miraba un archivo, y `services/survey-triggers.js` —que
// esta en las FUNCIONES de `cron/index.js`— quedaba afuera con una query SIN ningun filtro.
// Un guard que barre un solo arbol es la clase `barrido-de-un-solo-arbol` de DEFECTOS.
const FUENTES = [
  ['cron/checks.js', readFileSync(path.join(RAIZ, 'cron', 'checks.js'), 'utf-8')],
  ['services/survey-triggers.js', readFileSync(path.join(RAIZ, 'services', 'survey-triggers.js'), 'utf-8')],
  ['services/gmail-scanner.js', readFileSync(path.join(RAIZ, 'services', 'gmail-scanner.js'), 'utf-8')],
];
const CHECKS = FUENTES[0][1];

/**
 * Ningún cron le escribe a una cuenta que ya se borró.
 *
 * POR QUÉ EXISTE. Desde la migración 073 la fila de `usuarios` SOBREVIVE al borrado como
 * lápida — ancla registros compartidos que pertenecen a otras personas — pero conserva `plan`
 * y `premium_vence` intactos, porque quien pagó conserva su Pro (decisión lockeada). O sea que
 * un `select().eq('plan','premium')` sigue trayéndola. Y cada aviso que le sale REPUEBLA
 * `notificaciones` y `notification_deliveries`: el borrado se deshace solo, de a poco, hasta
 * la fecha de vencimiento de alguien que pidió irse.
 *
 * Lo encontró la revisión adversarial del diff, no la suite.
 *
 * POR QUÉ ACÁ Y NO EN `notificarUsuario`. Se intentó primero en ese chokepoint, leyendo
 * `cuenta_borrada_at` antes de cada aviso, y se revirtió: mete I/O en la única función que no
 * lo necesitaba, y obliga a decidir qué hacer cuando esa lectura falla. Fallar cerrado hace
 * que un hipo de Supabase suprima TODOS los avisos proactivos —incluidos los de fin de trial,
 * que son los que mueven plata— para tapar un caso de una cuenta ya borrada. El corte va donde
 * se ELIGE al destinatario, que es acá.
 *
 * LO QUE ESTE GUARD NO ES: no prueba que el cron no le escriba, prueba que la QUERY no la
 * traiga. Es un guard de texto sobre el fuente, con el límite que eso implica (la clase
 * `mis-guards-tambien-fallan` de DEFECTOS). Lo que sí garantiza es que una query nueva sobre
 * `usuarios` no pueda entrar sin que alguien decida si la lápida cae adentro.
 */

// Las tres razones VÁLIDAS por las que una query puede no traer una lápida. No son
// intercambiables: cada una excluye por una columna distinta que el RPC de borrado deja en un
// valor conocido. Si alguna deja de ser cierta en la migración, este guard se vuelve mentira.
const EXCLUYENTES = [
  // La explícita.
  { patron: /\.is\(\s*'cuenta_borrada_at'\s*,\s*null\s*\)/, motivo: 'filtra cuenta_borrada_at' },
  // El RPC deja `onboarding_completado = false` en la lápida.
  { patron: /\.eq\(\s*'onboarding_completado'\s*,\s*true\s*\)/, motivo: 'exige el alta cerrada' },
  // El RPC deja `whatsapp = NULL`.
  { patron: /\.not\(\s*'whatsapp'\s*,\s*'is'\s*,\s*null\s*\)/, motivo: 'exige tener numero' },
  // El RPC deja los tres `gmail_*` de `usuarios` en NULL.
  { patron: /\.not\(\s*'gmail_access_token'\s*,\s*'is'\s*,\s*null\s*\)/, motivo: 'exige token de Gmail' },
];

/**
 * Corta el fuente en las llamadas a `from('usuarios')` que LEEN, y devuelve el texto de cada
 * cadena hasta su `;`. Las que solo escriben (`.update(`) no eligen destinatario.
 */
function queriesDeLectura(src) {
  const out = [];
  for (const m of src.matchAll(/from\('usuarios'\)/g)) {
    const fin = src.indexOf(';', m.index);
    const cadena = src.slice(m.index, fin === -1 ? src.length : fin);
    if (!cadena.includes('.select(')) continue;              // solo escribe
    // Un `.update(...).select('id')` es un CLAIM atomico fijado por id, no una eleccion de
    // destinatario: la fila ya salio de una query filtrada mas arriba. Sin esta linea el guard
    // los marcaba y el arreglo habria sido agregar un filtro que no protege de nada.
    if (cadena.includes('.update(')) continue;
    // La línea donde arranca, para que el mensaje de falla sea accionable.
    out.push({ linea: src.slice(0, m.index).split('\n').length, cadena });
  }
  return out;
}

describe('la lapida no recibe avisos: ningun cron la selecciona', () => {
  const queries = FUENTES.flatMap(([archivo, src]) =>
    queriesDeLectura(src).map((q) => ({ ...q, archivo })));

  // Sin esto, el día que `checks.js` se renombre o se parta, el barrido devuelve [] y los dos
  // tests de abajo pasan por VACUIDAD.
  it('encuentra las queries de usuarios (antivacuidad)', () => {
    expect(queries.length, 'el barrido no encontro ninguna query: dejo de mirar nada').toBeGreaterThan(8);
  });

  it('toda query que elige destinatarios excluye a las cuentas borradas', () => {
    const sinExcluir = queries
      .filter((q) => !EXCLUYENTES.some((e) => e.patron.test(q.cadena)))
      .map((q) => q.archivo + ':' + q.linea);

    expect(sinExcluir,
      'Estas queries de `usuarios` pueden traer una LAPIDA (cuenta borrada). Decidi: si el cron ' +
      "le escribe, agrega `.is('cuenta_borrada_at', null)`; si ya la excluye por otra columna, " +
      'suma ese patron a EXCLUYENTES con el motivo. Una lapida que recibe un aviso vuelve a ' +
      'escribir filas en `notificaciones` y deshace el borrado de a poco.',
    ).toEqual([]);
  });

  // Las cinco que la revisión nombró. Fijarlas aparte del barrido genérico es a propósito: si
  // alguien relaja `EXCLUYENTES`, el barrido se vuelve permisivo entero, y estas son justo las
  // que traían la lápida por `plan`/`trial_estado` — las que motivaron el guard.
  it.each([
    ['premium por vencer', "eq('premium_vence', en3dias)"],
    ['premium vence hoy', "eq('premium_vence', hoy)"],
    ['premium vencido', "lt('premium_vence', hoy)"],
    ['trial por vencer', "eq('trial_vence', aviso.fecha)"],
    ['trial vencido', "lt('trial_vence', hoy)"],
  ])('la query de %s filtra cuenta_borrada_at explicitamente', (_nombre, ancla) => {
    const i = CHECKS.indexOf(ancla);
    expect(i, 'no se encontro la query (' + ancla + '): actualiza este test').toBeGreaterThan(-1);
    const inicio = CHECKS.lastIndexOf("from('usuarios')", i);
    const cadena = CHECKS.slice(inicio, CHECKS.indexOf(';', i));
    expect(cadena).toMatch(/\.is\(\s*'cuenta_borrada_at'\s*,\s*null\s*\)/);
  });
});
