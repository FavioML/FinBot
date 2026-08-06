import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// `fileURLToPath` y no el `new URL(...).pathname` + regex que usan los tests vecinos:
// ese pathname viene percent-encoded, asi que un checkout en una ruta con espacios o
// acentos mete `%20` en el path y estos tests fallan por I/O, no por el invariante.
// Hoy no aplica (ni local ni el runner tienen espacios), pero fallar por la razon
// equivocada es justo lo que hace que un guard no se crea.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  generarCodigoInvitacion,
  ALFABETO_ESPACIO,
  ALFABETO_META,
} = require('../lib/codigos-seguros');

/**
 * S4 de la auditoria CTO del 2026-08-03, la mitad que quedo abierta.
 *
 * El 04-ago se cerro `Math.random()` en las cuatro instancias de `webapp/src/`. El backend
 * generaba LOS MISMOS DOS codigos —invitacion a espacio (`services/shared-spaces.js`) y a
 * meta (`handlers/intents/metas.js`)— y siguio con `Math.random()` diez meses mas, porque
 * el guard de la webapp barre `webapp/src` y no puede ver este arbol.
 *
 * Este archivo es el barrido que faltaba. La leccion, que vale mas que el fix: cuando un
 * hallazgo toca los dos canales, el guard tiene que barrer los dos arboles. `precios-unica-
 * fuente` ya lo hace (su `DIRS` incluye `webapp/src`); el de codigos no lo hacia.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generarCodigoInvitacion', () => {
  it('respeta alfabeto y largo', () => {
    const c = generarCodigoInvitacion(ALFABETO_ESPACIO, 8);
    expect(c).toHaveLength(8);
    expect([...c].every((ch) => ALFABETO_ESPACIO.includes(ch))).toBe(false); // ROTO A PROPOSITO: prueba del gate de Railway, revertir
  });

  /**
   * LA prueba del hallazgo, y la misma forma que usa el espejo de la webapp: con el PRNG
   * de V8 congelado, la version vieja devolvia SIEMPRE el mismo codigo. Esta no lo mira,
   * asi que sigue variando. Es la manera mas directa de fijar "no depende de Math.random"
   * sin afirmar nada sobre la calidad de la entropia, que no es lo que se rompio.
   */
  it('no depende de Math.random: con el PRNG congelado los codigos siguen variando', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.42);
    const codigos = new Set(Array.from({ length: 40 }, () => generarCodigoInvitacion(ALFABETO_ESPACIO, 8)));
    expect(codigos.size).toBeGreaterThan(1);
  });

  it('los de meta tampoco', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.42);
    const codigos = new Set(Array.from({ length: 40 }, () => generarCodigoInvitacion(ALFABETO_META, 8)));
    expect(codigos.size).toBeGreaterThan(1);
  });

  it('cubre el alfabeto entero (un off-by-one en el rango decapitaria el ultimo char)', () => {
    const vistos = new Set();
    for (let i = 0; i < 4000; i++) for (const ch of generarCodigoInvitacion(ALFABETO_ESPACIO, 8)) vistos.add(ch);
    expect(vistos.size).toBe(ALFABETO_ESPACIO.length);
  });

  it('rechaza argumentos invalidos en vez de devolver un codigo degenerado', () => {
    expect(() => generarCodigoInvitacion('', 8)).toThrow();
    expect(() => generarCodigoInvitacion('A', 8)).toThrow();
    expect(() => generarCodigoInvitacion(ALFABETO_ESPACIO, 0)).toThrow();
    expect(() => generarCodigoInvitacion(ALFABETO_ESPACIO, 1.5)).toThrow();
  });
});

/**
 * Los alfabetos son un contrato ENTRE CANALES, no un detalle de este archivo.
 *
 * Espacios: la webapp genera en mayusculas y ademas **normaliza al buscar**
 * (`code.toUpperCase()`), asi que un codigo con minuscula emitido por el backend no se
 * podia unir desde la web nunca. Metas: ninguno de los dos lados normaliza, asi que los
 * alfabetos tienen que ser byte-identicos o los links de un canal mueren en el otro.
 */
