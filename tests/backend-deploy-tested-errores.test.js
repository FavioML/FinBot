import { describe, it, expect } from 'vitest';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  es404, clasificarJobs, decidir, veredicto, interpretarRespuestaDeJobs, severidad,
  diagnosticar404, veredictoSinRuns,
} from '../qa-e2e/backend-deploy-tested.mjs';

const HARNESS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'qa-e2e', 'backend-deploy-tested.mjs',
);

/**
 * `backend-deploy-tested` clasifica el fallo de `gh` en dos cajones muy distintos:
 * un 404 del workflow es **GUARD CIEGO** (exit 1: alguien renombró `ci.yml` y el gate se
 * quedó sin testigo), y cualquier otra cosa es infra (exit 2, sin veredicto).
 *
 * La clasificación se equivocó en las dos direcciones, una después de la otra:
 *
 *   1. Miraba solo `e.message`, donde `gh` NO escribe el motivo → la rama de guard-ciego
 *      no se alcanzaba nunca. Lo encontró una prueba por mutación.
 *   2. El arreglo la ensanchó a `stderr + message`, y `message` es "Command failed: gh api
 *      .../runs?head_sha=<40 hex>..." → un sha que contenga "404" convierte cualquier caída
 *      de red en un falso GUARD CIEGO.
 *
 * Los dos casos están abajo. El segundo es el fixture malicioso: pasa si se mira stderr, y
 * falla si alguien vuelve a meter `message` en la comparación.
 */

/** La forma real de la excepción de `execFileSync('gh', ...)`, verificada el 07-ago-2026. */
const errorGh = ({ stderr, message }) => ({ stderr, message });

const SHA_CON_404 = 'b3404f1e9a7c2d5084fbb1c6e0a93d27f5188cae';

describe('es404: qué fallo de gh es un guard ciego y cuál es infra', () => {
  it('reconoce el 404 real, que gh escribe en stderr', () => {
    expect(es404(errorGh({
      stderr: 'gh: Not Found (HTTP 404)\n',
      message: 'Command failed: gh api repos/FavioML/FinBot/actions/workflows/ci.yml/runs?head_sha=89206ac\ngh: Not Found (HTTP 404)\n',
    }))).toBe(true);
  });

  it('NO llama guard ciego a una caída de red solo porque el sha desplegado contiene "404"', () => {
    const v = es404(errorGh({
      stderr: 'error connecting to api.github.com\n',
      message: `Command failed: gh api repos/FavioML/FinBot/actions/workflows/ci.yml/runs?head_sha=${SHA_CON_404}&per_page=20\n`,
    }));
    expect(
      v,
      'clasificar por `message` mete la URL —y el sha— en la comparación: esto es infra ' +
        '(exit 2), no un ci.yml renombrado (exit 1)',
    ).toBe(false);
  });

  it('tampoco lo llama guard ciego cuando gh falla por auth y el sha tiene "404"', () => {
    expect(es404(errorGh({
      stderr: 'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n',
      message: `Command failed: gh api repos/FavioML/FinBot/actions/workflows/ci.yml/runs?head_sha=${SHA_CON_404}\n`,
    }))).toBe(false);
  });

  it('no explota si la excepción no trae stderr', () => {
    expect(es404({})).toBe(false);
    expect(es404(null)).toBe(false);
    expect(es404(errorGh({ stderr: undefined, message: 'Command failed: gh api ... 404' }))).toBe(false);
  });
});

/**
 * `ci.yml` no corre solo los tests del backend: también `webapp`, `deploy-webapp` (un
 * `vercel deploy`) y `railway-gate` (que consulta la API de Railway). Tomar la conclusion del
 * RUN como respuesta a "¿el backend pasó los tests?" hace que un token vencido o un deploy de
 * Vercel caído manden a arreglar una suite que estaba verde. Es el mismo argumento por el que
 * se prefirió `ci.yml` sobre los check suites, un nivel más adentro.
 *
 * Los jobs de abajo son reales, leídos de la API el 07-ago-2026.
 */
