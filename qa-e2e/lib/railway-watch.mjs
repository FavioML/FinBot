// El modelo de `build.watchPatterns` de `railway.json`, en un solo lugar.
//
// Antes esta lista estaba escrita DOS veces: en `railway.json` y a mano en
// `disparaBuildRailway()`. El precio de la copia lo pagaba un test de paridad, y el
// 07-ago-2026 se midió que ese precio no alcanzaba: tres mutaciones distintas pasaban
// las cinco pruebas en verde mientras el harness sub-reportaba, que es el modo de falla
// peor —`backend-deploy-fresh` da PASS sobre un backend genuinamente stale—.
//
//   a) una exclusión escrita en el CUERPO del predicado, sin tocar nada declarado
//   b) una tercera clave en el objeto de exclusiones (el test comparaba dos claves fijas)
//   c) `['**', ..., '!infra/**', 'infra/**']`: el test comparaba el CONJUNTO de negados
//      y tiraba el orden, así que no veía que la lista se re-incluía a sí misma
//
// Las tres salen de la misma raíz: había dos fuentes de verdad y el test comparaba
// PROYECCIONES de una contra la otra. Acá el predicado se DERIVA de `railway.json`, así
// que no hay dos listas que puedan divergir. Lo que queda por verificar ya no es "¿las
// copias coinciden?" sino "¿este modelo coincide con Railway?", que es una pregunta
// sobre el mundo y se responde midiendo — ver `qa-e2e/backend-watchpatterns-real.mjs`.
//
// Vive bajo `qa-e2e/` a propósito: es harness, y Railway no necesita redesplegar por él.

import fs from 'node:fs';

/** `railway.json` está en la raíz del backend; este módulo cuelga de `qa-e2e/lib/`. */
export const RAILWAY_JSON = new URL('../../railway.json', import.meta.url);

const RE_DIR = /^([\w.@-]+)\/\*\*$/; //   `dir/**`
const RE_EXT_RAIZ = /^\/\*\.(\w+)$/; //   `/*.ext`, anclado a la raíz

/**
 * Lee los patrones declarados. **Tira** si no están, en vez de devolver `[]`.
 *
 * No es celo: `[]` es un valor con significado y es el PEOR default posible. Railway
 * trata la lista vacía como "observar todo", así que un harness que cayera ahí en
 * silencio diría "este commit redespliega" sobre cualquier cosa. Y al revés, si alguien
 * borra `watchPatterns` de `railway.json`, lo que se quiere es que reviente el build, no
 * que el harness siga contestando con una lista que ya no existe.
 */
export function leerPatrones(url = RAILWAY_JSON) {
  const crudo = fs.readFileSync(url, 'utf8');
  const patrones = JSON.parse(crudo).build?.watchPatterns;
  if (!Array.isArray(patrones)) {
    throw new Error(
      `railway.json no declara build.watchPatterns (leído de ${url}). Si se quitó a ` +
        `propósito, Railway pasa a observar TODO y este harness ya no modela nada: ` +
        `arreglá la config o borrá el harness, pero no lo dejes contestando de memoria.`,
    );
  }
  return patrones;
}

/**
 * Lo que le pasa a quien tropieza con uno de los throws de acá, y no es obvio: este módulo lo
 * importa `tests/railway-watchpatterns-paridad.test.js`, así que un patrón que no compila
 * pone la suite ROJA, y con "Wait for CI" prendido eso **frena el deploy del backend**. Es el
 * comportamiento que se quiere (modelo roto = no desplegar a ciegas), pero descubrirlo por
 * accidente cuesta una hora.
 */
const RADIO_DE_EXPLOSION =
  'OJO: esto pone `npm test` en rojo y, vía "Wait for CI", frena el deploy del backend hasta ' +
  'que lo enseñes en los DOS lados. Es a propósito, pero no lo descubras a las 2am.';

