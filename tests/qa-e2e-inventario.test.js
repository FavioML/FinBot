// Inventario de qa-e2e: ningún harness queda huérfano, y el canary no apunta al vacío.
//
// POR QUÉ EXISTE. El 09-ago-2026 un barrido encontró que 51 de los ~76 `.mjs` de
// `qa-e2e/` no estaban ni cableados al canary ni documentados en el README. Uno de
// ellos (`qa-cron-deudas.mjs`) llevaba meses pudriéndose: su stub reescribía a mano
// el `select` de la query real, la real sumó `usuarios.plan` y la copia no siguió,
// así que al correrlo daba exit 1 con 9 checks rojos — indistinguible de "el cron de
// recordatorios está roto en producción" hasta abrir las dos queries y compararlas.
//
// O sea que el costo de un harness que nadie corre no es solo la cobertura que no
// da: es la falsa alarma que fabrica el día que alguien lo corre.
//
// Ese barrido arregló la INSTANCIA (cableó tres, documentó el resto, dejó el
// recuento en cero) y dejó la CLASE abierta: nada impedía que el próximo `.mjs`
// volviera a nacer huérfano en silencio. Esto es la clase. Es hermano del barrido de
// `tests/qa-guard.test.js` ("ningún harness se salta la barrera") y usa el mismo
// mecanismo, porque el problema es el mismo: un archivo nuevo que nadie ata a nada.
//
// LAS DOS DIRECCIONES, que son fallos distintos:
//   1. Un `.mjs` que no está en `canary.harnesses` ni nombrado en el README =
//      archivo que hay que mantener y que nadie sabe qué afirma. La próxima
//      auditoría lo redescubre desde cero, o peor, asume que algo está cubierto.
//   2. Una entrada de `canary.harnesses` que apunta a un archivo que ya no existe =
//      el canary de las 10am falla con un "cannot find module" que parece infra. Hoy
//      NADA lo atrapaba: en este mismo barrido se borró `qa-hostpays-check.mjs` y lo
//      único que impidió el problema fue acordarse de mirar.
//
// ACOPLAMIENTO QUE CONVIENE SABER (mismo caso que los tests de railway-watchpatterns,
// ver CLAUDE.md): este test vive en la suite del backend y lee un archivo de
// `webapp/`. Correr en CI está bien —el `package.json` raíz no tiene `build`, así que
// Railway no lo ejecuta—, pero significa que agregar un `.mjs` sin documentarlo pone
// la suite roja y, vía "Wait for CI", **frena el deploy del backend**. Es el
// comportamiento que se quiere (guard roto = no desplegar) y el arreglo cuesta una
// fila de tabla, pero no es obvio leyendo solo este archivo.
//
// EL CRITERIO de a cuál de los dos lados va un harness nuevo NO se decide acá: vive
// en `qa-e2e/README.md` ("¿esto se puede romper sin que nadie haga un commit?").
// Este test solo exige que la decisión se haya TOMADO.
//
// BARRE EL ÁRBOL DE TRABAJO, NO EL ÍNDICE, y es deliberado. Un harness `.mjs` sin
// commitear te pone la suite roja acá mismo, antes del push. Cuesta una molestia
// mientras lo estás escribiendo y a cambio te dice "decidí dónde vive" en el momento
// en que lo creaste, no en un CI rojo media hora después. Es la misma elección que ya
// hace el barrido hermano de `tests/qa-guard.test.js`, y conviene que las dos
// coincidan. Consecuencia práctica que se vio el primer día: **este test se estrenó
// marcando un huérfano de OTRA sesión en curso** (`qa-bsuid-media.mjs`, sin commitear).
// Eso es el guard funcionando, no un falso positivo; si te pasa, la salida te dice las
// dos salidas posibles. Y no ensucia CI: lo que no está commiteado, el checkout no lo ve.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(import.meta.dirname, '..');
const DIR = join(RAIZ, 'qa-e2e');
const CONFIG = join(RAIZ, 'webapp', '.claude', 'deploy-config.json');
const README = join(DIR, 'README.md');

// Solo la RAÍZ de qa-e2e, igual que el barrido de qa-guard. `lib/` son librerías que
// los harness importan y `fixtures/` son generadores de PNG que se corren una vez; ni
// unos ni otros afirman nada, así que no les corresponde fila ni entrada. El tercer
// test de abajo impide que esa exclusión se use como escondite.
const harnessDeRaiz = () => readdirSync(DIR).filter((n) => n.endsWith('.mjs')).sort();