describe('clasificarJobs: ¿el job que responde por el backend corrió y pasó?', () => {
  // Run 31041521401. Rojo por `deploy-webapp`, con el backend verde.
  const DEPLOY_WEBAPP_CAIDO = [
    { name: 'webapp', status: 'completed', conclusion: 'success' },
    { name: 'test', status: 'completed', conclusion: 'success' },
    { name: 'nlp-agent', status: 'completed', conclusion: 'skipped' },
    { name: 'deploy-webapp', status: 'completed', conclusion: 'failure' },
  ];

  // Run 31045807530. Rojo por el job `webapp` (tsc/tests del front), backend verde igual.
  const WEBAPP_ROJO = [
    { name: 'test', status: 'completed', conclusion: 'success' },
    { name: 'webapp', status: 'completed', conclusion: 'failure' },
    { name: 'nlp-agent', status: 'completed', conclusion: 'skipped' },
    { name: 'deploy-webapp', status: 'completed', conclusion: 'skipped' },
  ];

  const TESTS_ROJOS = [
    { name: 'test', status: 'completed', conclusion: 'failure' },
    { name: 'webapp', status: 'completed', conclusion: 'success' },
  ];

  it('un deploy-webapp caído NO es "el backend no pasó los tests"', () => {
    const r = clasificarJobs(DEPLOY_WEBAPP_CAIDO);
    expect(r.pasaronLosTests, 'el job `test` salió verde: el backend que corre está bien').toBe(true);
    expect(r.jobsRojos).toEqual(['deploy-webapp: failure']);
  });

  it('el job `webapp` rojo tampoco dice nada sobre el backend', () => {
    expect(clasificarJobs(WEBAPP_ROJO).pasaronLosTests).toBe(true);
  });

  it('cuando los tests SÍ son los rojos, lo dice', () => {
    const r = clasificarJobs(TESTS_ROJOS);
    expect(r.pasaronLosTests).toBe(false);
    expect(r.motivo).toBe('fallo');
    expect(r.jobsDeTests).toEqual(['test: failure']);
  });

  it('`skipped` no cuenta como job rojo: el nlp-agent está en standby a propósito', () => {
    expect(clasificarJobs(DEPLOY_WEBAPP_CAIDO).jobsRojos).not.toContain('nlp-agent: skipped');
  });

  /**
   * Los dos "no sé". Nunca `true`, porque `true` significa "el backend está sano" y eso es
   * justo lo que no se puede afirmar acá. Misma lección que `validCheckSuites`.
   */
  it('sin lista de jobs devuelve indeterminado, no "los tests pasaron"', () => {
    const r = clasificarJobs(null);
    expect(r.pasaronLosTests).toBe(null);
    expect(r.motivo).toBe('sin-lista');
  });

  it('si el job `test` se renombró y no aparece, es indeterminado', () => {
    const r = clasificarJobs([{ name: 'backend-tests', status: 'completed', conclusion: 'success' }]);
    expect(r.pasaronLosTests, 'no está el job que responde la pregunta: no se puede dar por sano').toBe(null);
    expect(r.motivo).toBe('job-ausente');
  });

  /**
   * El job de tests SKIPPED con el run VERDE, que es el agujero que este archivo no cubría.
   * `nlp-agent` demuestra en producción que un `skipped` no ensucia la conclusion del run, así
   * que si `test` llevara un `if:` que evalúa false —un filtro por paths, un toggle de
   * standby— el run saldría `success` y el harness daba PASS con la suite sin correr.
   */
  it('un job `test` SKIPPED no es "pasó": no corrió, y el run igual sale verde', () => {
    const r = clasificarJobs([
      { name: 'test', status: 'completed', conclusion: 'skipped' },
      { name: 'webapp', status: 'completed', conclusion: 'success' },
    ]);
    expect(r.pasaronLosTests, 'un job que no corrió no puede contar como backend sano').toBe(false);
    expect(r.motivo).toBe('no-corrio');
  });

  it('un job `test` que quedó sin completar tampoco es "pasó"', () => {
    const r = clasificarJobs([{ name: 'test', status: 'in_progress', conclusion: null }]);
    expect(r.pasaronLosTests).toBe(false);
    expect(r.motivo).toBe('no-corrio');
  });

  /**
   * `filter`, no `find`. Con una matriz que produzca varias patas con el mismo nombre, `find`
   * se queda con la primera: verde la primera y roja la segunda devolvía "no fue culpa de los
   * tests" **con `test: failure` listado en `jobsRojos` del mismo objeto**.
   */
  it('con varias patas del mismo job, una roja alcanza: no gana la primera', () => {
    const r = clasificarJobs([
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'webapp', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'failure' },
    ]);
    expect(r.pasaronLosTests, 'una pata roja de la matriz es la suite en rojo').toBe(false);
    expect(r.jobsDeTests).toEqual(['test: success', 'test: failure']);
  });

  it('con varias patas y una skipped, tampoco alcanza', () => {
    const r = clasificarJobs([
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'skipped' },
    ]);
    expect(r.pasaronLosTests).toBe(false);
    expect(r.motivo).toBe('no-corrio');
  });

  it('con todas las patas verdes, sí pasa', () => {
    const r = clasificarJobs([
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'success' },
    ]);
    expect(r.pasaronLosTests).toBe(true);
    expect(r.jobsDeTests).toHaveLength(2);
  });

  /**
   * El nombre se compara EXACTO, y hasta el 08-ago nada lo fijaba: mutar `===` a `startsWith`
   * dejaba los 10 tests de este archivo en verde. Un `test-e2e` que empieza igual no responde
   * la pregunta, y tomarlo por el job de tests es dar por sano lo que no se miró.
   */
  it('un job cuyo nombre EMPIEZA igual no es el job de tests', () => {
    const r = clasificarJobs([
      { name: 'test-e2e', status: 'completed', conclusion: 'success' },
      { name: 'testing', status: 'completed', conclusion: 'success' },
    ]);
    expect(r.pasaronLosTests, '`test-e2e` no es `test`: el job real no está').toBe(null);
    expect(r.motivo).toBe('job-ausente');
  });

  it('con el job real presente, los que empiezan igual no lo tapan', () => {
    const r = clasificarJobs([
      { name: 'test-e2e', status: 'completed', conclusion: 'failure' },
      { name: 'test', status: 'completed', conclusion: 'success' },
    ]);
    expect(r.pasaronLosTests).toBe(true);
    expect(r.jobsDeTests).toEqual(['test: success']);
    expect(r.jobsRojos, 'sigue reportándose como job rojo del run').toContain('test-e2e: failure');
  });
});

