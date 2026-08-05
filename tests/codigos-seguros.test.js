import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..',
);

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
    expect([...c].every((ch) => ALFABETO_ESPACIO.includes(ch))).toBe(true);
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
  const RUNTIME = ['handlers', 'lib', 'services', 'routes', 'cron', 'helpers'];

  function archivosJs(dir) {
    const out = [];
    const abs = path.join(projectRoot, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...archivosJs(path.join(dir, e.name)));
      else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
    return out;
  }

  // SIN \b a proposito. La contraprueba de abajo demuestra que `\bcode\b` NO matchea
  // `genCode`, que es el nombre de la funcion donde estaba el bug original: el guard de la
  // webapp habria pasado verde sobre su propio hallazgo. Se prefieren falsos positivos
  // —se exceptuan con motivo— a falsos negativos, que no se ven nunca.
  const PALABRAS_DE_SECRETO = /(otp|c[oó]digo|code|token|secret|invit|nonce)/i;

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

  /** El comentario que EXPLICA por que no se usa Math.random menciona Math.random. */
  function soloCodigo(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  const archivos = RUNTIME.flatMap(archivosJs).map((p) => p.replace(/\\/g, '/'));
  const sospechosos = [];
  let conMathRandom = 0;
  for (const rel of archivos) {
    const src = soloCodigo(fs.readFileSync(path.join(projectRoot, rel), 'utf8'));
    if (!/Math\.random\s*\(/.test(src)) continue;
    conMathRandom++;
    for (const m of src.matchAll(/Math\.random\s*\(/g)) {
      const vecindad = src.slice(Math.max(0, m.index - 300), m.index + 200);
      if (PALABRAS_DE_SECRETO.test(vecindad) && !EXENTOS.has(rel)) sospechosos.push(rel);
    }
  }

  it('el barrido alcanza el runtime de verdad (antivacuidad)', () => {
    expect(archivos.length).toBeGreaterThan(40);
    expect(archivos).toContain('services/shared-spaces.js');
    expect(archivos).toContain('handlers/intents/metas.js');
    // Si esto llega a 0, el barrido dejo de mirar nada y pasaria verde para siempre.
    expect(conMathRandom).toBeGreaterThan(0);
  });

  it('ninguno lo usa cerca de algo que funcione como credencial', () => {
    expect([...new Set(sospechosos)], 'Math.random generando un secreto').toEqual([]);
  });

  it('el detector reconoce la forma real del bug (contraprueba)', () => {
    // Las cuatro son las formas que existieron de verdad en este repo.
    for (const s of [
      "let inviteCode = ''; for (let i=0;i<8;i++) inviteCode += chars[Math.floor(Math.random()*chars.length)];",
      'function generarCodigoInvitacion() { let code = Math.random(); }',
      'function genCode(){ const n = Math.floor(100000 + Math.random()*900000); return `NETO-${n}`; }',
      'const token = Math.random().toString(36).substring(2, 8);',
    ]) {
      const m = s.match(/Math\.random\s*\(/);
      expect(PALABRAS_DE_SECRETO.test(s.slice(Math.max(0, m.index - 300), m.index + 200)), s).toBe(true);
    }
  });

  it('no marca los usos legitimos', () => {
    expect(PALABRAS_DE_SECRETO.test('const delay = Math.random() * 200; // stagger')).toBe(false);
    expect(PALABRAS_DE_SECRETO.test('const monto = Math.round(Math.random() * 500);')).toBe(false);
  });
});
