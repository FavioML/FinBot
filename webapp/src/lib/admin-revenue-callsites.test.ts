import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, sep } from 'path';

/**
 * El modo de falla que este archivo existe para atrapar NO es un crash: es un MRR creíble
 * y falso.
 *
 * `computeRevenue` decide por `is_test_user` y por `cuenta_borrada_at`. Las dos llegan de
 * un `.select()` explícito de PostgREST, así que una columna que no se pide llega como
 * `undefined` — y `undefined` es falsy, o sea que la fila entra al MRR **como si nunca se
 * hubiera dado de baja**. Todo verde, ningún error, y el número mal. Ya pasó con
 * `is_test_user` el 2026-08-02: dos cuentas de prueba sumaban S/20 sobre S/56 reales.
 *
 * **Este guard va por la TERCERA versión, y las dos anteriores murieron por el mismo error
 * de fondo: preguntaban por el ARCHIVO en vez de preguntar por el `.select()`.**
 *
 *  1. La primera buscaba la columna en el TEXTO completo del archivo. Pasaba en verde con
 *     la columna borrada del select, porque el comentario que la explica —el que yo mismo
 *     había escrito arriba— contiene la palabra. Se medía contra su propia documentación.
 *  2. La segunda borraba los comentarios y extraía los selects, pero seguía preguntando
 *     "¿ALGÚN select de este archivo pide la columna?" y descubría a los consumidores por
 *     el texto literal `computeRevenue(`. Una revisión adversarial la evadió de cuatro
 *     formas: renombrando el import (`computeRevenue as calcularIngreso`), llamando a la
 *     función desde un helper fuera de `api/admin/`, agregando una SEGUNDA query a
 *     `usuarios` que sí traía las columnas mientras la principal las perdía, y partiendo el
 *     nombre de la columna con un comentario en el medio, que el propio borrado de
 *     comentarios volvía a pegar.
 *
 * Lo que cambia acá:
 *
 *  · **La regla ya no es sobre los consumidores, es sobre los SELECTS.** Todo `.select()`
 *    sobre `usuarios` en las rutas admin tiene que pedir las columnas, o declararse exento
 *    por escrito. Así deja de importar cómo se llame la función que consume la fila.
 *  · **Se lee el argumento del `.select()` tal cual**, sin borrar comentarios: si adentro
 *    hay un `/*` o un `//`, es fallo, porque el string que recibe PostgREST no es el que
 *    parece. Ese caso además fallaba del lado silencioso (PostgREST rechaza la columna,
 *    `data` viene null y el panel sale en ceros).
 *  · **`computeRevenue` solo puede llamarse desde donde este guard mira.** Un helper
 *    escondido en otra carpeta deja de ser una salida.
 */

const SRC = join(process.cwd(), 'src');
const API_ADMIN = join(SRC, 'app', 'api', 'admin');
const LIB = join(SRC, 'lib');

/**
 * Columnas de las que dependen las decisiones de `admin-revenue.ts` y que PostgREST no trae
 * si no se piden. `id` está por una razón menos obvia: es la llave con la que se busca si
 * ese usuario volvió a pagar, y una fila sin `id` no puede probar un retorno, así que
 * quedaría contada como baja para siempre.
 */
const COLUMNAS_QUE_DECIDEN = [
  'id',
  'is_test_user',
  'cuenta_borrada_at',
  // `plan` y `trial_estado` son las DOS caras de `esProPagado`, y la segunda es la que más
  // daño hace: `plan === 'premium' && trialEstado !== 'activo'`, así que sin la columna
  // `undefined !== 'activo'` da true y TODO TRIAL cuenta como pagador. Medido contra
  // producción el 18-ago: 9 Pro pagados contra 31 en trial, o sea que el MRR pasaba de S/90
  // a ~S/400 con la suite entera en verde. Es la misma clase del 02-ago (S/20 sobre S/56)
  // que este archivo existe para atrapar, con un cero más.
  'plan',
  'trial_estado',
  // El precio: sin ella un anual se valora como mensual (S/10 en vez de S/8.25).
  'tipo_plan',
];

/**
 * La salida de emergencia, y es una DECISIÓN escrita, no un silencio. Poner este marcador
 * arriba de un `.select()` de `usuarios` dice "esta fila no alimenta métricas de ingreso".
 * El guard lista las que hay, así que agregar una se ve en el diff.
 */
const MARCA_EXENTA = 'admin-revenue:no-alimenta-metricas';