/**
 * El mapeo de (color del run × motivo) a exit code.
 *
 * Existe como función aparte porque **el arreglo más importante de este archivo no tenía un
 * solo control**: una revisión adversarial revirtió `main()` a la versión anterior —el
 * `return done(0,'PASS')` con el run verde, antes de leer los jobs— y los 17 tests de acá y
 * los 894 de la suite siguieron en verde. Los tests cubrían `clasificarJobs()`, que es la
 * parte fácil; la decisión vivía en una cascada de `if` sin cobertura. Es la clase
 * `cobertura-alrededor-del-cambio` otra vez: cubrí todo menos el cambio de comportamiento.
 */
describe('decidir: qué exit code sale de cada (color del run × motivo)', () => {
  const VERDE = 'success';
  const ROJO = 'failure';

  const casos = [
    // conclusion, motivo,         pasaron, code, clase
    [VERDE, 'ok', true, 0, 'PASS'],
    [ROJO, 'ok', true, 1, 'ROJO_NO_POR_TESTS'],
    [VERDE, 'fallo', false, 1, 'NO_PASO'],
    [ROJO, 'fallo', false, 1, 'NO_PASO'],
    [VERDE, 'no-corrio', false, 1, 'SUITE_NO_CORRIO'],
    [ROJO, 'no-corrio', false, 1, 'SUITE_NO_CORRIO'],
    [VERDE, 'job-ausente', null, 1, 'GUARD_CIEGO_JOB'],
    [ROJO, 'job-ausente', null, 1, 'GUARD_CIEGO_JOB'],
    // La lista ilegible es lo único que cambia según el color, y a propósito: con el run rojo
    // el run rojo YA es la anomalía, así que no poder decir de quién fue la culpa no lo vuelve
    // benigno. Con el run verde lo único que falta es la comprobación, que es exit 2.
    [VERDE, 'sin-lista', null, 2, 'JOBS_ILEGIBLES'],
    [ROJO, 'sin-lista', null, 1, 'NO_PASO_SIN_JOBS'],
  ];

  it.each(casos)('run %s + motivo %s -> exit %i (%s)', (conclusion, motivo, pasaronLosTests, code, clase) => {
    expect(decidir({ conclusion, motivo, pasaronLosTests })).toEqual({ code, clase });
  });

  /**
   * El default. La cascada vieja terminaba en `return done(0,'PASS')` por caída libre, así que
   * un `motivo` nuevo —que por construcción nadie habría contemplado— salía PASS. Asumir lo
   * mejor ante un dato que no se entiende es el fallo que este archivo cita tres veces.
   */
  it('un motivo que nadie contempló es exit 2, nunca PASS', () => {
    for (const motivo of ['lista-truncada', 'attempt-mezclado', undefined, null, '']) {
      const r = decidir({ conclusion: VERDE, motivo, pasaronLosTests: null });
      expect(r.code, `motivo ${JSON.stringify(motivo)} no puede caer en PASS`).toBe(2);
      expect(r.clase).toBe('MOTIVO_DESCONOCIDO');
    }
  });

  it('`ok` con pasaronLosTests que no sea true tampoco es PASS', () => {
    expect(decidir({ conclusion: VERDE, motivo: 'ok', pasaronLosTests: null }).code).toBe(2);
    expect(decidir({ conclusion: VERDE, motivo: 'ok', pasaronLosTests: false }).code).toBe(2);
  });
});

