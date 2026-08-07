import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WATCH_PATTERNS, EXCLUSIONES, disparaBuildRailway } from '../qa-e2e/backend-deploy-fresh.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `qa-e2e/backend-deploy-fresh.mjs` decide si un archivo redespliega Railway con cuatro
 * `startsWith` escritos a mano. La verdad vive en `railway.json` (`build.watchPatterns`).
 * Son dos copias de la misma lista negra, y la copia puede desincronizarse SIN ROMPERSE:
 * alguien agrega una exclusión a `railway.json`, no toca el harness, y el harness sigue
 * corriendo verde mientras da veredictos equivocados. Es el modo de falla peor —silencioso
 * y en el guard, o sea que además te lo cree la próxima auditoría.
 *
 * Este test es lo que hace ruido cuando eso pasa. No intenta probar equivalencia semántica
 * de globs en general: reimplementa los patrones DECLARADOS de forma independiente y
 * contrasta las dos implementaciones sobre el árbol real del repo. Que la deriva se vea en
 * las dos direcciones depende de eso: una exclusión agregada solo al harness no cambia
 * ningún patrón declarado, así que la única manera de atraparla es que un archivo de verdad
 * la ejercite.
 *
 * La lista negra es negra A PROPÓSITO: una carpeta de backend nueva se despliega por
 * default. Ver la sección de gates en CLAUDE.md y [[project_railway_deploy_gate]].
 */

const railway = JSON.parse(fs.readFileSync(path.join(projectRoot, 'railway.json'), 'utf8'));
const patronesDeclarados = railway.build?.watchPatterns;

const RE_DIR = /^([\w.@-]+)\/\*\*$/; //   `dir/**`
const RE_EXT_RAIZ = /^\/\*\.([\w]+)$/; // `/*.ext`, anclado a la raíz

/**
 * Segunda implementación, independiente de la del harness. Solo soporta las formas de glob
 * que `railway.json` usa hoy, y **tira** ante cualquier otra en vez de asumir un default:
 * un patrón nuevo que este test no entiende tiene que romper el build, no pasar de largo.
 * Un `return false` acá sería exactamente el fallo silencioso que el test viene a evitar.
 *
 * Cada regla lleva su `forma` y su `clave` además del predicado, porque los dos tests las
 * necesitan: el del corpus usa `test()`, el de conjuntos usa `forma`+`clave`.
 */
function compilar(patrones) {
  return patrones.map((p) => {
    const negado = p.startsWith('!');
    const cuerpo = negado ? p.slice(1) : p;

    if (cuerpo === '**') return { patron: p, negado, forma: 'todo', test: () => true };

    // `dir/**` — todo lo que cuelga de un directorio.
    let m = cuerpo.match(RE_DIR);
    if (m) {
      const prefijo = `${m[1]}/`;
      return { patron: p, negado, forma: 'dir', clave: prefijo, test: (f) => f.startsWith(prefijo) };
    }

    // `/*.ext` — la barra inicial ANCLA A LA RAÍZ. Sin ella el patrón sería recursivo y
    // `handlers/notas.md` dejaría de desplegar; es la parte sutil de la lista.
    m = cuerpo.match(RE_EXT_RAIZ);
    if (m) {
      const ext = `.${m[1]}`;
      return { patron: p, negado, forma: 'extRaiz', clave: ext, test: (f) => !f.includes('/') && f.endsWith(ext) };
    }

    throw new Error(
      `forma de patrón no soportada por este test: "${p}". Alguien agregó un glob de una ` +
        `forma nueva a railway.json. Enseñale la forma a compilar() Y revisá que ` +
        `disparaBuildRailway() en qa-e2e/backend-deploy-fresh.mjs la implemente igual.`,
    );
  });
}

/** Las exclusiones declaradas, como conjuntos comparables con `EXCLUSIONES` del harness. */
function exclusionesDeclaradas(reglas) {
  const de = (forma) => reglas.filter((r) => r.negado && r.forma === forma).map((r) => r.clave).sort();
  return { dirs: de('dir'), extsRaiz: de('extRaiz') };
}

/** Semántica de lista de globs: gana el ÚLTIMO patrón que matchea. */
function evaluarDeclarado(reglas, archivo) {
  let incluido = false;
  for (const r of reglas) if (r.test(archivo)) incluido = !r.negado;
  return incluido;
}

/**
 * El corpus son los archivos versionados de verdad, que es exactamente la forma de lo que
 * consume el harness (`gh api .../compare` devuelve paths de git). Una lista escrita a mano
 * solo probaría los casos que se me ocurrieron; el árbol real prueba los que existen.
 */