/**
 * La forma de lista que sabemos leer, y es MÁS ANGOSTA que la que Railway acepta.
 *
 * Exige `['**', ...solo negados]`. Rechaza cualquier otra por dos motivos distintos, y
 * los dos importan:
 *
 * 1. **La precedencia no está medida.** Con un solo include al principio y exclusiones
 *    que no se solapan, da igual si Railway resuelve "gana el último que matchea" o
 *    "algún include y ningún exclude": el resultado es el mismo. En cuanto aparece un
 *    include DESPUÉS de una exclusión, las dos reglas dan resultados distintos y no
 *    tenemos una sola observación de Railway que las separe. Adivinar ahí es exactamente
 *    lo que produce un harness que sub-reporta sin romperse.
 * 2. **La lista es NEGRA a propósito.** Invertirla a blanca hace que una carpeta de
 *    backend nueva deje de desplegarse en silencio. Ver CLAUDE.md.
 *
 * O sea que esto no es una limitación a tapar: es el punto donde el harness se niega a
 * inventar. El día que haga falta una lista con re-inclusiones, primero se mide contra
 * Railway y después se enseña acá.
 */
export function verificarForma(patrones) {
  if (patrones.length === 0) {
    throw new Error('build.watchPatterns está vacío: para Railway eso significa OBSERVAR TODO.');
  }
  if (patrones[0] !== '**') {
    throw new Error(
      `el primer patrón de build.watchPatterns es "${patrones[0]}" y se esperaba "**". ` +
        `La lista es negra a propósito: empieza incluyendo todo y después excluye, para ` +
        `que una carpeta de backend nueva se despliegue sin tocar config. ${RADIO_DE_EXPLOSION}`,
    );
  }
  const reincluye = patrones.slice(1).filter((p) => !p.startsWith('!'));
  if (reincluye.length) {
    throw new Error(
      `build.watchPatterns re-incluye después de excluir (${JSON.stringify(reincluye)}), y ` +
        `ahí la PRECEDENCIA pasa a ser observable. Hoy no está medida contra Railway: no se ` +
        `sabe si gana el último patrón que matchea o si basta con "algún include y ningún ` +
        `exclude", y las dos reglas dan resultados distintos sobre esa lista. Medilo con un ` +
        `deploy de control ANTES de confiar en este harness, y después enseñale la regla a ` +
        `verificarForma(). Ver la nota de precedencia en CLAUDE.md. ${RADIO_DE_EXPLOSION}`,
    );
  }
}

/**
 * Compila los patrones a reglas. Solo entiende las formas que `railway.json` usa hoy y
 * **tira** ante cualquier otra: un glob nuevo que este módulo no sepa leer tiene que
 * romper el build, no evaluarse con un default. Un `return false` acá sería el fallo
 * silencioso que todo esto viene a evitar.
 */
