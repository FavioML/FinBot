#!/usr/bin/env node
/**
 * Inventario de queries de `handlers/intents/`: escrituras verificadas, escrituras mudas y
 * lecturas mudas. **NO es un guard**: no corre en CI y no rompe el build.
 *
 * Existe porque el ítem 9B-bis rompió el instrumento con el que se mide este directorio. El
 * parser de `tests/cron/lecturas-leen-el-error.test.js` decide por la FORMA del lado izquierdo
 * —exige un destructuring que nombre `error`— y el arreglo de 9B-bis mueve esa lectura adentro
 * de `helpers/escritura-verificada.js`, así que un
 *
 *     const vSilencio = await verificarEscritura(supabase.from('usuarios').update(…)…)
 *
 * le sale **muda**. Medido: apuntándolo a este directorio, las mudas pasaron de 22 a 37 el día
 * que se arreglaron 15 sitios. Un inventario que empeora cuando el código mejora es peor que
 * no tenerlo: la próxima sesión —que tiene que medir las 14 lecturas mudas que 9B-bis dejó
 * abiertas a propósito— habría leído 37 y concluido lo contrario de lo que pasó.
 *
 * **El parser NO se copia: se toma del archivo de test**, recortando sus funciones top-level.
 * Es la misma decisión que el guard toma con la lista de archivos — una lista escrita a mano al
 * lado de otra que debería ser igual diverge sola. Si el parser se arregla otra vez (ya se
 * arregló dos veces, ver `d4baf49`), esto hereda el arreglo sin tocarse.
 *
 * **Lo que este script NO puede probar, declarado:** reconoce `verificarEscritura(` por su
 * NOMBRE, y un nombre es algo que el código puede fabricar solo — la trampa que
 * `feedback_guard_que_se_mide_contra_su_declaracion` describe. Se acota exigiendo que el
 * archivo además REQUIERA el helper desde `helpers/escritura-verificada`, así que una función
 * local homónima no alcanza; pero no verifica que lo que pasa por ahí sea la cadena entera ni
 * que el call-site haga algo con el veredicto. Para eso están los tests
 * (`tests/handlers/escrituras-de-intents.test.js`) y la mutación
 * (`scripts/mutar-escrituras-intents.mjs`), que sí miden comportamiento. Acá se cuenta, no se
 * bendice — y por eso no gatea nada.
 *
 * Uso:
 *   node scripts/inventario-escrituras-intents.mjs
 *   node scripts/inventario-escrituras-intents.mjs handlers/webhook.js   # otro archivo suelto
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const RAIZ = process.cwd();

// ─── El parser, tomado del guard ─────────────────────────────────────────────
const fuenteGuard = readFileSync(path.join(RAIZ, 'tests/cron/lecturas-leen-el-error.test.js'), 'utf-8');
const desde = fuenteGuard.indexOf('const RAIZ = process.cwd();');
const hasta = fuenteGuard.indexOf('\ndescribe(');
if (desde < 0 || hasta < 0) {
  console.error('No pude recortar el parser de tests/cron/lecturas-leen-el-error.test.js.');
  console.error('Cambió su forma: buscá `const RAIZ = process.cwd();` y el primer `describe(`.');
  process.exit(2);
}
const cuerpo = fuenteGuard.slice(desde, hasta).replace('const RAIZ = process.cwd();', '');
const construir = new Function('readFileSync', 'readdirSync', 'statSync', 'path', 'RAIZ',
  cuerpo + '\nreturn { lecturas, leeElError };');
const { lecturas, leeElError } = construir(readFileSync, readdirSync, statSync, path, RAIZ);

// ─── La única regla propia ───────────────────────────────────────────────────
const HELPER = 'helpers/escritura-verificada';
const NOMBRE_HELPER = 'verificarEscritura';

/**
 * ¿Esta query está envuelta por el helper? Se mira hacia ATRÁS desde el ancla, dentro del mismo
 * statement, que es la misma ventana que usa el parser (`;` anterior). No alcanza con que la
 * cadena aparezca en el archivo.
 */
function envueltaPorElHelper(src, indiceAncla) {
  const statement = src.slice(src.lastIndexOf(';', indiceAncla) + 1, indiceAncla);
  return statement.includes(NOMBRE_HELPER + '(');
}

const objetivo = process.argv[2];
const archivos = objetivo
  ? [objetivo.split(path.sep).join('/')]
  : readdirSync(path.join(RAIZ, 'handlers/intents'))
    .filter((f) => f.endsWith('.js')).map((f) => 'handlers/intents/' + f);

let verificadas = 0; let escriturasMudas = 0; let lecturasMudas = 0;
const detalle = [];

for (const rel of archivos) {
  const src = readFileSync(path.join(RAIZ, rel), 'utf-8');
  const importaHelper = src.includes(HELPER);
  // El parser blanquea literales y comentarios; para ubicar el statement hay que recorrer el
  // fuente con el mismo criterio, así que se reusan sus índices por LÍNEA y no por offset.
  const lineas = src.split('\n');
  const offsetDeLinea = (n) => lineas.slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0);

  const v = []; const em = []; const lm = [];
  for (const q of lecturas(src, rel)) {
    const anclaAprox = offsetDeLinea(q.linea) + (lineas[q.linea - 1] || '').length;
    const envuelta = importaHelper && envueltaPorElHelper(src, anclaAprox);
    if (envuelta) { v.push(q.linea); continue; }
    if (q.lhs === null) { em.push(q.linea); continue; }
    if (!leeElError(q.lhs, q.indice)) lm.push(q.linea);
  }
  verificadas += v.length; escriturasMudas += em.length; lecturasMudas += lm.length;
  if (v.length || em.length || lm.length) detalle.push({ rel, v, em, lm });
}

const fmt = (etiqueta, arr) => (arr.length ? `   ${etiqueta} (${arr.length}): ${arr.join(', ')}\n` : '');
for (const d of detalle) {
  process.stdout.write(d.rel + '\n'
    + fmt('escrituras VERIFICADAS      ', d.v)
    + fmt('escrituras MUDAS            ', d.em)
    + fmt('lecturas   MUDAS            ', d.lm));
}
process.stdout.write(`\nTOTAL  verificadas=${verificadas}  escrituras mudas=${escriturasMudas}  lecturas mudas=${lecturasMudas}\n`);
