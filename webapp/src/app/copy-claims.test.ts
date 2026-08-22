import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';

/**
 * Lo que el copy de la webapp AFIRMA, contra lo que el producto hace.
 *
 * Hermano de `landing/scripts/verify-claims.mjs`, y existe porque ese guard barre
 * SOLO el arbol de la landing. La webapp estuvo entera fuera de su perimetro, y el
 * 22-ago-2026 se midio lo que costaba: corriendo sus dos patrones contra este arbol
 * aparecio `app/layout.tsx` con "Conecta tu banco por WhatsApp" en la meta
 * description de TODAS las rutas, en produccion, desde marzo. Es la clase
 * `barrido-de-un-solo-arbol` de `docs/DEFECTOS.md`, ya registrada dos veces.
 *
 * **Por que hay dos guards y no un modulo compartido.** La landing se separo a su
 * propio repositorio, asi que el CI de cada uno solo puede hacer checkout del suyo:
 * un import cruzado no existe en CI. Las reglas estan duplicadas a sabiendas. Al
 * agregar una aca, agregala alla, y los `id` estan puestos para que el diff sea
 * inmediato. La otra mitad del costo la paga la landing, que no tiene CI ni test
 * runner y corre su script a mano.
 *
 * Dos perimetros, porque las reglas no son todas del mismo tipo:
 *
 *   SIEMPRE      lo que es falso en cualquier pantalla (no hay integracion bancaria,
 *                la negacion absoluta sobre correos, el registro sin esfuerzo).
 *   CONVERSION   la regla de PROMINENCIA de Gmail del CLAUDE.md de Neto. La funcion
 *                esta viva, es de Pro y es opt-in, pero no va de titular ni con
 *                nombres de bancos donde alguien todavia esta decidiendo. Solo el
 *                9.5% de las transacciones nacen de un correo; el resto las anota
 *                la persona.
 *
 * El perimetro de conversion se DERIVA, no se enumera: es el cierre transitivo de
 * imports de toda pagina publica, y publica es toda ruta que el middleware no gatea.
 * Una pagina publica nueva entra sola, y mover el copy a un componente compartido no
 * la saca (esa era la clase `perimetro-de-un-salto`).
 *
 * LO QUE NO CUBRE: copy que no esta en el arbol de fuentes (texto que venga de la DB
 * o de una variable de entorno), y las imagenes. Y lee lineas sueltas, asi que una
 * frase partida en dos lineas de JSX se le escapa.
 *
 * ANTES DE PORTAR `registro-sin-esfuerzo` A LA LANDING, leer esto. Se corrio contra
 * ese arbol el 22-ago y dio los dos errores en la misma tanda:
 *
 *   FALSO POSITIVO. `blog-content.ts:400` dice "los gastos que el banco ya te notifica
 *   por correo se registren sin que hagas nada", que es VERDAD: ahi el "nada" esta
 *   acotado a esos correos y la frase ya trae el framing. En una sola linea no se
 *   distingue de "para importar tus transacciones sin que hagas nada", que si es falsa
 *   porque implica todas. El patron no puede separarlas; hace falta la allowlist.
 *
 *   FALSO NEGATIVO. El `<title>` y el `og:title` de la landing dicen "Ordena tu plata
 *   sin mover un dedo", que es el mismo claim con otras palabras y el patron no lo ve.
 *   Enumerar formulas es la clase `enumeracion-que-no-cubre-el-conjunto`: este patron
 *   atrapa las tres que ya se dijeron, no la familia.
 */

const SRC = join(process.cwd(), 'src');
const APP = join(SRC, 'app');

/** Prefijos que el middleware gatea: lo de adentro no lo ve nadie sin sesion. */
const PROTEGIDAS = ['dashboard', 'admin', 'onboarding'];

const SIEMPRE = [
  {
    id: 'integracion-bancaria',
    patron: /(conect|vincul|sincroniz|enlaz)\w*\s+(tu|su)\s+(banco|cuenta\s+bancaria)/i,
    porque: 'Neto no se conecta a ningun banco. Promete open banking e insinua que pedimos credenciales bancarias.',
    debeMatchear: ['Conecta tu banco por WhatsApp', 'vincula tu cuenta bancaria'],
    noDebeMatchear: ['conecta tu Gmail', 'los correos que tu banco ya te envia'],
  },
  {
    id: 'negacion-absoluta-correos',
    patron: /(no|nunca)\s+(accedemos|leemos|revisamos|entramos)\s+(a\s+)?(tus|sus)\s+correos(?!\s+personales)/i,
    porque: 'Con Gmail conectado (Pro, opt-in) Neto SI lee correos: los de notificacion bancaria. La negacion va calificada.',
    debeMatchear: ['nunca leemos tus correos'],
    noDebeMatchear: ['No leemos tus correos personales'],
  },
  {
    id: 'registro-sin-esfuerzo',
    patron: /(sin\s+(anotar|ingresar|escribir|hacer)\s+nada|sin\s+que\s+hagas\s+nada|se\s+registran\s+solos)/i,
    porque: 'Falso: el 9.5% de las transacciones nacen de un correo y el resto las anota la persona. Ademas contradice al hero, que vende justo anotar.',
    debeMatchear: ['Sin anotar nada.', 'para importar tus transacciones sin que hagas nada', 'Tus gastos se registran solos'],
    noDebeMatchear: ['Neto lo registra solo', 'sin anotar el numero de tarjeta'],
  },
];

