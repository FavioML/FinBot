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
 *                la negacion absoluta sobre correos, el registro sin esfuerzo, el
 *                gasto que "se anota solo", la notificacion del banco como mecanismo,
 *                los canales "sincronizados" y el score unico sin "en Peru").
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

/**
 * Una exclusividad ("ningun otro", "nadie mas", "solo Neto", "el unico") y el score en la misma
 * frase, en cualquier orden, sin "en Peru" en esa frase. La frase termina en punto o en raya:
 * "Único en Perú — ningún otro asistente tiene score" afirma dos cosas, y la segunda va sin alcance.
 */
const SIN_PERU = String.raw`(?:(?!en\s+(?:el\s+)?Per[uú])[^.—\n])*?`;
const NI_DESPUES = String.raw`(?![^.—\n]*en\s+(?:el\s+)?Per[uú])`;
const NINGUN_OTRO = String.raw`(?:ning[uú]n[oa]?\s+otr[oa]s?|nadie\s+m[aá]s)`;
const SCORE_UNICO_SIN_ALCANCE = new RegExp(
  String.raw`(?:${NINGUN_OTRO}|s[oó]lo\s+Neto|\b(?:el|la)\s+[uú]nic[oa])${SIN_PERU}\bscores?\b${NI_DESPUES}` +
    String.raw`|\bscores?\b${SIN_PERU}${NINGUN_OTRO}${NI_DESPUES}`,
  'i'
);

/**
 * "Los anota solos": un verbo de registro con un "por si solo" pegado, en cualquier orden, sin
 * una accion de la persona en la misma frase. `registro-sin-esfuerzo` solo veia tres formulas
 * fijas y dejo pasar el panel Pro ("detecta tus gastos de las notificaciones del banco y los
 * anota solos") desde que se escribio.
 *
 * La accion es lo que separa lo verdadero de lo falso: "envia tus comprobantes y Neto los
 * registra automaticamente" es cierto, porque la persona mando algo. Solo cuenta lo que hace la
 * PERSONA: "Neto te manda un resumen" no libera nada, una accion negada o en cese ("sin que
 * mandes nada", "olvidate de escribir") tampoco, y lo que la persona anota en segunda persona
 * ("cuando registres un gasto, aparecera aqui automaticamente") si cuenta. La negacion del claim
 * ("los gastos no se anotan solos") es cierta y no se marca.
 *
 * Fuera a proposito: `guard`/`carg` (autoguardado y spinners), `ingres` (login, e "ingresos" es
 * plata que entra), `sum` (los totales SI se suman solos), `detect` (detectar suscripciones
 * sobre lo ya anotado es cierto) y el "solo" SINGULAR, que casi siempre es "solamente" ("Neto lo
 * registra solo"). Un "solos" acotado al correo tambien cae: es cierto, pero una linea no lo
 * distingue del que no esta acotado, y se escribe sin el "solos".
 *
 * ATACADO dos veces el 07-oct-2026 (40 variantes falsas y 12 legitimas, despues 42 y 28 sobre los
 * mecanismos nuevos). La primera version dejaba pasar 35 de 40 y marcaba 7 legitimas. Lo que
 * SIGUE pasando, declarado en vez de perseguido (perseguirlo es la clase
 * `tapo-el-caso-y-no-la-clase`, seis rondas el 02-oct):
 *   - sin marcador de "solo"/"automatico": sinonimos ("se cargan solos", "entran solos", "Neto se
 *     encarga", "lleva la cuenta por ti"), formulas sin verbo ("tu plata en piloto automatico",
 *     "sin tocar nada"), el marcador separado por coma, mas de seis palabras de hueco;
 *   - la accion se reconoce por la PALABRA, no por quien la hace: "y cada domingo envia un
 *     resumen" (sujeto Neto sin pronombre), una accion opcional ("y si quieres, manda una foto") o
 *     en otra clausula separada por dos puntos libera la frase. Agregar ":" al fin de frase rompe
 *     "Mandale una foto: Neto la anota automaticamente", que es cierta;
 *   - imperativos iguales a la tercera persona ("Registra un gasto y se categoriza
 *     automaticamente") y "tu sola" (= por ti misma) salen marcados: se reescriben.
 * Este patron cubre la FORMA del claim, no la familia: es `enumeracion-que-no-cubre-el-conjunto`.
 */
