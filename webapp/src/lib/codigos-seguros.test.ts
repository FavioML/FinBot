import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { generarCodigoOtp, generarCodigoInvitacion, generarCodigoEnlace } from './codigos-seguros';

/**
 * S4 — el código del OTP inverso salía de `Math.random()`.
 *
 * No es un nit de estilo. El webhook busca el código GLOBALMENTE y vincula la cuenta Google
 * de ese código al teléfono que lo ENVIÓ, así que su impredecibilidad es lo único que impide
 * que alguien se lleve la cuenta de otro. Y el PRNG de V8 se reconstruye con unas pocas
 * salidas observadas — observables acá, porque cada POST le devuelve un código a quien lo
 * pide. El rate limit del webhook no cubre esto: acota la fuerza bruta, no la predicción.
 */

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('generarCodigoOtp', () => {
  it('siempre tiene la forma que el webhook matchea (NETO-######)', () => {
    for (let i = 0; i < 500; i++) {
      expect(generarCodigoOtp()).toMatch(/^NETO-\d{6}$/);
    }
  });

  it('siempre cae en el rango de seis dígitos', () => {
    for (let i = 0; i < 500; i++) {
      const n = Number(generarCodigoOtp().slice(5));
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });

  /**
   * LA prueba del hallazgo. Con `Math.random` congelado, la versión vieja devuelve SIEMPRE
   * el mismo código (`Math.floor(100000 + 0.5 * 900000)` = NETO-550000). La nueva no lo usa,
   * así que sigue variando. Es la forma más directa de fijar "no depende de Math.random"
   * sin leer el código fuente.
   */
  it('no depende de Math.random: con el PRNG congelado los códigos siguen variando', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const vistos = new Set<string>();
    for (let i = 0; i < 200; i++) vistos.add(generarCodigoOtp());
    expect(vistos.size).toBeGreaterThan(150);
    expect(vistos.has('NETO-550000')).toBe(false); // el valor que daba la versión vieja
  });

  it('los códigos de invitación tampoco dependen de Math.random', () => {
    const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const vistos = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generarCodigoInvitacion(ALFA, 8);
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      vistos.add(c);
    }
    expect(vistos.size).toBe(200); // 31^8: colisionar en 200 tiradas sería el PRNG congelado
  });

  it('usa la fuente criptográfica, y la usa de verdad', () => {
    const real = crypto.getRandomValues.bind(crypto);
    const spy = vi.fn((a: Uint32Array) => real(a));
    vi.stubGlobal('crypto', { ...crypto, getRandomValues: spy });
    generarCodigoOtp();
    expect(spy).toHaveBeenCalled();
  });

  /**
   * Sesgo de módulo: 2^32 no es múltiplo de 900000, así que un `% 900000` sin rechazo haría
   * los primeros ~3900 valores del rango más probables. Con 90k muestras en 9 baldes de
   * 100000 códigos, un sesgo de esa magnitud se ve; el ruido estadístico normal no.
   */
  it('reparte parejo (no hay sesgo de módulo)', () => {
    const baldes = new Array(9).fill(0);
    const N = 90000;
    for (let i = 0; i < N; i++) {
      const n = Number(generarCodigoOtp().slice(5));
      baldes[Math.floor((n - 100000) / 100000)]++;
    }
    const esperado = N / 9;
    for (const b of baldes) {
      expect(Math.abs(b - esperado) / esperado).toBeLessThan(0.06);
    }
  });
});

/**
 * S′10 — el código de invitación de deudas y gastos compartidos.
 *
 * Lo que falló acá NO fue la fuente: era `crypto.randomBytes(4)`, criptográfica. Fue el
 * LARGO — 32 bits, menos que espacios (39.6) y metas (46.3). El guard de `Math.random` de
 * abajo pasaba verde sobre esto porque pregunta de dónde salen los bits, no cuántos son.
 * Por eso este bloque afirma el largo, y no solo la impredecibilidad.
 */