const CONVERSION = [
  {
    id: 'gmail-de-titular',
    patron: /(lee|leer|lectura\s+de)\s+(tus\s+)?correos|correos\s+bancarios/i,
    porque: 'Gmail no va en superficies de conversion. Vive en /producto, blog, FAQ, la tarjeta Pro del Pricing y el panel Pro del dashboard.',
    debeMatchear: ['Neto lee tus correos bancarios y organiza todo', 'Lectura de correos bancarios'],
    noDebeMatchear: ['Neto ordena lo que anotas', 'entra por WhatsApp o desde la app'],
  },
  {
    id: 'bancos-prominentes',
    patron: /\b(BCP|BBVA|Interbank|Scotiabank|BanBif|Mibanco)\b/,
    porque: 'Nombrar bancos donde alguien todavia esta decidiendo insinua una integracion directa con el banco, que no existe.',
    debeMatchear: ['Conecta BCP, BBVA, Interbank y mas'],
    noDebeMatchear: ['texto, voz o foto de tu Yape', 'Yape o Plin'],
  },
];

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const abs = join(dir, n);
    if (statSync(abs).isDirectory()) return archivos(abs);
    return /\.(tsx?|mdx?)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [abs] : [];
  });
}

/** Toda `page.tsx` que el middleware no gatea, mas el layout raiz que las envuelve. */
function paginasPublicas(): string[] {
  const paginas = archivos(APP)
    .filter((f) => /(^|[\\/])page\.tsx$/.test(f))
    .filter((f) => {
      const seg = relative(APP, dirname(f)).split(sep);
      return !PROTEGIDAS.includes(seg[0]);
    });
  return [...paginas, join(APP, 'layout.tsx')];
}

/** Cierre transitivo de imports `@/...`: el copy movido a un componente no se escapa. */
function cierreDeImports(semillas: string[]): string[] {
  const vistos = new Set<string>();
  const cola = [...semillas];
  while (cola.length) {
    const f = cola.pop() as string;
    if (vistos.has(f) || !existsSync(f)) continue;
    vistos.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"]@\/([^'"]+)['"]/g)) {
      for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
        const cand = join(SRC, m[1] + ext);
        if (existsSync(cand)) { cola.push(cand); break; }
      }
    }
  }
  return [...vistos];
}

function infracciones(archivo: string, reglas: typeof SIEMPRE): string[] {
  const rel = relative(process.cwd(), archivo).split(sep).join('/');
  return readFileSync(archivo, 'utf8').split('\n').flatMap((linea, i) => {
    // Los comentarios explican el bug: no pueden ser el bug.
    if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return [];
    return reglas.flatMap((r) => {
      const m = linea.match(r.patron);
      return m ? [`[${r.id}] ${rel}:${i + 1} -> ${JSON.stringify(m[0])}\n    ${r.porque}`] : [];
    });
  });
}

describe('copy de la webapp: lo que afirma contra lo que el producto hace', () => {
  const todos = archivos(SRC);
  const conversion = cierreDeImports(paginasPublicas());

  it('antivacuidad: los patrones reconocen sus propios ejemplos', () => {
    const rotos: string[] = [];
    for (const r of [...SIEMPRE, ...CONVERSION]) {
      for (const e of r.debeMatchear) if (!r.patron.test(e)) rotos.push(`${r.id} NO ve su ejemplo malo: ${e}`);
      for (const e of r.noDebeMatchear) if (r.patron.test(e)) rotos.push(`${r.id} marca una frase legitima: ${e}`);
    }
    expect(rotos, rotos.join('\n')).toEqual([]);
  });

  it('antivacuidad: los dos barridos miran algo, y el chico esta contenido en el grande', () => {
    expect(todos.length, 'el barrido de src/ esta roto').toBeGreaterThan(50);
    expect(conversion.length, 'el cierre de imports publicos esta vacio').toBeGreaterThan(5);
    expect(conversion.every((f) => todos.includes(f))).toBe(true);

    // La premisa del perimetro: esos prefijos siguen siendo los que el middleware gatea.
    const mw = readFileSync(join(process.cwd(), 'middleware.ts'), 'utf8');
    for (const p of PROTEGIDAS) {
      expect(mw.includes(`/${p}`), `el middleware ya no menciona /${p}: revisa PROTEGIDAS`).toBe(true);
    }

    // Y /login tiene que estar adentro: es la superficie que origino todo esto.
    expect(conversion.some((f) => f.endsWith(join('app', 'login', 'page.tsx')))).toBe(true);
  });

  it('ninguna pantalla afirma lo que el producto no hace', () => {
    const fallos = todos.flatMap((f) => infracciones(f, SIEMPRE));
    expect(fallos, '\n' + fallos.join('\n')).toEqual([]);
  });

  it('Gmail y los bancos no aparecen en superficies de conversion', () => {
    const fallos = conversion.flatMap((f) => infracciones(f, CONVERSION));
    expect(fallos, '\n' + fallos.join('\n')).toEqual([]);
  });
});