/**
 * Y el VEREDICTO COMPLETO, que es lo que los tests de `decidir()` no alcanzan a ver: aquel
 * fija el exit code, éste fija que `main()` lo use y redacte lo que corresponde.
 *
 * La versión anterior de este bloque leía el CÓDIGO FUENTE de `main()` buscando `'PASS'`
 * antes de la consulta de jobs. Una revisión adversarial lo evadió con **comillas dobles**
 * —`done(0, "PASS", …)`— y reintrodujo el fail-open entero con los 31 tests en verde. Por eso
 * el ensamblado se extrajo a `veredicto()`, puro: acá no se inspecciona texto, se llama a la
 * función y se mira lo que devuelve. `severidadFn` se inyecta porque la real hace red.
 */
describe('veredicto: el ensamblado completo, sin leer código fuente', () => {
  const RUN_VERDE = { conclusion: 'success', status: 'completed', url: 'https://x/runs/1' };
  const RUN_ROJO = { conclusion: 'failure', status: 'completed', url: 'https://x/runs/1' };
  const SANOS = [
    { name: 'test', status: 'completed', conclusion: 'success' },
    { name: 'nlp-agent', status: 'completed', conclusion: 'skipped' },
  ];
  const sinRed = () => ({ lectura: 'severidad inyectada' });
  const armar = (over) => veredicto({
    deployed: 'abc1234', ultimo: RUN_VERDE, jobs: SANOS, errorJobs: null, corridas: 1,
    severidadFn: sinRed, ...over,
  });

  it('run verde + job de tests verde = PASS', () => {
    const r = armar();
    expect(r.code).toBe(0);
    expect(r.verdict).toBe('PASS');
  });

  /**
   * El agujero del 08-ago, ahora como test de comportamiento y no de texto: el run está
   * VERDE y el job de tests quedó skipped. `nlp-agent` demuestra en prod que un skipped no
   * ensucia la conclusion del run.
   */
  it('run VERDE con el job de tests skipped NO es PASS', () => {
    const r = armar({ jobs: [{ name: 'test', status: 'completed', conclusion: 'skipped' }] });
    expect(r.code, 'la suite del backend no corrió: no se puede dar por sano').toBe(1);
    expect(r.verdict).toMatch(/NO CORRIÓ/);
  });

  it('run VERDE sin ningún job llamado como el de tests es GUARD CIEGO, no PASS', () => {
    const r = armar({ jobs: [{ name: 'otro', status: 'completed', conclusion: 'success' }] });
    expect(r.code).toBe(1);
    expect(r.verdict).toMatch(/GUARD CIEGO/);
  });

  it('run VERDE con los jobs ilegibles es exit 2, y arrastra el error para diagnosticar', () => {
    const r = armar({ jobs: null, errorJobs: 'gh: connection reset' });
    expect(r.code).toBe(2);
    expect(r.extra.errorAlLeerJobs, 'sin el error, el exit 2 llega al canary sin nada').toBe('gh: connection reset');
  });

  it('run ROJO con los jobs ilegibles sigue siendo el caso grave, no infra', () => {
    const r = armar({ ultimo: RUN_ROJO, jobs: null, errorJobs: 'gh: connection reset' });
    expect(r.code, 'el run rojo ya es la anomalía: no poder atribuir la culpa no lo vuelve benigno').toBe(1);
  });

  it('run ROJO con el job de tests verde apunta al otro job, sin mandar a redesplegar', () => {
    const r = armar({
      ultimo: RUN_ROJO,
      jobs: [...SANOS, { name: 'deploy-webapp', status: 'completed', conclusion: 'failure' }],
    });
    expect(r.code).toBe(1);
    expect(r.verdict).toMatch(/NO POR LOS TESTS/);
    expect(r.extra.jobsRojos).toEqual(['deploy-webapp: failure']);
  });

  it('varias patas de matriz, una roja: no es PASS aunque el run esté verde', () => {
    const r = armar({ jobs: [
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'failure' },
    ] });
    expect(r.code).toBe(1);
    expect(r.verdict).toMatch(/NO PASÓ LA SUITE/);
  });

  /**
   * El default del `switch`. `main()` caía libre a PASS, así que una `clase` nueva que alguien
   * agregara en `decidir()` sin tocar acá salía exit 0. Se prueba forzando la clase por la
   * puerta de atrás: un motivo que `decidir()` no conoce.
   */
  it('una clase que veredicto() no sabe redactar es exit 2, nunca PASS', () => {
    const r = armar({ jobs: [], ultimo: { ...RUN_VERDE } });
    // jobs: [] -> job-ausente -> GUARD_CIEGO_JOB; el default se cubre abajo con decidir().
    expect(r.code).toBe(1);

    const desconocido = decidir({ conclusion: 'success', motivo: 'inventado', pasaronLosTests: null });
    expect(desconocido.clase).toBe('MOTIVO_DESCONOCIDO');
    expect(desconocido.code, 'y veredicto() lo redacta por el default del switch').toBe(2);
  });

  it('el PASS es el ÚNICO camino a exit 0 sobre todo el espacio de entradas', () => {
    const conclusiones = ['success', 'failure', 'cancelled', 'timed_out', 'neutral', null];
    const listas = [
      null, [],
      [{ name: 'test', status: 'completed', conclusion: 'success' }],
      [{ name: 'test', status: 'completed', conclusion: 'skipped' }],
      [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      [{ name: 'test', status: 'in_progress', conclusion: null }],
      [{ name: 'test', status: 'completed', conclusion: null }],
      [{ name: 'test-e2e', status: 'completed', conclusion: 'success' }],
      [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure' }],
    ];
    const ceros = [];
    for (const conclusion of conclusiones) {
      for (const jobs of listas) {
        const r = armar({ ultimo: { ...RUN_VERDE, conclusion }, jobs });
        if (r.code === 0) ceros.push({ conclusion, jobs: JSON.stringify(jobs) });
      }
    }
    expect(
      ceros,
      'exit 0 tiene que salir SOLO con el run verde y todas las patas del job de tests en ' +
        'success. Cualquier otra combinación que dé 0 es un fail-open.',
    ).toEqual([
      { conclusion: 'success', jobs: JSON.stringify(listas[2]) },
    ]);
  });
});

/**
 * Lo único que `veredicto()` no puede probar de sí mismo: que `main()` lo USE.
 *
 * La versión anterior de este guard buscaba la cadena `'PASS'` en el fuente y una revisión
 * adversarial la evadió con comillas dobles. Éste cuenta llamadas a `done()`, que no depende
 * del estilo de nadie: los 7 primeros son los chequeos de infra previos a leer los jobs
 * (/version, los runs, el fail-open puro, la suite en vivo) y el octavo es el único veredicto
 * del final, que sale entero de `veredicto()`. Un `return done(...)` de más —el atajo que
 * reintroduce el fail-open— mueve el número.
 *
 * Es un conteo fijado, el mismo idioma que `tests/gmail-oauth-gates.test.js`: romperlo es a
 * propósito, para obligar a decidir si el caso nuevo va acá o en `veredicto()`. Casi siempre
 * va en `veredicto()`, que es lo que está cubierto.
 */
describe('main() delega el veredicto y no lo arma por su cuenta', () => {
  const fuente = fs.readFileSync(HARNESS, 'utf8');
  const cuerpoMain = fuente.slice(fuente.indexOf('async function main()'));

  it('main() tiene exactamente 8 salidas, y la última delega en veredicto()', () => {
    const salidas = [...cuerpoMain.matchAll(/\bdone\(/g)];
    expect(
      salidas.length,
      'cambió la cantidad de `done()` en main(). Si agregaste un veredicto sobre el estado de ' +
        'CI, va en `veredicto()` —que es puro y está cubierto por los tests de arriba— y no ' +
        'como una rama suelta acá. Si de verdad es un chequeo de infra previo a leer los jobs, ' +
        'actualizá este número.',
    ).toBe(8);

    expect(
      cuerpoMain.slice(cuerpoMain.lastIndexOf('done(')),
      'la última salida de main() dejó de ser la que delega en veredicto()',
    ).toMatch(/done\(code, verdict, extra\)/);
  });
});

/**
 * La guarda de truncado. `filter` en vez de `find` existe por la matriz de jobs, así que
 * leer la lista con un `per_page` y sin mirar `total_count` dejaba sin cubrir justo el
 * escenario que motivó el arreglo.
 */
describe('interpretarRespuestaDeJobs: una lista truncada no es una lista', () => {
  const job = (name) => ({ name, status: 'completed', conclusion: 'success' });

  it('la lista completa pasa', () => {
    const r = interpretarRespuestaDeJobs({ total: 2, jobs: [job('test'), job('webapp')] });
    expect(r.error).toBe(null);
    expect(r.jobs).toHaveLength(2);
  });

  it('truncada se trata como ilegible, no como "esos son todos los jobs"', () => {
    const r = interpretarRespuestaDeJobs({ total: 120, jobs: [job('test')] });
    expect(r.jobs, 'con la pata roja fuera de la página saldría PASS con la suite roja').toBe(null);
    expect(r.error).toMatch(/truncada: 1 de 120/);
  });

  it('un run legítimamente sin jobs NO se marca truncado', () => {
    const r = interpretarRespuestaDeJobs({ total: 0, jobs: [] });
    expect(r.error, '`jq` emite null si falta el campo, y Number(null) es 0').toBe(null);
    expect(r.jobs).toEqual([]);
  });

  it('una respuesta sin lista es ilegible', () => {
    expect(interpretarRespuestaDeJobs({}).jobs).toBe(null);
    expect(interpretarRespuestaDeJobs(null).jobs).toBe(null);
  });
});

/**
 * El triage. Define "último commit con CI verde", y hasta el 08-ago lo hacía con
 * `runs?status=success`, o sea **el mismo oráculo agregado que este archivo entero declara no
 * confiable**. Con el job `test` filtrado por paths, imprimía "el runtime que corre es el
 * mismo que sí se testeó" sobre commits que nunca se testearon, y el `on_fail` del canary
 * traduce esa frase a "alcanza con anotarlo".
 */
/**
 * `es404` dice QUE dio 404; no dice por qué, y el mensaje necesita el por qué.
 *
 * Medido el 08-ago-2026 contra la API real: **cuatro causas dan un stderr byte-idéntico**
 * (`gh: Not Found (HTTP 404)`) — workflow inexistente, repo inexistente, repo privado sin acceso,
 * y owner inexistente. Con `NETO_REPO=github/github` el harness decía "GUARD CIEGO: no existe el
 * workflow ci.yml" y mandaba a revisar un archivo intacto.
 *
 * Los cuatro siguen siendo exit 1 —el gate quedó sin testigo en todos— pero el hint tiene que
 * apuntar al lugar correcto, y para eso hacen falta hasta dos sondeos.
 */
describe('diagnosticar404: cuatro causas, el mismo stderr', () => {
  const e404 = () => { const e = new Error('Command failed'); e.stderr = 'gh: Not Found (HTTP 404)'; throw e; };
  /** `alcanzables` es el conjunto de rutas que responden 200; el resto tira 404. */
  const ghFalso = (alcanzables) => (ruta) => (alcanzables.includes(ruta) ? '1' : e404());

  it('repo alcanzable -> el 404 era del workflow', () => {
    const d = diagnosticar404({ repo: 'FavioML/FinBot', workflow: 'ci.yml', ghFn: ghFalso(['repos/FavioML/FinBot']) });
    expect(d.clase).toBe('WORKFLOW_AUSENTE');
    expect(d.hint).toMatch(/\.github\/workflows\/ci\.yml/);
  });

  it('owner inexistente -> no manda a tocar el workflow', () => {
    const d = diagnosticar404({ repo: 'nadie-xyz/repo', workflow: 'ci.yml', ghFn: ghFalso([]) });
    expect(d.clase).toBe('OWNER_INEXISTENTE');
    expect(d.verdict).toMatch(/nadie-xyz/);
    expect(d.hint).toMatch(/NETO_REPO/);
    expect(d.hint, 'el workflow puede estar perfecto').not.toMatch(/¿Se renombró/);
  });

  /**
   * Y el caso que NO se puede partir más, y es de GitHub: "no existe" y "es privado y no tenés
   * acceso" devuelven los DOS un 404, a propósito, para no filtrar la existencia de repos
   * privados. Verificado con `github/github` (privado y real) y `FavioML/no-existe-jamas-xyz`
   * (inexistente): indistinguibles. El mensaje nombra las dos en vez de elegir una.
   */
  it('owner existe pero el repo no se ve -> nombra las DOS posibilidades', () => {
    const d = diagnosticar404({ repo: 'github/github', workflow: 'ci.yml', ghFn: ghFalso(['users/github']) });
    expect(d.clase).toBe('REPO_INACCESIBLE');
    expect(d.hint).toMatch(/no existe/);
    expect(d.hint).toMatch(/privado/);
    expect(d.hint).toMatch(/gh auth status/);
    expect(d.hint, 'no manda a tocar el workflow').toMatch(/No toques el workflow/);
  });

  /**
   * Si los sondeos fallan por algo que NO es un 404, no se puede desambiguar — y elegir "la causa
   * más probable" ahí es exactamente el error que este bloque viene a corregir.
   */
  it('sondeos caídos por red -> indeterminado, sin inventar la causa', () => {
    const ghRoto = () => { const e = new Error('Command failed'); e.stderr = 'gh: connection reset'; throw e; };
    const d = diagnosticar404({ repo: 'FavioML/FinBot', workflow: 'ci.yml', ghFn: ghRoto });
    expect(d.clase).toBe('INDETERMINADO');
    expect(d.hint).toMatch(/connection reset/);
    expect(d.verdict).not.toMatch(/no existe el workflow/);
  });
});

/**
 * El caso de CERO runs. Estaba dentro de `main()` —que hace red— y por eso no tenía un solo
 * control: la prueba por mutación mostró que revertir el título a "NUNCA TUVO SUITE DE CI" dejaba
 * los 128 tests en verde. La misma corrección en `evaluarGate` de `backend-deploy-gated` sí tenía
 * test, así que el barrido se había hecho en un solo archivo otra vez.
 */
describe('veredictoSinRuns: "no hay run" no es "nunca hubo run"', () => {
  const sinRed = () => ({ lectura: 'severidad inyectada' });
  const r = veredictoSinRuns('abcdef1234567890', { severidadFn: sinRed });

  it('sigue siendo exit 1: el gate se quedó sin testigo igual', () => {
    expect(r.code).toBe(1);
  });

  it('el título NO afirma que nunca hubo suite', () => {
    expect(r.verdict).not.toMatch(/NUNCA/);
    expect(r.verdict).toMatch(/NO TIENE NINGÚN RUN DE CI/);
  });

  it('el hint nombra las TRES causas y dice que ninguna se descarta desde acá', () => {
    expect(r.extra.hint).toMatch(/sin gate/);
    // El MECANISMO del commit intermedio, no solo la palabra: sin "un run por push" y "la PUNTA"
    // el lector no puede reconocer el caso en su propio historial.
    expect(r.extra.hint).toMatch(/INTERMEDIO/);
    expect(r.extra.hint).toMatch(/un run por push/);
    expect(r.extra.hint).toMatch(/PUNTA/);
    expect(r.extra.hint).toMatch(/retención/);
    expect(r.extra.hint).toMatch(/ninguna se descarta/);
  });

  it('sigue trayendo el triage de severidad', () => {
    expect(r.extra.lectura).toBe('severidad inyectada');
    expect(r.extra.deployed).toBe('abcdef1');
  });
});

describe('severidad: el triage baja al job, igual que el veredicto', () => {
  const VERDES = [
    { sha: 'aaa1111', url: 'https://x/runs/1' },
    { sha: 'bbb2222', url: 'https://x/runs/2' },
  ];
  // `nFiles` no es decorativo: `severidad` compara el rango por `compararRango`, que lo usa para
  // saber si la API topó `files` en 300. Un doble sin ese campo dejaba el módulo devolviendo la
  // lista VACÍA marcada como completa —el `handlers/webhook.js` desaparecía— y la suite en verde.
  // Ver el test "sin un conteo de archivos usable" en tests/github-compare.test.js.
  const ghFalso = (ruta) => {
    if (ruta.includes('/runs?status=success')) return JSON.stringify(VERDES);
    return JSON.stringify({ status: 'ahead', files: ['handlers/webhook.js'], nFiles: 1 });
  };
  const conJob = (conclusion) => ({ jobs: [{ name: 'test', status: 'completed', conclusion }] });

  it('descarta un candidato cuyo run está verde pero cuyo job de tests no corrió', () => {
    const leidos = [];
    const r = severidad('deployed', {
      ghFn: ghFalso,
      leerJobs: ({ url }) => { leidos.push(url); return conJob(url.endsWith('1') ? 'skipped' : 'success'); },
    });
    expect(leidos, 'tuvo que mirar los dos: el primero no sirve').toHaveLength(2);
    expect(r.ultimoVerdeAnterior, 'el primero tenía el job skipped: no es un "verde" real').toBe('bbb2222');
  });

  it('sin ningún candidato con el job verde, no inventa un ancestro', () => {
    const r = severidad('deployed', { ghFn: ghFalso, leerJobs: () => conJob('skipped') });
    expect(r.ultimoVerdeAnterior).toBeUndefined();
    expect(r.lectura).toMatch(/no se encontró/);
  });

  /**
   * Y la distinción que un blip de red borraba: "no hay ancestro sano" y "no pude verificar
   * ninguno" salían con la misma frase, que es una afirmación sobre la historia de CI
   * fabricada por la red.
   */
  it('si no se pudieron leer los jobs de NINGUNO, lo dice en vez de afirmar que no hay', () => {
    const r = severidad('deployed', { ghFn: ghFalso, leerJobs: () => ({ jobs: null, error: 'red' }) });
    expect(r.lectura).toMatch(/no se pudo verificar NINGUNO/);
    expect(r.lectura).not.toMatch(/no se encontró/);
  });

  /**
   * La frase "el runtime que corre es el mismo que sí se testeó" es la que el `on_fail` del
   * canary traduce a "alcanza con anotarlo", y se emitía con `observados.length === 0`.
   *
   * El problema es la DIRECCIÓN: la API de compare trunca `files` en 300 (medido: 193 de 302
   * observados sobre un rango real de este repo), y un truncado solo puede BAJAR ese conteo.
   * O sea que la única cosa que el truncado puede hacer con este triage es empujarlo hacia la
   * rama tranquilizadora. Con la lista incompleta, "cero observados" no es una lectura: es una
   * lectura que no se puede hacer.
   */
  const ghConCompare = (payload) => (ruta) => {
    if (ruta.includes('/runs?status=success')) return JSON.stringify(VERDES);
    return JSON.stringify(payload);
  };
  const verde = { leerJobs: () => conJob('success') };

  it('con la lista COMPLETA y cero observados, sí emite la lectura tranquilizadora', () => {
    const r = severidad('deployed', {
      ghFn: ghConCompare({ status: 'ahead', files: ['docs/x.md'], nFiles: 1 }), ...verde,
    });
    expect(r.listaCompleta).toBe(true);
    expect(r.lectura).toMatch(/el runtime que corre es el mismo que sí se testeó/);
  });

  it('con la lista INCOMPLETA y cero observados, NO la emite', () => {
    // `nFiles: 300` fuerza la bajada al diff crudo; el doble ignora el media type y devuelve
    // JSON, así que la lista queda marcada incompleta. Es el caso real de un truncado que no
    // se pudo resolver.
    const r = severidad('deployed', {
      ghFn: ghConCompare({ status: 'ahead', files: ['docs/x.md'], nFiles: 300 }), ...verde,
    });
    expect(r.listaCompleta).toBe(false);
    expect(r.lectura).not.toMatch(/el runtime que corre es el mismo que sí se testeó/);
    expect(r.lectura).toMatch(/NO SE PUEDE DECIR/);
    expect(r.avisoLista).toBeTruthy();
  });

  it('con la lista incompleta pero CON observados, la alarma se mantiene sin salvedades', () => {
    const r = severidad('deployed', {
      ghFn: ghConCompare({ status: 'ahead', files: ['handlers/webhook.js'], nFiles: 300 }), ...verde,
    });
    expect(r.lectura).toMatch(/HAY archivos observados/);
    expect(r.archivosDeBackendSinTestear).toContain('handlers/webhook.js');
  });
});