function archivosVersionados() {
  const raw = execFileSync('git', ['ls-files'], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Casos que el árbol de hoy no cubre pero la lista sí decide. El primero es el que más
 * importa: es la propiedad por la que la lista es negra y no blanca.
 */
const SINTETICOS = [
  'servicio-nuevo/index.js', // carpeta de backend NUEVA: tiene que desplegar por default
  'webapp/src/app/nuevo/page.tsx',
  'qa-e2e/harness-nuevo.mjs',
  'docs/NOTA-nueva.md',
  'NUEVO.md', // *.md de la raíz: excluido
  'lib/NUEVO.md', // el mismo .md pero anidado: NO excluido (el ancla de raíz)
  'package.json',
  '.github/workflows/ci.yml',
];

describe('watchPatterns de railway.json vs. el predicado del harness', () => {
  it('el harness declara exactamente los patrones que tiene railway.json', () => {
    expect(
      patronesDeclarados,
      'railway.json no tiene build.watchPatterns: si se quitó, el harness quedó decidiendo ' +
        'con una lista negra que ya no existe y todo commit redespliega',
    ).toBeDefined();

    expect(
      patronesDeclarados,
      'railway.json y WATCH_PATTERNS (qa-e2e/backend-deploy-fresh.mjs) divergieron. ' +
        'Actualizá LAS DOS mitades: la constante declarada Y el cuerpo de disparaBuildRailway().',
    ).toEqual(WATCH_PATTERNS);
  });

  /**
   * El test que NO depende del corpus, y por eso es el que cierra el agujero. Los otros
   * contrastan las dos implementaciones sobre archivos que existen; una exclusión sobre un
   * directorio todavía vacío no la ejercita ninguno. Comprobado por mutación el 07-ago-2026:
   * agregar `'!infra/**'` a railway.json sin tocar el predicado —o `'infra/'` al predicado
   * sin tocar railway.json— pasaba las cuatro pruebas en verde, y la segunda dirección es la
   * peligrosa: el harness sub-reporta y `backend-deploy-fresh` da PASS sobre un backend
   * genuinamente stale.
   */
  it('el conjunto de exclusiones del predicado es el mismo que declara railway.json', () => {
    const declaradas = exclusionesDeclaradas(compilar(patronesDeclarados));
    const implementadas = {
      dirs: [...EXCLUSIONES.dirs].sort(),
      extsRaiz: [...EXCLUSIONES.extsRaiz].sort(),
    };

    expect(
      implementadas,
      'las exclusiones del predicado y las de railway.json no son el mismo conjunto. ' +
        'Esto se ve aunque NO exista todavía un archivo versionado bajo la ruta nueva, que ' +
        'es justo lo que los otros tests de este archivo no pueden ver.',
    ).toEqual(declaradas);
  });

  it('el predicado coincide con los patrones declarados sobre todo el árbol versionado', () => {
    const reglas = compilar(patronesDeclarados);
    const corpus = archivosVersionados();

    // Sin esto el test podría pasar por vacuidad si `git ls-files` devuelve nada.
    expect(corpus.length, 'git ls-files no devolvió archivos: el corpus quedó vacío').toBeGreaterThan(100);

    const divergen = corpus
      .map((f) => ({ f, declarado: evaluarDeclarado(reglas, f), harness: disparaBuildRailway(f) }))
      .filter((r) => r.declarado !== r.harness);

    expect(
      divergen.slice(0, 20),
      'disparaBuildRailway() no implementa lo que declaran los watchPatterns. ' +
        '`declarado` es lo que dice railway.json, `harness` lo que hace el predicado.',
    ).toEqual([]);
  });

  it('también coinciden en los casos que el árbol de hoy no tiene', () => {
    const reglas = compilar(patronesDeclarados);
    const divergen = SINTETICOS
      .map((f) => ({ f, declarado: evaluarDeclarado(reglas, f), harness: disparaBuildRailway(f) }))
      .filter((r) => r.declarado !== r.harness);

    expect(divergen, 'divergencia en los casos sintéticos').toEqual([]);
  });

  /**
   * No es redundante con los de arriba: fija la INTENCIÓN. Si alguien invierte la lista a
   * blanca (`["handlers/**", "lib/**", ...]`), los dos tests anteriores pueden quedar verdes
   * —las dos implementaciones seguirían de acuerdo entre sí— mientras una carpeta nueva deja
   * de desplegarse en silencio, que es el fallo que la lista negra existe para prevenir.
   */
  it('la lista es NEGRA: una carpeta de backend nueva se despliega sin tocar config', () => {
    const reglas = compilar(patronesDeclarados);
    for (const nueva of ['servicio-nuevo/index.js', 'workers/cola.js', 'integraciones/banco/x.js']) {
      expect(evaluarDeclarado(reglas, nueva), `railway.json dejó de observar ${nueva}`).toBe(true);
      expect(disparaBuildRailway(nueva), `el harness dejó de observar ${nueva}`).toBe(true);
    }
  });
});