// El nombre tiene que aparecer con un borde a la izquierda que no sea parte de un
// nombre de archivo. Sin esto, buscar `sweep.mjs` matchearía dentro de
// `qa-sweep.mjs` y un huérfano se daría por documentado por vivir al lado de otro
// con nombre más largo. Se permite `/` y espacio y backtick a la izquierda, para que
// una mención como `qa-e2e/qa-foo.mjs` cuente igual.
const mencionado = (texto, nombre) =>
  new RegExp('(?<![A-Za-z0-9_-])' + nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(texto);

const canaryHarnesses = () => JSON.parse(readFileSync(CONFIG, 'utf8')).canary.harnesses || [];

// De `node qa-e2e/qa-foo.mjs --flag` saca `qa-foo.mjs`.
const archivoDelCmd = (cmd) => (cmd.match(/qa-e2e\/([\w.-]+\.mjs)/) || [])[1] || null;

describe('inventario de qa-e2e: cada harness tiene un lugar decidido', () => {
  it('ningún .mjs queda huérfano: o corre en el canary, o está documentado en el README', () => {
    const archivos = harnessDeRaiz();
    const readme = readFileSync(README, 'utf8');
    const enCanary = new Set(canaryHarnesses().map((h) => archivoDelCmd(h.cmd)).filter(Boolean));

    // Anti-vacuidad, y NO anclada a que el defecto exista (esa clase ya se pagó una
    // vez en este repo: un guard cuya antivacuidad era `> 0` sobre un contador que
    // arreglar el código dejaba en 0). Estas tres cotas se sostienen solas:
    // - el barrido tiene que ver al menos tantos archivos como entradas de canary
    //   apuntan a qa-e2e/, porque cada una nombra un archivo real. Si readdirSync se
    //   rompe o alguien le mete un filtro de más, esto cae sin números escritos.
    // - el README tiene que tener contenido, o `mencionado()` diría que nada está
    //   documentado y el test fallaría por la razón equivocada.
    expect(enCanary.size, 'el config no declaró ningún harness de qa-e2e').toBeGreaterThan(0);
    expect(archivos.length, 'el barrido vio menos archivos que los que el canary nombra')
      .toBeGreaterThanOrEqual(enCanary.size);
    expect(readme.length, 'README.md vacío o ilegible').toBeGreaterThan(1000);

    const huerfanos = archivos.filter((f) => !enCanary.has(f) && !mencionado(readme, f));

    expect(
      huerfanos,
      'Estos .mjs no están en `canary.harnesses` NI nombrados en qa-e2e/README.md:\n' +
      huerfanos.map((f) => '  - ' + f).join('\n') +
      '\n\nDecidí dónde va cada uno y dejalo escrito. El criterio está en el README ' +
      '("¿esto se puede romper sin que nadie haga un commit?"). Si va al canary, ' +
      'agregá la entrada con su `cost` y su `on_fail`; si es manual, agregá su fila. ' +
      'Un harness que nadie corre le dice a la próxima auditoría que algo está cubierto.',
    ).toEqual([]);
  });

  it('ninguna entrada del canary apunta a un archivo que ya no existe', () => {
    const entradas = canaryHarnesses();
    expect(entradas.length, 'el config no declaró ningún harness').toBeGreaterThan(0);

    const rotas = [];
    for (const h of entradas) {
      const archivo = archivoDelCmd(h.cmd);
      // Una entrada cuyo cmd no nombra un .mjs de qa-e2e es tan sospechosa como una
      // rota: significa que el canary corre algo que este inventario no puede ver.
      if (!archivo) { rotas.push(h.name + ' (cmd no nombra un .mjs de qa-e2e: ' + h.cmd + ')'); continue; }
      if (!existsSync(join(DIR, archivo))) rotas.push(h.name + ' -> ' + archivo + ' NO EXISTE');
    }

    expect(
      rotas,
      'El canary de las 10am va a fallar con un error que PARECE infra:\n' +
      rotas.map((r) => '  - ' + r).join('\n') +
      '\n\nSi borraste o renombraste un harness, sacá o actualizá su entrada en ' +
      'webapp/.claude/deploy-config.json.',
    ).toEqual([]);
  });

  it('lib/ y fixtures/ contienen exactamente lo declarado (la exclusión no es un escondite)', () => {
    // El barrido mira solo la raíz, y esa exclusión es correcta (ver arriba). Pero una
    // exclusión sin vigilar es una puerta: mover un harness a `lib/` lo sacaría del
    // inventario sin sacarlo del repo.
    //
    // Se fija el CONTENIDO, no un patrón de nombre. La primera versión de esto marcaba
    // como sospechoso todo `.mjs` que empezara con `qa-`, y se disparaba sola con
    // `lib/qa-guard.mjs`, que es la barrera misma. Ese es el modo de fallo de siempre:
    // medir el NOMBRE en vez de lo que el archivo hace, y quedar evadible por quien
    // elija otro nombre. Un conjunto fijado no se puede evadir eligiendo nombres, y el
    // precio es que agregar una librería legítima rompe el build una vez y obliga a
    // decir por qué. Mismo patrón que los conteos fijados de gmail-oauth-gates y
    // notificaciones-duales.
    const declarado = {
      // los importan los harness de la raíz; no afirman nada por sí solos
      lib: ['github-compare.mjs', 'qa-guard.mjs', 'railway-watch.mjs'],
      // generadores de PNG que se corren UNA vez y cuyo output se commitea
      fixtures: ['render-yape-pro.mjs', 'render-yape.mjs'],
    };

    for (const [sub, esperado] of Object.entries(declarado)) {
      const d = join(DIR, sub);
      expect(existsSync(d), 'qa-e2e/' + sub + ' desapareció').toBe(true);
      const real = readdirSync(d).filter((n) => n.endsWith('.mjs')).sort();
      expect(
        real,
        'qa-e2e/' + sub + '/ cambió de contenido. Si agregaste una librería o un ' +
        'generador, sumalo a `declarado` en este test. Si lo que agregaste AFIRMA algo ' +
        '(tiene checks y exit code), no va acá: va en la raíz de qa-e2e/, donde el ' +
        'inventario lo ve y donde hay que decidir si corre en el canary o a mano.',
      ).toEqual([...esperado].sort());
    }
  });
});
