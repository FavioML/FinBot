#!/usr/bin/env node
/**
 * Mutación sobre los guards de `{ error }` del perímetro de crons.
 *
 * Neutraliza UNA guarda por vez (`if (err)` → `if (false)`, que deja el error destructurado y
 * descartado: exactamente el bug original) y corre los tests. Una guarda que sobrevive es una
 * guarda sin test — el código quedó arreglado y nada lo sostiene.
 *
 * **El script AFIRMA que la mutación se aplicó, y esa línea no es defensiva.** La corrida
 * equivalente del ítem 1 reportó "sobrevive" sobre dos reemplazos que nunca tocaron el archivo:
 * el patrón no matcheaba, el reemplazo era un no-op, los tests pasaban —porque el código estaba
 * intacto— y eso se leyó como cobertura faltante. Una mutación que no se aplicó y una que el
 * test no atrapa producen el MISMO verde. Acá, si el contenido no cambia, es error fatal.
 *
 * Uso:
 *   node scripts/mutar-lecturas-error.mjs            # los 3 archivos de test del perímetro
 *   node scripts/mutar-lecturas-error.mjs --completa # cada superviviente contra la suite entera
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * **El perímetro se DERIVA, igual que en el guard.**
 *
 * Acá había una lista de seis archivos escrita a mano, al lado del guard que deriva diecisiete
 * — o sea la divergencia que el docblock de ese guard condena, reintroducida en el archivo de
 * al lado. Quedaban sin mutar las guardas de `neto-score.js`, `recommendations.js`,
 * `spending-alerts.js` y `subscriptions/detector.js`, justo los que ese docblock celebra haber
 * incorporado. Lo encontró una revisión adversarial.
 *
 * Se reimplementa en vez de importarse del test: son dos mecanismos a propósito. Una copia
 * literal sólo detecta que editaste una de las dos.
 */
const blanco = (m) => m.replace(/[^\n]/g, ' ');
const sinComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, blanco).replace(/\/\/[^\n]*/g, blanco);

function archivosDe(servicio) {
  const base = path.join(process.cwd(), 'services', servicio);
  try {
    if (statSync(base).isDirectory()) {
      return readdirSync(base).filter((f) => f.endsWith('.js')).map((f) => 'services/' + servicio + '/' + f);
    }
  } catch { /* archivo suelto */ }
  return ['services/' + servicio + '.js'];
}