export function compilarPatrones(patrones) {
  verificarForma(patrones);

  return patrones.map((p) => {
    const negado = p.startsWith('!');
    const cuerpo = negado ? p.slice(1) : p;

    if (cuerpo === '**') return { patron: p, negado, forma: 'todo', test: () => true };

    // `dir/**` — todo lo que cuelga de un directorio con ese nombre, **a CUALQUIER
    // PROFUNDIDAD**. Incluye los sub-directorios que empiezan con punto: medido el 07-ago
    // sobre `webapp/.claude/deploy-config.json`, que Railway saltea (`257f2f5`, `cde2525`).
    //
    // **No está anclado a la raíz, y descubrirlo costó un deploy de control** (09-ago-2026).
    // Acá decía `startsWith` y la reimplementación por regex del test de paridad decía
    // `^dir/`: las dos copias de acuerdo y las dos equivocadas, que es exactamente el
    // escenario que `backend-watchpatterns-real` existe para atrapar — y lo atrapó, con
    // `DESACUERDO` y exit 1. La medición son dos commits que difieren en UN solo segmento:
    //
    //   00dd65d  .claude/commands/deploy.md          → Railway CONSTRUYÓ
    //   6de1392  .claude/docs/railway-glob-probe.md  → "No changes to watched files"
    //
    // O sea que `!docs/**` matcheó `docs/` en el medio de la ruta. El argumento completo y
    // cómo repetirlo están en `.claude/docs/railway-glob-probe.md`, que es la sonda misma.
    //
    // Se implementa por SEGMENTO (`^dir/` o `/dir/`), no por subcadena. La diferencia es
    // `midocs/x.js`, que CONTIENE `docs/` sin tener un segmento `docs`, y ese caso **no está
    // medido**. Se elige segmento porque es el lado seguro: si Railway lo excluyera igual, el
    // modelo sobre-reporta y a lo sumo salta una falsa alarma de STALE. Al revés —modelar como
    // excluido algo que Railway observa— es el sub-reporte que da PASS sobre un backend stale.
    let m = cuerpo.match(RE_DIR);
    if (m) {
      const prefijo = `${m[1]}/`;
      return {
        patron: p,
        negado,
        forma: 'dir',
        clave: prefijo,
        test: (f) => f.startsWith(prefijo) || f.includes(`/${prefijo}`),
      };
    }

    // `/*.ext` — la barra inicial ANCLA A LA RAÍZ. Sin ella el patrón sería recursivo y
    // `handlers/notas.md` dejaría de desplegar; es la parte sutil de la lista.
    //
    // **Medido, no leído de la sintaxis** (08-ago-2026): fue durante meses el único supuesto
    // que ninguna observación sostenía —los `.md` de raíz salteados son igual de compatibles
    // con un patrón recursivo— hasta que el deploy de control `00dd65d` tocó SOLO
    // `.claude/commands/deploy.md` (un `.md` ANIDADO, y `.claude/` está observado) y Railway
    // **construyó**. Sacarle el `!f.includes('/')` de acá pone en rojo a
    // `backend-watchpatterns-real` sobre esa fila; antes de ese commit pasaba en verde.
    m = cuerpo.match(RE_EXT_RAIZ);
    if (m) {
      const ext = `.${m[1]}`;
      return { patron: p, negado, forma: 'extRaiz', clave: ext, test: (f) => !f.includes('/') && f.endsWith(ext) };
    }

    throw new Error(
      `forma de patrón no soportada: "${p}". Alguien agregó un glob de una forma nueva a ` +
        `railway.json. Enseñásela a compilarPatrones() Y a compilar() en ` +
        `tests/railway-watchpatterns-paridad.test.js — y fijate ANTES qué hace Railway con ` +
        `ella de verdad, porque acá no hay una segunda copia que te contradiga. ` +
        `${RADIO_DE_EXPLOSION}`,
    );
  });
}

/**
 * El predicado: ¿este archivo hace que Railway redespliegue?
 *
 * Devuelve una función que **no conoce ninguna ruta**: todo lo que sabe entró por
 * `patrones`. Es la propiedad que mata la mutación (a) —una exclusión escrita a mano
 * junto al predicado— y `tests/railway-watchpatterns-paridad.test.js` la fija leyendo
 * el código fuente de lo que sale de acá.
 */
export function crearPredicado(patrones) {
  const reglas = compilarPatrones(patrones);

  return function disparaBuild(f) {
    return evaluarReglas(reglas, f);
  };
}

/**
 * Semántica de lista de globs: gana el ÚLTIMO patrón que matchea. Con la forma que
 * `verificarForma()` exige —un `**` y después solo exclusiones— es indistinguible de "algún
 * include y ningún exclude", que es justo por qué esa forma se puede evaluar sin haber medido
 * la precedencia.
 *
 * Está separado de `crearPredicado` para que un consumidor pueda evaluar reglas MODIFICADAS
 * sin reimplementar la semántica: lo usa `backend-watchpatterns-real.mjs` para preguntar si
 * una suposición del modelo (el ancla de raíz) llegó a ser decisiva sobre un diff real.
 */
export function evaluarReglas(reglas, f) {
  if (!f) return false;
  let incluido = false;
  for (const r of reglas) if (r.test(f)) incluido = !r.negado;
  return incluido;
}
