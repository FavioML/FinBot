// Tercera medición: separar MAGNITUD de FRASEO.
//
// La sonda de tasa dejó una correlación sospechosa: los mensajes que fallan siempre llevan
// montos chicos (1.5 / 2.5 / 4) y los que entran siempre llevan montos grandes (13 / 14.8 /
// 20 / 120 / 280), con las MISMAS palabras alrededor. Correlación no es causa: puede ser el
// vocabulario ("Movilidad" vs "taxi") y no el número.
//
// Esto lo separa con un barrido factorial: la misma plantilla con distintos montos, y el
// mismo monto con distintas plantillas. Si falla por magnitud, "gasté 1.5 en taxi" —una
// plantilla que pasa 5/5 con 20— tiene que fallar.
//
// Registra ADEMÁS el JSON crudo del modelo, para saber si devuelve ok:false o un monto que
// después se descarta: no es lo mismo arreglar el prompt que arreglar la validación.
//
// Read-only, cero DB. Correr:  node qa-e2e/probe-parser-montos-barrido.mjs [N]   (default 3)

import 'dotenv/config';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { openai } = require(path.join(appRoot, 'lib/ai.js'));
const { parsearRegistroManual } = require(path.join(appRoot, 'services/parsers.js'));

const N = Number(process.argv[2] || 3);
const FECHA = '2026-08-18';

// Espía sobre el modelo para guardar la respuesta CRUDA. `parsearRegistroManual` aplica
// después el fallback sub-1 y el handler descarta por `!monto || monto <= 0`; sin el crudo
// no se sabe en cuál de los tres pasos se pierde el monto.
const crudos = [];
const createReal = openai.chat.completions.create.bind(openai.chat.completions);
openai.chat.completions.create = async (params, ...rest) => {
  const res = await createReal(params, ...rest);
  crudos.push(res.choices[0].message.content.trim());
  return res;
};

const MONTOS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 14.8, 20, 50];
const PLANTILLAS = [
  { id: 'verbo+en+sust', f: (m) => 'Gasté ' + m + ' en Movilidad' },
  { id: 'verbo+en+taxi', f: (m) => 'gasté ' + m + ' en taxi' },
  { id: 'verbo+sust', f: (m) => 'Gasté ' + m + ' Alimentos' },
  { id: 'num+sust', f: (m) => m + ' taxi' },
  { id: 'verbo+en+soles', f: (m) => 'gasté ' + m + ' soles en taxi' },
];

async function tasa(msg) {
  let ok = 0;
  const detalle = [];
  for (let i = 0; i < N; i++) {
    crudos.length = 0;
    let p;
    try { p = await parsearRegistroManual(msg, FECHA); } catch (e) { p = { ok: false, _err: e.message }; }
    const bien = !!(p.ok && p.monto > 0);
    if (bien) ok++;
    detalle.push({ bien, crudo: crudos[0] || null, parsed: p });
  }
  return { ok, detalle };
}

console.log('Barrido monto x plantilla — ' + N + ' corridas por celda (gpt-4o-mini, temperature 0)\n');
const cab = 'plantilla'.padEnd(18) + MONTOS.map((m) => String(m).padStart(6)).join('');
console.log(cab);
console.log('-'.repeat(cab.length));

const filas = [];
for (const pl of PLANTILLAS) {
  const celdas = [];
  let linea = pl.id.padEnd(18);
  for (const m of MONTOS) {
    const msg = pl.f(m);
    const r = await tasa(msg);
    celdas.push({ monto: m, msg, ok: r.ok, n: N, crudos: r.detalle.map((d) => d.crudo) });
    linea += String(r.ok + '/' + N).padStart(6);
  }
  console.log(linea);
  filas.push({ plantilla: pl.id, celdas });
}

console.log('\n== Qué devuelve el modelo cuando falla (una muestra por plantilla) ==');
for (const f of filas) {
  const fallida = f.celdas.find((c) => c.ok === 0);
  if (fallida) console.log('  ' + f.plantilla.padEnd(18) + JSON.stringify(fallida.msg).padEnd(30) + ' -> ' + fallida.crudos[0]);
  else console.log('  ' + f.plantilla.padEnd(18) + '(ninguna celda falló siempre)');
}

// Umbral por plantilla: el monto más chico a partir del cual entra en las N corridas.
console.log('\n== Umbral por plantilla (monto mínimo que entra ' + N + '/' + N + ') ==');
for (const f of filas) {
  const primera = f.celdas.find((c) => c.ok === N);
  const inestables = f.celdas.filter((c) => c.ok > 0 && c.ok < N).map((c) => c.monto);
  console.log('  ' + f.plantilla.padEnd(18) + (primera ? 'S/ ' + primera.monto : 'ninguno')
    + (inestables.length ? '   (inestables: ' + inestables.join(', ') + ')' : ''));
}

fs.writeFileSync(path.join(appRoot, 'qa-e2e', 'out-parser-montos-barrido.json'), JSON.stringify(filas, null, 2));
console.log('\nDetalle -> qa-e2e/out-parser-montos-barrido.json');