describe('los alfabetos coinciden con los de la webapp', () => {
  const leer = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

  it('el de espacios es el mismo ALFABETO_ESPACIO de la webapp', () => {
    const web = leer('webapp/src/lib/codigos-seguros.ts');
    const m = web.match(/ALFABETO_ESPACIO\s*=\s*'([^']+)'/);
    expect(m, 'no encontre ALFABETO_ESPACIO en la webapp: se movio y este guard quedo ciego').toBeTruthy();
    expect(ALFABETO_ESPACIO).toBe(m[1]);
  });

  it('el de metas es el mismo ALFABETO_INVITE de la webapp', () => {
    const web = leer('webapp/src/app/api/goals/invite/route.ts');
    const m = web.match(/ALFABETO_INVITE\s*=\s*'([^']+)'/);
    expect(m, 'no encontre ALFABETO_INVITE en la webapp: se movio y este guard quedo ciego').toBeTruthy();
    expect(ALFABETO_META).toBe(m[1]);
  });

  it('el de espacios no tiene minusculas (la webapp las perderia al normalizar)', () => {
    expect(ALFABETO_ESPACIO).toBe(ALFABETO_ESPACIO.toUpperCase());
  });
});

/**
 * Guard estatico, espejo del de `webapp/src/lib/codigos-seguros.test.ts`. Barre el runtime
 * del BACKEND, que es lo que aquel no podia ver.
 */