const NEGADO =
  String.raw`(?<!\b(?:no|nunca|ning[uú]n\w*)\s+(?:se\s+|l[oa]s?\s+|te\s+)?)` +
  // "nada" niega solo a principio de frase: en "sin tocar nada se registran solos" cierra otra clausula.
  String.raw`(?<!(?:^|[.!?—\n:¿¡]\s*)nada\s+(?:se\s+|l[oa]s?\s+|te\s+)?)`;
const VERBO_REGISTRO =
  NEGADO +
  // "al/cuando/si/mientras + verbo" es la persona registrando; "se te agregan" no es "te agregamos".
  String.raw`(?<!\b(?:al|cuando|si|mientras)\s+(?:t[uú]\s+)?)` +
  String.raw`\b(?:anot|registr|apunt|import|(?<!(?<!\bse\s)\bte\s)agreg|a[nñ]ad|captur|aparec)` +
  // Sustantivos ("registro", "anotacion", "importe") y la segunda persona ("anotas") no son Neto.
  String.raw`(?!(?:os?|as|es|aci[oó]n|aciones)\b)(?<!\bimport(?=es?\b))[a-záéíóúñ]*`;
const SUSTANTIVO_REGISTRO =
  String.raw`\b(?:registros?|anotaci[oó]n|anotaciones|importaci[oó]n)(?:\s+(?!se\s+guard)[^\s.!?—,;:]+){0,4}?\s+(?:autom[aá]tic[oa]s?|automatizad[oa]s?)\b` +
  String.raw`|\bautomatiz\w*\s+(?:[^\s.!?—,;:]+\s+){0,2}?(?:registros?|anotaci)`;
const POR_SI_SOLO =
  String.raw`(?:sol(?:it)?[oa]s\b|solit[oa]\b|(?<!\buna\s)sola\b|autom[aá]tic[a-záéíóú]*` +
  String.raw`|por\s+s[ií]\s+(?:sol[oa]s?|mism[oa]s?)\b|en\s+autom[aá]tico)`;
const ACCION_DE_LA_PERSONA =
  String.raw`(?<!\b(?:te|le|les|nos|neto)\s)` +
  String.raw`(?<!\b(?:sin|no|ni|nunca|olv[ií]date|deja|dejar|basta|adi[oó]s)\s+(?:siquiera\s+)?(?:(?:(?!olvid|dej)[^\s,;:.!?]+\s+){0,3}?(?:que|de|a)\s+)?(?:t[uú]\s+)?)` +
  String.raw`\b(?:env[ií]\w*|m[aá]nd(?!o\b)\w*|escr[ií]b\w*|d[ií]ct\w*|fot[oó]\w*|captura\s+de\s+pantalla|capturas\b|pantallazo\w*|audio\w*|(?<!\ben\s)voz|reenv[ií]\w*|s[uú]b(?!en\b|ieron\b|i[oó]\b)[eií]\w*|excel\b|csv` +
  String.raw`|(?:anot|registr|apunt|agreg|a[nñ]ad)(?:as|es|ar)\b)`;
const FIN = String.raw`[.!?—\n…]`;
const PALABRA = String.raw`[^\s.!?—,;:]+`;
const REGISTRO_AUTOMATICO = new RegExp(
  String.raw`(?:^|${FIN}\s*)(?:(?!${ACCION_DE_LA_PERSONA})[^.!?—\n…])*?` +
    String.raw`(?:${VERBO_REGISTRO}(?:\s+${PALABRA}){0,5}?\s+${POR_SI_SOLO}` +
    String.raw`|${POR_SI_SOLO}(?:\s+(?!al\b|para\b|de\b)${PALABRA}){0,2}?\s+${VERBO_REGISTRO}` +
    String.raw`|${SUSTANTIVO_REGISTRO})` +
    String.raw`(?![^.!?—\n…]*${ACCION_DE_LA_PERSONA})`,
  'i'
);