describe('generarCodigoEnlace', () => {
  /**
   * 12 chars de un alfabeto de 55 = **69.5 bits**, contra los 32 de la versión vieja.
   *
   * Las DOS mitades del rango importan y por motivos opuestos: el piso son los bits, el
   * techo lo pone `character varying(12)` de `deudas.invite_code` y
   * `gasto_participantes.invite_code`. Postgres no trunca, tira `22001`. Un intento
   * anterior de este mismo fix emitía 32 chars y el UPDATE fallaba en silencio (las rutas
   * no leían el `error`), así que la ruta devolvía 200 con un código que la fila nunca
   * guardaba. Este test no puede ver la columna — quien lo hace es
   * `qa-e2e/qa-invite-codes.mjs`, que re-lee la fila después del POST — pero sí puede
   * impedir que el largo se mueva sin que nadie lo note.
   */
  it('mide 12 chars: 69.5 bits de piso y varchar(12) de techo', () => {
    for (let i = 0; i < 200; i++) {
      expect(generarCodigoEnlace()).toMatch(/^[A-Za-z2-9]{12}$/);
    }
  });

  it('cubre el alfabeto entero (un off-by-one decapitaría el último char)', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const c of generarCodigoEnlace()) vistos.add(c);
    expect(vistos.size).toBe(55);
  });

  /**
   * Sin caracteres ambiguos a mano (I, O, 0, 1, l) aunque estos códigos no se tipeen: es
   * el mismo alfabeto que el de metas, y compartirlo evita que alguien "unifique" los dos
   * más adelante y le cambie el alfabeto al que sí tiene links vivos.
   */
  it('no trae los caracteres ambiguos', () => {
    const todos = Array.from({ length: 200 }, generarCodigoEnlace).join('');
    expect(todos).not.toMatch(/[IO01l]/);
  });

  it('no depende de Math.random y no repite', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const vistos = new Set(Array.from({ length: 500 }, generarCodigoEnlace));
    expect(vistos.size).toBe(500);
  });

  it('usa la fuente criptográfica, y la usa de verdad', () => {
    const real = crypto.getRandomValues.bind(crypto);
    const spy = vi.fn((a: Uint32Array) => real(a));
    vi.stubGlobal('crypto', { ...crypto, getRandomValues: spy });
    generarCodigoEnlace();
    expect(spy).toHaveBeenCalled();
  });
});

/**
 * Guard estático: ninguna otra parte del código que produzca un secreto puede volver a
 * `Math.random()`. Se barre `src/` entero porque el próximo secreto no va a estar en este
 * archivo — el bug original tampoco estaba donde uno lo buscaría.
 */