describe('ningun secreto del backend sale de Math.random', () => {
  const RUNTIME = ['handlers', 'lib', 'services', 'routes', 'cron', 'helpers', 'scripts'];

  function archivosJs(dir) {
    const out = [];
    const abs = path.join(projectRoot, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...archivosJs(path.join(dir, e.name)));
      // `.mjs`/`.cjs` tambien: ampliar el alcance de directorios y dejar el filtro de
      // extension sin revisar es la misma clase de hueco en version chica
      // (`scripts/backup/*.mjs` quedaba fuera). `qa-e2e/` sigue afuera a proposito: son
      // harness que corren a mano, y varios generan invite codes de fixture con
      // Math.random, que ahi es aceptable.
      else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(path.join(dir, e.name));
    }
    return out;
  }

  /**
   * La RAÍZ, no recursiva. La primera versión de este guard listaba solo los seis
   * subdirectorios y dejaba **10 archivos fuera, entre ellos `gmail.js`** — el archivo
   * más denso en credenciales del backend (OAuth, refresh tokens, el state HMAC,
   * `guardarTokens`), que vive en la raíz. O sea que el guard escrito para cerrar
   * "el alcance del barrido más chico que la superficie del bug" repetía el bug.
   * Lo encontró el revisor adversarial, no mi verificación.
   */
  function archivosRaiz() {
    return fs.readdirSync(projectRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(js|mjs|cjs)$/.test(e.name))
      .map((e) => e.name);
  }

  // SIN \b a proposito. La contraprueba de abajo demuestra que `\bcode\b` NO matchea
  // `genCode`, que es el nombre de la funcion donde estaba el bug original: el guard de la
  // webapp habria pasado verde sobre su propio hallazgo. Se prefieren falsos positivos
  // —se exceptuan con motivo— a falsos negativos, que no se ven nunca.
  //
  // La lista en español NO es decorativa y la construyó el revisor adversarial con una
  // sonda: replicó esta misma lógica y le pasó un generador llamado
  // `generarClaveDeAcceso()` con la variable `clave`. **Pasó verde.** Ninguna palabra de
  // la versión original (`otp|código|code|token|secret|invit|nonce`) aparece en `clave`,
  // `llave`, `pin` ni `acceso`, y este repo nombra en español. Peor: `soloCodigo()` borra
  // los comentarios ANTES de matchear —correcto, para que el guard no se dispare sobre la
  // prosa que lo explica— así que una función cuyo JSDoc dice "genera el código de
  // invitación" pero cuyos identificadores dicen `clave` era invisible por partida doble.
  //
  // Segunda vuelta del revisor: faltaba `password` y —peor, porque la tesis entera era
  // "este repo nombra en español"— `contraseña`. Y `pin\b` sin boundary inicial matchea
  // dentro de `spin`, `copin` y cualquier palabra terminada en pin: eso no es una decisión
  // de política, es un error.
  //
  // `\bkey\b` salió y lo reemplazan las formas con prefijo. No por miedo al falso
  // positivo en abstracto —la política declarada es preferirlos— sino porque acá la
  // exención es POR ARCHIVO: un `const key = usuario.id` a seis líneas de un jitter
  // legítimo te obliga a meter el archivo entero en EXENTOS, o sea a cegar el barrido
  // sobre él para siempre. Un falso positivo que se paga con cobertura no es barato.
  // `key` suelto en JS es abrumadoramente una clave de mapa o de cache; las que importan
  // llevan prefijo, y `secret` ya cubre buena parte.
  const PALABRAS_DE_SECRETO =
    /(otp|c[oó]digo|code|token|secret|invit|nonce|clave|llave|\bpin\b|acceso|passphrase|password|contrase[nñ]a|\bpass\b|(?:api|priv|private|secret|access|refresh|encryption|signing)[-_]?key)/i;

  /**
   * El uso de `Math.random` en sus tres formas. `Math\.random\s*\(` solo veía la directa:
   * el revisor probó que `Math['random']()` y `const rnd = Math.random` (alias, se llama
   * después) **ni siquiera entraban al barrido** — no es que pasaran el filtro de
   * palabras, es que el archivo se descartaba antes de mirarlo.
   */
  // El destructuring lo agregó la segunda vuelta: `const { random } = Math` no contiene la
  // subcadena `Math.random`, así que el archivo se descartaba antes de mirarlo. El alias
  // `const rnd = Math.random` se detectaba de casualidad, porque esa subcadena sí está.
  const USO_MATH_RANDOM =
    /Math\s*(?:\.\s*random|\[\s*['"`]random['"`]\s*\])|\{\s*random\s*(?::\s*\w+\s*)?\}\s*=\s*Math\b/g;

  /**
   * Excepciones, con su razon. Una excepcion sin razon es un guard apagado.
   *
   * `lib/formatters.js` genera `ref_code`, que es PUBLICO por diseno: viaja en el link que
   * el usuario reparte (neto.pe/r/CODE). Predecirlo no da nada — usar el codigo de otro te
   * convierte en SU referido, o sea que el premio es de el. Su espejo en la webapp
   * (`app/api/user/referrals/route.ts`) esta exento por lo mismo. Queda registrado aparte
   * que `.toString(36).substring(2,8)` puede devolver menos de 6 chars: eso es
   * correctitud, no seguridad, y se revisa antes de ~50k usuarios.
   */
  const EXENTOS = new Set(['lib/formatters.js']);

  /**
   * Quita comentarios: el que EXPLICA por que no se usa Math.random menciona Math.random,
   * y no puede romper el build sobre si mismo.
   *
   * El `//` exige principio de linea o un espacio delante, y NO es un detalle de estilo.
   * La version anterior usaba `/\/\/.*$/` a secas, y **toda URL literal contiene `//`**:
   *
   *   entrada: const link = 'https://app.neto.pe/join/meta/' + inviteCode;
   *   salida  : const link = 'https:
   *
   * O sea que `inviteCode` desaparecia del texto barrido, y cualquier `Math.random()`
   * escrito a la derecha de una URL quedaba invisible — en los dos archivos que este
   * guard existe para proteger, que estan llenos de esas lineas. Es exactamente la clase
   * de agujero que el guard vino a cerrar, sobreviviendo DENTRO del guard. Lo encontro la
   * segunda revision adversarial; mi mutacion no lo toco porque puse el generador en una
   * linea sin URL.
   *
   * Con el espacio exigido, `'https://x'` se conserva (el `//` viene despues de `:`) y
   * `foo(); // comentario` se sigue cortando.
   */
  function soloCodigo(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
      .join('\n');
  }

  const archivos = [...RUNTIME.flatMap(archivosJs), ...archivosRaiz()].map((p) => p.replace(/\\/g, '/'));
  const sospechosos = [];
  let bytesLeidos = 0;
  for (const rel of archivos) {
    const src = soloCodigo(fs.readFileSync(path.join(projectRoot, rel), 'utf8'));
    bytesLeidos += src.length;
    for (const m of src.matchAll(USO_MATH_RANDOM)) {
      const vecindad = src.slice(Math.max(0, m.index - 300), m.index + 200);
      if (PALABRAS_DE_SECRETO.test(vecindad) && !EXENTOS.has(rel)) sospechosos.push(rel);
    }
  }

  it('el barrido alcanza el runtime de verdad (antivacuidad)', () => {
    expect(archivos.length).toBeGreaterThan(40);
    expect(archivos).toContain('services/shared-spaces.js');
    expect(archivos).toContain('handlers/intents/metas.js');
    // La raiz, que es el hueco que tenia la primera version.
    expect(archivos).toContain('gmail.js');
    expect(archivos).toContain('index.js');
    // Y que ademas LEA los archivos, no solo que los liste.
    //
    // Antes esto era `expect(conMathRandom).toBeGreaterThan(0)` y estaba mal de una forma
    // que solo se ve midiendo: `conMathRandom` valia UNO, y ese unico archivo era
    // `lib/formatters.js`, que esta EXENTO. O sea que la antivacuidad colgaba de que
    // `generarRefCode` siguiera usando Math.random — migrarlo a `crypto`, que es
    // exactamente la mejora que el comentario de EXENTOS deja anotada, tiraba el contador
    // a 0 y ROMPIA EL BUILD. Un guard que castiga hacer lo que promueve. Contar bytes
    // mide lo que de verdad importa (esto esta mirando algo?) y no se puede romper
    // arreglando codigo.
    expect(bytesLeidos).toBeGreaterThan(200000);
  });

  it('ninguno lo usa cerca de algo que funcione como credencial', () => {
    expect([...new Set(sospechosos)], 'Math.random generando un secreto').toEqual([]);
  });

  /**
   * El barrido completo sobre un fuente arbitrario. Se prueba la MISMA funcion que corre
   * contra el repo, no una reimplementacion: un detector probado por separado del barrido
   * es otro sitio donde los dos pueden divergir.
   */
  function detecta(src) {
    const limpio = soloCodigo(src);
    for (const m of limpio.matchAll(USO_MATH_RANDOM)) {
      if (PALABRAS_DE_SECRETO.test(limpio.slice(Math.max(0, m.index - 300), m.index + 200))) return true;
    }
    return false;
  }

  it('el detector reconoce la forma real del bug (contraprueba)', () => {
    // Las cuatro primeras existieron de verdad en este repo.
    for (const s of [
      "let inviteCode = ''; for (let i=0;i<8;i++) inviteCode += chars[Math.floor(Math.random()*chars.length)];",
      'function generarCodigoInvitacion() { let code = Math.random(); }',
      'function genCode(){ const n = Math.floor(100000 + Math.random()*900000); return `NETO-${n}`; }',
      'const token = Math.random().toString(36).substring(2, 8);',
      // Las cinco que siguen son las que el revisor adversarial probo que PASABAN VERDE
      // con la primera version. Cada una es un modo de evasion distinto:
      //
      // 1-3: identificadores en espanol. Este repo nombra asi, y ninguna palabra de la
      // lista original (otp|codigo|code|token|secret|invit|nonce) aparece en `clave`,
      // `llave` ni `pin`. La mas realista de todas es la primera.
      "function generarClaveDeAcceso() { let clave = ''; for (let i=0;i<8;i++) clave += L[Math.floor(Math.random()*L.length)]; return clave; }",
      "function nuevaLlave() { return Math.random().toString(36).slice(2); }",
      'const pin = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");',
      // 4-5: el uso de Math.random escrito de otra forma. Estas no es que pasaran el
      // filtro de palabras: el archivo se descartaba ANTES de mirarlo, porque
      // `Math\.random\s*\(` no las ve.
      "const codigo = Math['random']().toString(36).slice(2, 10);",
      'const rnd = Math.random; const token = rnd().toString(36);',
      // Y estas las trajo la SEGUNDA vuelta del revisor, sobre el arreglo de las de arriba.
      //
      // La primera es la que mas duele: toda URL literal lleva `//`, y `soloCodigo` cortaba
      // la linea ahi. En los dos archivos que este guard protege hay lineas asi
      // (`'https://app.neto.pe/join/meta/' + inviteCode`), o sea que el agujero estaba
      // justo donde mas importaba.
      "const inviteCode = 'https://app.neto.pe/join/space/' + Math.random().toString(36).slice(2, 10);",
      "const re = /a\\/\\/b/; const codigo = Math.random().toString(36);",
      // Faltaban en el regex: `password` y, contra la tesis del commit anterior, la palabra
      // espanola `contrasena`.
      "function generarPassword(){ let password=''; for(let i=0;i<12;i++) password += A[Math.floor(Math.random()*A.length)]; return password; }",
      "function generarContrasena(){ return Math.random().toString(36).slice(2); }",
      'const pass = Math.random().toString(36).slice(2);',
      // `const { random } = Math` no contiene la subcadena `Math.random`, asi que el
      // archivo ni entraba al barrido.
      'const { random } = Math; const inviteCode = random().toString(36).slice(2, 10);',
      'const { random: r } = Math; const codigo = r().toString(36).slice(2, 10);',
    ]) {
      expect(detecta(s), 'deberia detectarse: ' + s).toBe(true);
    }
  });

  /**
   * `pin\b` sin boundary inicial matcheaba dentro de `spin`. No era una decision de
   * politica sobre falsos positivos, era un error de regex.
   */
  it('las palabras se matchean como palabras, no como subcadenas', () => {
    expect(detecta('const spin = Math.random() * 360;')).toBe(false);
    expect(detecta('const pin = String(Math.floor(Math.random() * 1000000));')).toBe(true);
  });

  /**
   * La exencion es POR ARCHIVO, asi que un falso positivo cuesta la cobertura del archivo
   * entero. Estas son las formas legitimas que la version anterior del regex rompia.
   */
  it('no rompe el build sobre codigo legitimo que solo comparte una palabra', () => {
    expect(detecta('for (const key of Object.keys(cfg)) { const delay = Math.random() * 100; }')).toBe(false);
    expect(detecta('const key = usuario.id; const bucket = Math.random() < 0.5 ? "a" : "b";')).toBe(false);
    // Pero una clave que SI es credencial sigue cayendo.
    expect(detecta('const apiKey = Math.random().toString(36).slice(2);')).toBe(true);
    expect(detecta('const signing_key = Math.random().toString(36);')).toBe(true);
  });

  it('no marca los usos legitimos', () => {
    expect(detecta('const delay = Math.random() * 200;')).toBe(false);
    expect(detecta('const monto = Math.round(Math.random() * 500);')).toBe(false);
    expect(detecta('const jitter = base + Math.random() * 1000;')).toBe(false);
  });

  /**
   * El comentario que EXPLICA la decision no puede romper el build, pero tampoco puede
   * ESCONDER un generador: `soloCodigo` borra los comentarios antes de matchear, asi que
   * una funcion con JSDoc que dice "genera el codigo de invitacion" pero identificadores
   * que dicen `clave` quedaba invisible por partida doble. Con las palabras en espanol en
   * la lista, el codigo se delata solo y el JSDoc ya no importa.
   */
  it('un generador documentado en prosa pero nombrado en espanol NO se escapa', () => {
    const src = [
      '/** Genera el codigo de invitacion al espacio compartido. */',
      "function generarClaveDeAcceso() {",
      "  let clave = '';",
      '  for (let i = 0; i < 8; i++) clave += L[Math.floor(Math.random() * L.length)];',
      '  return clave;',
      '}',
    ].join('\n');
    expect(detecta(src)).toBe(true);
    // Y el comentario solo sigue sin alcanzar para disparar el guard.
    expect(detecta('// no usamos Math.random para el codigo, ver lib/codigos-seguros')).toBe(false);
  });
});