/** Espacios y comentarios de encadenado al principio de un fragmento. */
const ESPACIO_O_COMENTARIO = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/;

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entrada.name);
    if (entrada.isDirectory()) out.push(...archivosTs(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * El código sin comentarios, SOLO para preguntar "¿este archivo llama a X?".
 *
 * Es la tercera vez que aparece el mismo error en este guard, y la más irónica: el
 * comentario que declara una exención nombra a `computeRevenue` para explicar por qué esa
 * lectura NO lo usa, y con eso el archivo pasaba a contar como consumidor. Un guard que lee
 * su propia documentación como si fuera código se equivoca en las dos direcciones.
 *
 * Ojo con el alcance: esto NO se usa para leer el cuerpo de un `.select()`. Ahí el texto
 * tiene que ir crudo, porque un comentario adentro del string es parte del problema.
 */
function codigoSinComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const llama = (p: string, simbolo: string) =>
  codigoSinComentarios(readFileSync(p, 'utf8')).includes(simbolo);

const rel = (p: string) => p.replace(process.cwd(), '').split(sep).join('/');
const esTest = (p: string) => p.endsWith('.test.ts') || p.endsWith('.test.tsx');

/** Archivos donde SÍ puede vivir un cálculo de ingreso: rutas admin y `lib/admin-*`. */
const ARCHIVOS_ADMIN = [
  ...archivosTs(API_ADMIN),
  ...archivosTs(LIB).filter((p) => /admin-[^/\\]*\.ts$/.test(p)),
].filter((p) => !esTest(p));

interface Seleccion {
  archivo: string;
  /** El argumento del `.select()`, crudo. `null` si no es un literal verificable. */
  columnas: string | null;
  exento: boolean;
  crudo: string;
}

/**
 * Los `.select(...)` que cuelgan de un `.from('usuarios')`. Acepta comillas simples, dobles
 * y template literal en las dos posiciones, porque el objetivo es que NINGUNA forma se
 * escape: una que el patrón no reconozca tiene que caer como "no verificable", no como
 * "no existe".
 */
/**
 * El cuerpo del string de columnas que arranca en `resto` (justo después de `.select(`), o
 * `null` si no se puede afirmar nada sobre lo que viaja a PostgREST.
 *
 * Se lee carácter a carácter en vez de con un regex de una línea por dos motivos que ya
 * costaron una versión del guard cada uno:
 *
 *  · Los comentarios que van ENTRE el paréntesis y el string son legítimos y frecuentes acá
 *    (las dos rutas explican ahí por qué piden `is_test_user`). Un `[^)]*` los tragaba y el
 *    select entero quedaba como "no verificable".
 *  · El cuerpo se devuelve TAL CUAL, sin borrarle comentarios. Un `/*` adentro del nombre
 *    de una columna es lo que viaja a PostgREST, que rechaza la query y devuelve `null`.
 *    Borrarlo antes de comparar volvía a pegar el nombre y el guard salía verde sobre un
 *    select roto.
 */
function literalDelSelect(resto: string): string | null {
  const limpio = resto.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  const comilla = limpio[0];
  // Un `.select(COLUMNAS)` armado en una variable no es verificable, y eso es un fallo, no
  // una excepción: no se puede afirmar qué columnas se piden.
  if (comilla !== "'" && comilla !== '"' && comilla !== '`') return null;
  let cuerpo = '';
  for (let i = 1; i < limpio.length; i++) {
    const c = limpio[i];
    if (c === '\\') {
      cuerpo += limpio[i + 1] ?? '';
      i++;
      continue;
    }
    if (c === comilla) {
      if (cuerpo.includes('${')) return null;
      // El literal tiene que ser TODO el argumento. Devolver en la comilla de cierre dejaba
      // invisible cualquier sufijo de expresion: `.select('...cuenta_borrada_at...'
      // .replace(', cuenta_borrada_at', ''))` salia verde con la columna fuera de la query
      // real. Lo que sigue solo puede ser el cierre del `.select(` o una coma (un segundo
      // argumento como `{ count: 'exact' }`).
      const sigue = limpio.slice(i + 1).replace(ESPACIO_O_COMENTARIO, '');
      return /^[),]/.test(sigue) ? cuerpo : null;
    }
    cuerpo += c;
  }
  return null; // string sin cerrar dentro de la ventana
}

function seleccionesDeUsuarios(archivo: string, src: string): Seleccion[] {
  const out: Seleccion[] = [];
  // Se barren TODOS los `.from(...)`, no solo los que dicen `'usuarios'` literal. Un
  // `.from(TABLA)` con el nombre en una constante --o con un comentario metido adentro del
  // parentesis-- hacia que ese `.select()` dejara de existir para el guard: la query seguia
  // siendo valida y el MRR salia mal EN SILENCIO, que es el peor de los dos resultados. Un
  // `.from()` que no se puede LEER es un fallo, no una ausencia: sin poder leerlo no se
  // puede afirmar que esa ruta no toca `usuarios`.
  // El `(?<!Array)` no es cosmetico: `Array.from(...)` matchea igual y metia cinco falsos
  // positivos que habrian empujado a aflojar la regla.
  for (const m of src.matchAll(/(?<!Array)\.from\(([^)]*)\)/g)) {
    const tabla = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const nombre = tabla.match(/^(['"`])([^'"`]*)\1$/);
    if (!nombre) {
      out.push({ archivo, columnas: null, exento: false, crudo: `.from(${tabla.slice(0, 40)})` });
      continue;
    }
    if (nombre[2] !== 'usuarios') continue; // otra tabla: no es asunto de este guard
    const desde = m.index! + m[0].length;
    const ventana = src.slice(desde, desde + 1200);
    // El marcador de exención se busca en el texto ANTERIOR al `.from`, sin borrar
    // comentarios: es un comentario a propósito.
    const exento = src.slice(Math.max(0, m.index! - 500), m.index!).includes(MARCA_EXENTA);
    // El `.select()` va PEGADO al `.from()` en supabase-js. Buscarlo "en los próximos N
    // caracteres" atribuía mal: un `.from('usuarios').update(...)` se quedaba con el
    // `.select('premium_vence')` de la sentencia siguiente y lo reportaba como si le
    // faltaran columnas. Así que solo se mira lo que viene INMEDIATAMENTE después, saltando
    // espacios y comentarios de encadenado.
    const pegado = ventana.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
    // Una escritura no lee filas: no hay columnas que exigirle.
    if (/^\.(update|delete|insert|upsert)\(/.test(pegado)) continue;
    if (!pegado.startsWith('.select(')) {
      out.push({ archivo, columnas: null, exento, crudo: pegado.slice(0, 60) });
      continue;
    }
    out.push({
      archivo,
      exento,
      crudo: pegado.slice(0, 80),
      columnas: literalDelSelect(pegado.slice('.select('.length)),
    });
  }
  return out;
}

/**
 * Las columnas pedidas sobre `usuarios`, sin las de una tabla EMBEBIDA.
 *
 * PostgREST permite `select('id, pagos(id, monto)')`, y partir por comas a secas contaba
 * `monto` como columna de `usuarios`. Se colaba al reves: pedir `pagos(cuenta_borrada_at)`
 * satisfacia al guard sin traer la columna que decide.
 */
function columnasDeLaTabla(sel: string): string[] {
  let plano = sel;
  let antes;
  do {
    antes = plano;
    plano = plano.replace(/\([^()]*\)/g, '');
  } while (plano !== antes);
  return plano.split(/\s*,\s*/).map((c) => c.trim());
}

const selecciones = ARCHIVOS_ADMIN.flatMap((p) =>
  seleccionesDeUsuarios(p, readFileSync(p, 'utf8')),
);
const verificables = selecciones.filter((s) => !s.exento);

describe('todo select de usuarios en las rutas admin pide las columnas que deciden', () => {
  // Antivacuidad. Si el barrido deja de encontrar archivos o selects (se movió la carpeta,
  // cambió la extensión, el patrón dejó de matchear), todos los casos de abajo pasarían sin
  // mirar nada. Un guard que no mira es peor que ninguno, porque además tranquiliza.
  it('encuentra archivos y selects que revisar', () => {
    expect(ARCHIVOS_ADMIN.length).toBeGreaterThan(3);
    expect(verificables.length).toBeGreaterThan(0);
  });

  it('cada select es un literal verificable', () => {
    const opacos = verificables.filter((s) => s.columnas === null);
    expect(opacos.map((s) => `${rel(s.archivo)}: ${s.crudo.slice(0, 60)}`)).toEqual([]);
  });

  // Un comentario DENTRO del string de columnas parte el nombre en dos. Borrar comentarios
  // antes de comparar lo volvía a pegar, así que el guard leía una cadena distinta de la que
  // viaja a PostgREST — que rechaza la columna, devuelve `data: null`, y con el error
  // descartado el panel sale en ceros en silencio.
  it('ningún select lleva comentarios adentro', () => {
    const conComentario = verificables.filter(
      (s) => s.columnas !== null && (s.columnas.includes('/*') || s.columnas.includes('//')),
    );
    expect(conComentario.map((s) => rel(s.archivo))).toEqual([]);
  });

  it.each(COLUMNAS_QUE_DECIDEN)('todos piden %s', (columna) => {
    const sinLaColumna = verificables.filter(
      (s) => s.columnas !== null && !columnasDeLaTabla(s.columnas).includes(columna),
    );
    expect(sinLaColumna.map((s) => rel(s.archivo))).toEqual([]);
  });

  // Las exenciones son un inventario, no un cajón. Si aparece una nueva, esta lista cambia y
  // hay que mirarla: cada una es una fila de `usuarios` que alguien declaró irrelevante para
  // el ingreso.
  it('las exenciones declaradas siguen siendo las mismas', () => {
    expect(selecciones.filter((s) => s.exento).map((s) => rel(s.archivo))).toEqual([
      '/src/app/api/admin/surveys/route.ts', // ponerle nombre a quien respondió una encuesta
      '/src/app/api/admin/users/route.ts', // extender Pro sobre un usuario puntual
    ]);
  });
});

/**
 * El otro modo de falla, y el compilador no lo ve: el índice de pagos armado con la query
 * equivocada.
 *
 * `computeRevenue` exige el índice, así que olvidarlo no compila. Lo que sí compila es
 * armarlo con la query de al lado: las dos rutas leen `pagos` filtrando `created_at >=
 * inicio de mes` para `cajaDelMes`. Un índice hecho con ESAS filas no tiene el pago de quien
 * volvió el mes pasado, así que el panel lo saca del MRR estando al día — un cliente que
 * paga, borrado del ingreso, sin un solo error.
 */
describe('el índice de pagos sale del único cargador', () => {
  const propios = (p: string) =>
    p.endsWith('admin-revenue.ts') || p.endsWith('admin-revenue-db.ts');
  const usanRevenue = ARCHIVOS_ADMIN.filter((p) => llama(p, 'computeRevenue'));

  it('hay al menos un consumidor', () => {
    expect(usanRevenue.filter((p) => !propios(p)).length).toBeGreaterThan(0);
  });

  it('cada consumidor pide el índice con cargarPagosConPlata', () => {
    const sinCargador = usanRevenue
      .filter((p) => !propios(p))
      .filter((p) => !llama(p, 'cargarPagosConPlata'));
    expect(sinCargador.map(rel)).toEqual([]);
  });

  it('nadie arma el índice a mano fuera del cargador', () => {
    const aMano = ARCHIVOS_ADMIN.filter(
      (p) => !propios(p) && llama(p, 'indexarPagosConPlata('),
    );
    expect(aMano.map(rel)).toEqual([]);
  });

  /**
   * Y que no exista una salida por afuera. Renombrar el import
   * (`computeRevenue as calcularIngreso`) o llamar a la función desde un helper en otra
   * carpeta hacía invisible a la ruta: no aparecía como consumidora y su `.select()` no se
   * revisaba. Acotando DÓNDE puede vivir la llamada, esa evasión deja de existir.
   */
  it('computeRevenue solo se llama desde las rutas admin o lib/admin-*', () => {
    const permitidos = new Set(ARCHIVOS_ADMIN.map(rel));
    const intrusos = archivosTs(SRC)
      .filter((p) => !esTest(p))
      .filter((p) => !permitidos.has(rel(p)))
      .filter((p) => llama(p, 'computeRevenue'));
    expect(intrusos.map(rel)).toEqual([]);
  });
});

/**
 * Las ventanas de mes de los charts se arman con `monthWindowLima`, no con el constructor
 * local. `new Date(y, m + 1, 0, 23, 59, 59)` es hora del SERVIDOR: en Vercel (TZ=UTC) el
 * "fin de mes" son las 18:59:59 de Lima, y desde que `cuenta_borrada_at` —un timestamptz—
 * decide, esas cinco horas mueven una baja de mes. No se reproduce local, donde el proceso
 * corre en TZ Lima y el mismo constructor da otra cosa.
 */
describe('los meses de los charts salen del helper de Lima', () => {
  const conBucleDeMeses = ARCHIVOS_ADMIN.filter((p) =>
    /mrrAtMonthEnd|churnedInMonth|newProInMonth/.test(codigoSinComentarios(readFileSync(p, 'utf8'))),
  );

  it('hay rutas con bucle de meses', () => {
    expect(conBucleDeMeses.filter((p) => !p.endsWith('admin-revenue.ts')).length).toBeGreaterThan(0);
  });

  it('ninguna arma el mes con el constructor local', () => {
    const aMano = conBucleDeMeses.filter((p) =>
      /new Date\(\s*(now|date)\.getFullYear\(\)/.test(codigoSinComentarios(readFileSync(p, 'utf8'))),
    );
    expect(aMano.map(rel)).toEqual([]);
  });

  it('todas usan monthWindowLima', () => {
    const sinHelper = conBucleDeMeses
      .filter((p) => !p.endsWith('admin-revenue.ts'))
      .filter((p) => !llama(p, 'monthWindowLima'));
    expect(sinHelper.map(rel)).toEqual([]);
  });
});