/**
 * La notificacion del banco (o de Yape/Plin, o el SMS) como mecanismo de registro. Lo que Neto
 * lee son CORREOS, asi que "correos de notificacion bancaria" pasa, "notificaciones que tu banco
 * te envia" tambien (el "que" deja abierto que sea el correo), y la captura o el pantallazo DE una
 * notificacion tambien: es el flujo de fotos, y es cierto. Nombra bancos porque
 * `bancos-prominentes` solo mira paginas publicas. Sigue sin ver "alertas" ni "avisos": "los
 * correos de alerta de tu banco" es cierto.
 */
const BANCOS = String.raw`(?:bancos?\b|BCP\b|BBVA\b|Interbank\b|Scotiabank\b|BanBif\b|Mibanco\b|Yape\b|Plin\b)`;
const NO_ES_EL_MECANISMO = String.raw`(?<!correos?\s+de\s+)(?<!(?:captura|pantallazo|foto|screenshot)s?\s+de\s+(?:la|las|tus?)\s+)`;
const NOTIFICACION_BANCARIA = new RegExp(
  String.raw`${NO_ES_EL_MECANISMO}notificaci\S*\s+(?:(?!que\b)\S+\s+){0,3}?(?:de\s+)?(?:(?:tus?|sus?|del|los|la)\s+)?(?:app\s+(?:de\s+(?:tu\s+)?|del\s+)?)?${BANCOS}` +
    String.raw`|${NO_ES_EL_MECANISMO}notificaci\S*\s+(?:(?!que\b)\S+\s+){0,2}?(?:de\s+tu\s+app\s+)?bancari` +
    String.raw`|${NO_ES_EL_MECANISMO}notificaci\S*\s+push\s+(?:\S+\s+){0,4}?(?:tus?|del|los|el)\s+${BANCOS}` +
    String.raw`|SMS\s+(?:de\s+(?:tus?\s+|los\s+)?|del\s+)?(?:${BANCOS}|bancari)`,
  'i'
);

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
  {
    id: 'registro-automatico',
    patron: REGISTRO_AUTOMATICO,
    porque: 'Ningun gasto se anota solo: el 9.5% nace de un correo (Pro, opt-in, beta) y el resto lo anota la persona. Lo que se registra sin escribir es porque la persona mando una foto, un audio o un archivo, y la frase tiene que decirlo.',
    debeMatchear: [
      'Neto detecta tus gastos de las notificaciones del banco y los anota solos.',
      'Tus gastos se anotan solos',
      'Neto registra automáticamente todos tus gastos',
      'automáticamente se registran en tu dashboard',
      'Tus movimientos se registran por sí solos, sin que mandes nada',
      // Evasiones de la primera version, encontradas atacandola:
      'Neto anota tus gastos solos y te manda un resumen cada noche.',
      'Neto lee tus comprobantes del correo y los anota solos.',
      'Con Neto, cada compra se registra sola.',
      'Tus gastos se registran solitos.',
      'Neto registra todos tus gastos del mes automáticamente.',
      'Automáticamente Neto registra tus gastos.',
      'Tus gastos se anotan solos, sin tener que escribir nada.',
      'Tus gastos se anotan por sí mismos.',
      'Neto captura tus gastos automáticamente.',
      'Registro automático de tus gastos',
      'Neto te anota tus gastos automáticamente.',
      // Evasiones de la segunda version:
      'Olvídate de escribir cada gasto: Neto los registra automáticamente.',
      'Sin tocar nada se registran automáticamente.',
      'El registro de tus gastos es automático.',
      'Tus gastos se te agregan automáticamente al dashboard.',
    ],
    noDebeMatchear: [
      'Envia tus comprobantes por WhatsApp y NETO los registra automaticamente.',
      'Neto lo registra solo',
      'No tienes categorías todavía. Crea la primera arriba, o se crearán solas al registrar gastos.',
      'Neto registra los gastos de los correos que tu banco ya te envía.',
      'Mándale una foto del voucher y Neto lo anota automáticamente',
      // Falsos positivos de la primera version:
      'Los gastos no se anotan solos: tú los anotas por WhatsApp.',
      'Nada se registra automáticamente: tú decides qué anotar.',
      'Tu registro se guarda automáticamente.',
      'Ingresa automáticamente con tu cuenta de Google.',
      'Te agregamos automáticamente al espacio al abrir el link.',
      'Elige una sola cuenta y se anota ahí.',
      // Falsos positivos de la segunda version:
      'Cuando registres un gasto por WhatsApp, aparecerá aquí automáticamente.',
      'Mándale el voucher y se anota automáticamente.',
      'No te olvides de mandar tu foto: se anota automáticamente.',
    ],
  },
  {
    // Portada de `content/scripts/verify-claims.mjs`, donde nacio por `carousel-14`. El panel Pro
    // la violaba tres veces: "notificaciones bancarias" se lee como el push o el SMS del banco, que
    // Neto no recibe. Lo que Neto lee son los CORREOS, y la frase lo tiene que decir.
    id: 'registro-por-notificacion-bancaria',
    patron: NOTIFICACION_BANCARIA,
    porque: 'Neto no recibe las notificaciones que el banco le manda a la persona. El unico canal automatico es el correo por Gmail, y es de Pro, opt-in y beta.',
    debeMatchear: [
      'Recibes notificación de tu banco — listo',
      'Neto lee tus notificaciones bancarias',
      'escaneo de SMS bancarios',
      'Neto detecta tus gastos de las notificaciones de tus bancos',
      'Neto lee las notificaciones push del banco',
      'Neto lee la notificación bancaria de cada compra',
      'Neto lee los SMS del banco',
      'Neto lee las notificaciones del BCP',
      'Neto lee las notificaciones de Yape y Plin',
    ],
    noDebeMatchear: [
      'los correos que tu banco ya te envía',
      'Neto te avisa por WhatsApp',
      'notificación de gasto',
      'únicamente sobre correos de notificación bancaria',
      'los gastos de las notificaciones que tu banco ya te envía por correo',
      'Mándale a Neto el pantallazo de la notificación de tu banco.',
    ],
  },
  {
    // Lo que se corrigio en /login el 31-jul ("una sola cuenta, sincronizada") y reaparecio tres
    // veces en la landing el 03-oct. El lookbehind deja pasar el texto o audio de un video.
    id: 'canales-sincronizados',
    patron: /(?<!(?:texto|audio|video|subt[ií]tulos?)\s)\bsincronizad[oa]s?\b|\bse\s+sincronizan?\s+sol[oa]s?\b|\bauto-?sync\b/i,
    porque: 'Conectar WhatsApp y la app no sincroniza dos cuentas: las vuelve una. Forma decidida en docs/CHANNEL-CAPABILITY-MATRIX.md: "una sola cuenta con tus datos en los dos lados", nunca auto-sync.',
    debeMatchear: ['Conéctalos y es una sola cuenta, sincronizada.', 'Conéctalos y todo queda sincronizado', 'tu WhatsApp y la app se sincronizan solos'],
    noDebeMatchear: ['¿Se sincroniza mi cuenta entre la app y WhatsApp?', 'Al conectarlos, es una sola cuenta con tus datos en los dos lados.', 'texto sincronizado que obliga a leer'],
  },
  {
    id: 'score-unico-sin-alcance',
    patron: SCORE_UNICO_SIN_ALCANCE,
    porque: 'Poqt (Brasil) tiene un score 0-100: el Score es unico en Peru, no en la categoria. La forma de la landing es "Único en Perú entre asistentes de WhatsApp".',
    debeMatchear: ['Único en Perú — ningún otro asistente de WhatsApp tiene score', 'El único asistente de WhatsApp con score financiero', 'Un score que ninguna otra app te da'],
    noDebeMatchear: ['Único en Perú entre asistentes de WhatsApp', 'ningún otro asistente de WhatsApp en Perú tiene score', 'Lo único que mide tu score es lo que anotas'],
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