function perimetro(entrada) {
  const vistos = new Set();
  const cola = [entrada];
  const out = [];
  while (cola.length) {
    const rel = cola.shift();
    if (vistos.has(rel)) continue;
    vistos.add(rel);
    out.push(rel);
    let src;
    try { src = sinComentarios(readFileSync(rel, 'utf-8')); } catch { continue; }
    const dir = path.posix.dirname(rel);
    const re = /require\(\s*['"](\.[\w./-]+?)(?:\.js)?['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const abs = path.posix.normalize(path.posix.join(dir, m[1]));
      if (!abs.startsWith('services/')) continue;
      for (const f of archivosDe(abs.slice('services/'.length))) if (!vistos.has(f)) cola.push(f);
    }
  }
  return out;
}

const ARCHIVOS = perimetro('cron/checks.js');

const TESTS = [
  'tests/cron/lecturas-con-error.test.js',
  'tests/cron/lecturas-servicios-con-error.test.js',
  'tests/cron/lecturas-leen-el-error.test.js',
];

/**
 * Toda guarda cuya condición es el error de una lectura/escritura de supabase, **incluida la
 * disyunción**.
 *
 * La primera versión sólo aceptaba una variable suelta, y con eso `if (errSpace || errMiembros)`
 * —la guarda de población de `shared-spaces.js`, escrita en este mismo trabajo— quedaba fuera
 * del barrido. No aparecía como superviviente: no aparecía. Un mutador que no ve una guarda la
 * reporta como cubierta por omisión, que es la misma trampa que la mutación que no se aplica.
 */
const ERR = '(?:err[A-Za-z0-9_]*|error)';
/**
 * **La condicion se cierra BALANCEANDO parentesis, no con un regex.**
 *
 * La version anterior exigia que el `)` viniera pegado a la variable, asi que veia
 * `if (error)` y `if (errA || errB)` pero NO `if (error && error.code !== 'PGRST116')` — que
 * es la forma obligada de toda guarda sobre un `.single()`, porque `PGRST116` es "cero filas"
 * y no un fallo. Habia dos en el arbol antes del item 8 (`categories.js`, `pro-payment`) y el
 * item 8 agrego dos mas. Ninguna aparecia como superviviente: no aparecia, que es la misma
 * trampa que el docblock de arriba describe para la disyuncion.
 */
const ARRANQUE = new RegExp(`^([ \\t]*)(?:\\}\\s*)?(?:else\\s+)?if \\(\\s*(${ERR})\\b`, 'gm');

function guardasDe(src) {
  const out = [];
  let m;
  ARRANQUE.lastIndex = 0;
  while ((m = ARRANQUE.exec(src)) !== null) {
    // Desde el `(` de la condicion hasta su `)`, contando anidamiento.
    const abre = src.indexOf('(', m.index);
    let prof = 0;
    let cierra = -1;
    for (let i = abre; i < src.length; i++) {
      if (src[i] === '(') prof++;
      else if (src[i] === ')') { prof--; if (prof === 0) { cierra = i; break; } }
      else if (src[i] === '\n' && prof === 0) break;
    }
    if (cierra < 0) continue;
    const texto = src.slice(m.index, cierra + 1);
    out.push({
      inicio: m.index, largo: texto.length, texto,
      variable: src.slice(abre + 1, cierra).trim(),
      linea: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

function corre(tests) {
  try {
    execSync(`npx vitest run ${tests.join(' ')}`, { stdio: 'pipe', encoding: 'utf-8' });
    return true;   // verde = la mutación SOBREVIVIÓ
  } catch {
    return false;  // rojo = la mutación murió, que es lo que se quiere
  }
}

const completa = process.argv.includes('--completa');
const sobrevivientes = [];
let total = 0;

/**
 * **El baseline, y sin él este script puede mentir del lado cómodo.**
 *
 * `corre()` lee cualquier exit distinto de cero como "la mutación murió". Si los tests están
 * rojos por un motivo ajeno —un fixture mal armado, una env var, un archivo a medio editar—
 * TODAS las mutaciones salen muertas y el script imprime "Ninguna sobrevivió" con exit 0. Es
 * exactamente la clase de verde falso que este mismo archivo combate para el caso "la mutación
 * no se aplicó", un nivel más arriba. Lo encontró una revisión adversarial.
 */
if (!corre(TESTS)) {
  console.error('El árbol LIMPIO ya sale rojo: sin baseline verde, "muere" no significa nada.');
  console.error('Corré los tests a mano y arreglá eso antes de mutar.');
  process.exit(1);
}

/**
 * Este script ESCRIBE el árbol vivo. Sin esto, un Ctrl-C entre dos corridas de vitest deja una
 * guarda neutralizada (`if (false)`) en el working tree — que es la forma exacta del bug
 * original y se pierde en un `git diff` largo.
 */
let enVuelo = null;
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    if (enVuelo) { writeFileSync(enVuelo.archivo, enVuelo.original); console.error('\nrestaurado ' + enVuelo.archivo); }
    process.exit(130);
  });
}

for (const archivo of ARCHIVOS) {
  const original = readFileSync(archivo, 'utf-8');
  const guardas = guardasDe(original);
  console.log(`\n=== ${archivo}: ${guardas.length} guardas`);

  for (const g of guardas) {
    total++;
    // `g.texto` es exactamente `if (<condicion balanceada>)`, asi que se reemplaza entero.
    const sangria = g.texto.slice(0, g.texto.indexOf('if ('));
    const mutado = original.slice(0, g.inicio) + sangria + 'if (false)' + original.slice(g.inicio + g.largo);

    // LA afirmación. Sin esto, un patrón que no matchea se reporta como "sobrevive".
    if (mutado === original) {
      console.error(`\nFATAL: la mutación de ${archivo}:${g.linea} NO cambió el archivo.`);
      writeFileSync(archivo, original);
      process.exit(1);
    }

    enVuelo = { archivo, original };
    writeFileSync(archivo, mutado);
    let vive;
    try {
      vive = corre(TESTS);
      if (vive && completa) vive = corre([]);   // ¿lo mata algún otro test de la suite?
    } finally {
      writeFileSync(archivo, original);
      enVuelo = null;
    }

    const marca = vive ? 'SOBREVIVE' : 'muere    ';
    console.log(`  ${marca}  ${archivo}:${g.linea}  if (${g.variable})`);
    if (vive) sobrevivientes.push(`${archivo}:${g.linea}  if (${g.variable})`);
  }
}

console.log(`\n──────────────────────────────────────────`);
console.log(`${total - sobrevivientes.length}/${total} mutaciones muertas.`);
if (sobrevivientes.length) {
  console.log(`\n${sobrevivientes.length} SOBREVIVIENTES (guardas sin test que las sostenga):`);
  for (const s of sobrevivientes) console.log('  ' + s);
  process.exit(1);
}
console.log('Ninguna sobrevivió.');