describe('ningún secreto sale de Math.random', () => {
  const SRC = join(process.cwd(), 'src');

  function archivos(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const full = join(dir, n);
      if (statSync(full).isDirectory()) return archivos(full);
      return /\.(ts|tsx)$/.test(full) && !/\.test\.(ts|tsx)$/.test(full) ? [full] : [];
    });
  }

  // Math.random es legítimo para animaciones, jitter de UI y datos de demo. Lo que NO puede
  // es generar algo que después funcione como credencial: código, token, id de invitación.
  // SIN \b a propósito. La contraprueba de abajo demostró que `\bcode\b` NO matchea
  // `genCode`, que es literalmente el nombre de la función donde estaba el bug: el guard
  // habría pasado verde sobre el hallazgo que vino a fijar. Un detector que no reconoce el
  // camelCase del repo no reconoce nada. Se prefieren falsos positivos —se exceptúan con
  // motivo, abajo— a falsos negativos, que no se ven nunca.
  const PALABRAS_DE_SECRETO = /(otp|c[oó]digo|code|token|secret|invit|nonce)/i;

  /**
   * Excepciones, con su razón. Una excepción sin razón es un guard apagado.
   *
   * **Vacío desde el 2026-08-11.** La única que había era `app/api/user/referrals/route.ts`,
   * porque el `ref_code` es PÚBLICO por diseño (viaja en el link que el usuario reparte, y
   * usar el de otro te convierte en SU referido). El argumento era correcto para la
   * seguridad y tapaba un problema de CORRECTITUD que estaba anotado al lado y nadie
   * arreglaba: `Math.random().toString(36).substring(2, 8)` devuelve menos de 6 chars cuando
   * el float cae corto. Se migró a `generarCodigoInvitacion(ALFABETO_REF, 6)` en los dos
   * canales y la excepción se fue con su motivo.
   */
  const EXENTOS = new Set<string>([]);

  /**
   * Sin comentarios: el comentario que EXPLICA por qué no se usa `Math.random` mencionaba
   * `Math.random` y hacía saltar el guard sobre sí mismo. Documentar la decisión no puede
   * romper el build.
   *
   * ⚠️ El split es `/\r?\n/` y NO `'\n'`, y no es cosmética: con líneas CRLF cada una
   * termina en `\r`, y en JS el `.` de una regex **no matchea `\r`** (es terminador de
   * línea). O sea que `//.*$` no encontraba nada y el stripper era un **no-op en todo
   * archivo con CRLF** — que en un checkout de Windows son casi todos. Ese modo de falla
   * no es silencioso, es RUIDOSO: el guard marca la prosa que lo explica, y el arreglo
   * natural ante ese ruido es exceptuar el archivo, que sí lo apaga de verdad.
   *
   * El `(^|\s)` delante del `//` es la otra mitad, ya pagada en el guard hermano del
   * backend: toda URL literal lleva `//`, así que sin él un `'https://…'` se comía el
   * resto de la línea.
   */
  function soloCodigo(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))  // conserva offsets
      .split(/\r?\n/)
      .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
      .join('\n');
  }

  const sospechosos: string[] = [];
  let conMathRandom = 0;
  for (const full of archivos(SRC)) {
    const src = soloCodigo(readFileSync(full, 'utf-8'));
    if (!/Math\.random\s*\(/.test(src)) continue;
    conMathRandom++;
    // Se mira la vecindad de cada uso, no el archivo entero: un archivo grande puede tener
    // jitter de UI y, aparte, un generador de códigos.
    for (const m of src.matchAll(/Math\.random\s*\(/g)) {
      const vecindad = src.slice(Math.max(0, m.index! - 300), m.index! + 200);
      const rel = relative(SRC, full).replace(/\\/g, '/');
      if (PALABRAS_DE_SECRETO.test(vecindad) && !EXENTOS.has(rel)) {
        sospechosos.push(rel);
      }
    }
  }

  it('el barrido encuentra archivos con Math.random (antivacuidad)', () => {
    // Si esto llega a 0, el guard dejó de mirar nada y pasaría verde para siempre.
    expect(conMathRandom).toBeGreaterThan(0);
  });

  // Contraprueba del stripper. Hasta el 2026-08-11 era un no-op sobre líneas CRLF y nadie
  // lo sabía: el guard llevaba meses marcando prosa en vez de código.
  it('soloCodigo saca los comentarios también con CRLF', () => {
    const CR = String.fromCharCode(13);
    expect(soloCodigo('  // usa Math.random() para el codigo' + CR + '\nconst x = 1;')).not.toContain('Math.random');
    // Y con LF, que es el caso que sí funcionaba: la corrección no puede romperlo.
    expect(soloCodigo('  // usa Math.random() aca\nconst x = 1;')).not.toContain('Math.random');
    // Lo que NO es comentario tiene que seguir estando: un stripper que se come el código
    // deja el guard verde por vacuidad, que es la dirección peligrosa.
    expect(soloCodigo('const t = Math.random();' + CR + '\n')).toContain('Math.random');
    // Y una URL no puede comerse la línea (el `(^|\s)` delante del `//`).
    expect(soloCodigo("const u = 'https://x.pe'; const t = Math.random();" + CR + '\n')).toContain('Math.random');
  });

  it('ninguno lo usa cerca de algo que funcione como credencial', () => {
    expect([...new Set(sospechosos)], 'Math.random generando un secreto').toEqual([]);
  });

  it('el detector reconoce los patrones viejos REALES (contraprueba)', () => {
    // Los cuatro sitios tal como estaban escritos en el repo. El primero es el que hizo
    // fallar la primera versión del detector (`\bcode\b` no matchea `genCode`).
    const reales = [
      'function genCode(){ const n = Math.floor(100000 + Math.random()*900000); return `NETO-${n}`; }',
      'function generateInviteCode(): string { code += chars[Math.floor(Math.random() * chars.length)]; }',
      'function generateCode(): string { for (let i=0;i<8;i++) code += chars[Math.floor(Math.random()*chars.length)]; }',
      'function generarRefCode(): string { return Math.random().toString(36).substring(2, 8); }',
    ];
    for (const viejo of reales) {
      const m = [...viejo.matchAll(/Math\.random\s*\(/g)][0];
      const vecindad = viejo.slice(Math.max(0, m.index! - 300), m.index! + 200);
      expect(PALABRAS_DE_SECRETO.test(vecindad), viejo.slice(0, 40)).toBe(true);
    }
    // …y no marca los usos legítimos: jitter de UI y datos de demo.
    expect(PALABRAS_DE_SECRETO.test('const delay = Math.random() * 200; // stagger')).toBe(false);
    expect(PALABRAS_DE_SECRETO.test('const monto = Math.round(Math.random() * 500);')).toBe(false);
  });
});
