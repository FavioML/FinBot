#!/usr/bin/env node
/**
 * Mutación sobre el arreglo del ítem 22: el aviso del autocierre de soporte, y **de qué lado
 * de la línea se apaga**.
 *
 * El arreglo es de dos líneas, así que la pregunta no es "¿está cubierto?" sino una más fina:
 * los DOS caminos del mismo autocierre tienen que estar sostenidos por tests DISTINTOS.
 *
 *   · `abrirSesion` (el que pidió soporte) → autocierre SIN aviso, o el bot se desmiente en
 *     dos mensajes seguidos ("Volví a ser tu asistente" / "Modo soporte activado").
 *   · `message-processor` (el que no pidió nada) → autocierre CON aviso, o alguien le
 *     pregunta algo al equipo y recibe a Neto hablándole de gastos.
 *
 * Las cuatro familias, y por qué ninguna sobra:
 *
 *  · **M1 — revertir el arreglo.** Es el defecto original. Muere sólo por el caso nuevo.
 *  · **M2 — el arreglo EQUIVOCADO**: silenciar dentro de `obtenerSesionAbierta`. Desde el
 *    caso de `/soporte` se ve idéntico al arreglo bueno, así que si M2 muriera por ese caso
 *    la pareja de tests no estaría midiendo lo que dice. Tiene que morir por el del RUTEO.
 *  · **M3 — silenciar saltándose el autocierre.** El aviso también desaparece si la sesión
 *    vencida no se cierra, y eso deja `yaAbierta: true` sobre una sesión muerta. Sin esta
 *    familia, un `abrirSesion` que no cierre nada pasa en verde.
 *  · **M4 — invertir el default.** El default es lo único que protege a un llamador futuro:
 *    en `false`, quien agregue una llamada hereda el silencio sin enterarse.
 *
 * **Lo que este script exige antes de creerle a una mutación, y es la razón por la que lee
 * JSON y no el exit code** (defecto propio del 01-sep, clase `rojo-que-no-es-de-la-asercion`):
 * la primera versión corría con `--reporter=basic`, que en vitest 4 no existe, así que las
 * cuatro corridas morían en un *Startup Error* y las cuatro mutaciones se reportaron MUERTAS
 * sin que hubiera corrido un solo test. Un arranque roto sale con el mismo exit 1 que una
 * aserción rota. Por eso acá una mutación sólo cuenta como muerta si:
 *
 *   1. el reporte JSON existe (si no, la corrida no midió nada),
 *   2. el total de casos iguala al del baseline (una corrida truncada no cuenta), y
 *   3. entre los casos fallidos está **el que esa mutación apunta por nombre**.
 *
 * Uso:  node scripts/mutar-aviso-autocierre-soporte.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const P = 'lib/support-tickets.js';
const OUT = path.join(os.tmpdir(), 'mutar-aviso-autocierre-soporte.json');
const orig = fs.readFileSync(P, 'utf8');
const restaurar = () => fs.writeFileSync(P, orig);
process.on('SIGINT', () => { restaurar(); process.exit(130); });
process.on('uncaughtException', (e) => { restaurar(); console.error(e); process.exit(1); });

function correr() {
  try { fs.unlinkSync(OUT); } catch { /* no existía */ }
  let verde = true;
  try {
    execSync(`npx vitest run tests/lib/ --reporter=json --outputFile=${JSON.stringify(OUT)}`, { stdio: 'pipe' });
  } catch { verde = false; }
  // Sin reporte no hay medición: es el modo de falla que este script existe para no repetir.
  if (!fs.existsSync(OUT)) throw new Error('la corrida no dejó reporte JSON: no midió nada');
  const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const casos = (j.testResults || []).flatMap((f) => f.assertionResults || []);
  return { verde, total: casos.length, fallidos: casos.filter((a) => a.status === 'failed').map((a) => a.title) };
}

const MUTS = [
  { nombre: 'M1 · revertir el arreglo: abrirSesion vuelve a pedir el autocierre CON aviso',
    de: 'obtenerSesionAbierta(usuarioId, { avisarAutocierre: false })',
    a: 'obtenerSesionAbierta(usuarioId)',
    debeMorir: /soporte sobre una sesión vencida/ },
  { nombre: 'M2 · el arreglo EQUIVOCADO: silenciar dentro de obtenerSesionAbierta',
    de: 'avisarUsuario: avisarAutocierre, porInactividad: true',
    a: 'avisarUsuario: false, porInactividad: true',
    debeMorir: /a las 3 horas de silencio/ },
  { nombre: 'M3 · silenciar SALTÁNDOSE el autocierre',
    de: 'const existente = await obtenerSesionAbierta(usuarioId, { avisarAutocierre: false });',
    a: 'const existente = null; await Promise.resolve(usuarioId);',
    debeMorir: /soporte sobre una sesión vencida/ },
  { nombre: 'M4 · invertir el default: un llamador nuevo hereda el SILENCIO',
    de: 'async function obtenerSesionAbierta(usuarioId, { avisarAutocierre = true } = {}) {',
    a: 'async function obtenerSesionAbierta(usuarioId, { avisarAutocierre = false } = {}) {',
    debeMorir: /a las 3 horas de silencio/ },
];

const base = correr();
if (!base.verde) {
  console.error('baseline ROJO: ' + base.fallidos.join(' | '));
  process.exit(1);
}
console.log(`baseline VERDE (${base.total} casos en tests/lib/)\n`);

let problemas = 0;
for (const m of MUTS) {
  const n = orig.split(m.de).length - 1;
  if (n !== 1) { console.log(`${m.nombre}\n  ⚠️  no se pudo aplicar (matches=${n})\n`); problemas++; continue; }
  const mutado = orig.replace(m.de, m.a);
  // La mutación que no editó el archivo se ve igual que la que ningún test atrapa.
  if (mutado === orig) { console.log(`${m.nombre}\n  ⚠️  el archivo NO cambió\n`); problemas++; continue; }
  fs.writeFileSync(P, mutado);
  let r;
  try { r = correr(); } finally { restaurar(); }

  if (r.total !== base.total) {
    console.log(`${m.nombre}\n  ⚠️  corrida truncada: ${r.total} casos vs ${base.total} del baseline — no cuenta\n`);
    problemas++; continue;
  }
  const suyos = r.fallidos.filter((t) => m.debeMorir.test(t));
  const ok = !r.verde && suyos.length > 0;
  console.log(m.nombre);
  if (ok) console.log(`  MUERE ✅ por: ${suyos.join(' | ')}`);
  else if (r.verde) console.log('  SOBREVIVE ❌ — esa línea no la sostiene ningún test');
  else console.log(`  ❌ murió, pero NO por el caso que le toca. Fallidos: ${r.fallidos.join(' | ') || '(ninguno)'}`);
  console.log('');
  if (!ok) problemas++;
}

restaurar();
console.log(problemas === 0 ? 'Las 4 mueren por su propio caso.' : `${problemas} problema(s).`);
process.exit(problemas === 0 ? 0 : 1);
