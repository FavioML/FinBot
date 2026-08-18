// Cuarta medición: aislar QUÉ token rompe el parser.
//
// El barrido descartó la magnitud: "Gasté X en Movilidad" falla con 0.5 y con 20, mientras
// "gasté X en taxi" entra con los dos. O sea que la variable no es el monto. Entre esas dos
// plantillas cambian TRES cosas a la vez (mayúscula del verbo, mayúscula del sustantivo,
// y qué sustantivo es), así que ninguna se puede acusar todavía.
//
// Esto las separa una por una, con el monto FIJO. Cada fila cambia exactamente un token
// respecto de la de arriba.
//
// Read-only, cero DB. Correr:  node qa-e2e/probe-parser-montos-aislar.mjs [N]   (default 4)

import 'dotenv/config';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parsearRegistroManual } = require(path.join(appRoot, 'services/parsers.js'));

const N = Number(process.argv[2] || 4);
const FECHA = '2026-08-18';

// Monto fijo (10) en todos: el barrido ya mostró que el monto no manda.
const VARIANTES = [
  ['A. base que FALLA', 'Gasté 10 en Movilidad'],
  ['B. sustantivo en minúscula', 'Gasté 10 en movilidad'],
  ['C. verbo en minúscula', 'gasté 10 en Movilidad'],
  ['D. los dos en minúscula', 'gasté 10 en movilidad'],
  ['E. base que ENTRA', 'gasté 10 en taxi'],
  ['F. verbo capitalizado', 'Gasté 10 en taxi'],
  ['G. sustantivo capitalizado', 'gasté 10 en Taxi'],
  ['H. verbo sin tilde', 'Gaste 10 en Movilidad'],
  ['I. otro sustantivo capitalizado', 'Gasté 10 en Farmacia'],
  ['J. mismo, minúscula', 'Gasté 10 en farmacia'],
  ['K. sustantivo inventado, minúscula', 'Gasté 10 en zarandaja'],
  ['L. sustantivo inventado, capitalizado', 'Gasté 10 en Zarandaja'],
  ['M. capitalizado + soles', 'Gasté 10 soles en Movilidad'],
  ['N. capitalizado + S/', 'Gasté S/10 en Movilidad'],
  ['O. capitalizado, sin verbo', '10 en Movilidad'],
  ['P. capitalizado, otra prep.', 'Gasté 10 para Movilidad'],
];

console.log('Aislamiento de token — monto fijo S/10, ' + N + ' corridas por variante\n');
const filas = [];
for (const [etiqueta, msg] of VARIANTES) {
  let ok = 0;
  for (let i = 0; i < N; i++) {
    let p;
    try { p = await parsearRegistroManual(msg, FECHA); } catch (e) { p = { ok: false }; }
    if (p.ok && p.monto > 0) ok++;
  }
  filas.push({ etiqueta, msg, ok, n: N });
  const marca = ok === N ? 'ENTRA ' : (ok === 0 ? 'REBOTA' : 'MIXTO ');
  console.log('  ' + marca + ' ' + String(ok + '/' + N).padEnd(5) + etiqueta.padEnd(36) + JSON.stringify(msg));
}

fs.writeFileSync(path.join(appRoot, 'qa-e2e', 'out-parser-montos-aislar.json'), JSON.stringify(filas, null, 2));
console.log('\nDetalle -> qa-e2e/out-parser-montos-aislar.json');
