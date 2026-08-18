// Segunda medición: la capa que la primera sonda señaló (parsearRegistroManual) NO es
// determinista. `temperature: 0` en gpt-4o-mini reduce la varianza, no la elimina, así que
// "pasó una vez" y "está arreglado" son afirmaciones distintas. Esta sonda corre SOLO el
// parser, N veces por mensaje, y reporta la tasa de éxito.
//
// Sin esto no se puede separar "este mensaje rompe el parser" de "este mensaje está en el
// borde y falla a veces" — y el arreglo correcto es distinto para cada caso.
//
// Read-only, cero DB. Costo: N llamadas gpt-4o-mini por mensaje.
//
// Correr:  node qa-e2e/probe-parser-montos-tasa.mjs [N]   (desde app/, default N=5)

import 'dotenv/config';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parsearRegistroManual } = require(path.join(appRoot, 'services/parsers.js'));

const N = Number(process.argv[2] || 5);

// Los mensajes que la sonda 1 dejó en la capa del parser (llegaron a registrar_manual y
// pasaron el pre-check), más los CONTROLES del mismo usuario que sí entraron. Los controles
// no son decorativos: si también fluctúan, el problema no es "estos mensajes".
const MENSAJES = [
  { g: 'decimal corto, con preposición', msg: 'Gasté 1.5 en Movilidad', fecha: '2026-08-17', esp: 'REBOTE' },
  { g: 'decimal corto, con preposición', msg: 'Gasté 2.5 en Movilidad', fecha: '2026-08-17', esp: 'REBOTE' },
  { g: 'decimal, sin verbo', msg: '11.30 para Snack', fecha: '2026-08-17', esp: 'REBOTE' },
  { g: 'decimal, sin preposición', msg: 'Gasté 14.8 Alimentos', fecha: '2026-08-14', esp: 'REBOTE' },
  { g: 'decimal, sin preposición', msg: 'Gaste 2.5 transporte', fecha: '2026-08-13', esp: 'REBOTE' },
  { g: 'decimal, sin verbo', msg: 'Caramelos 2.50 soles', fecha: '2026-06-22', esp: 'REBOTE' },
  { g: 'entero chico, con preposición', msg: 'Gaste 2 en snack', fecha: '2026-06-13', esp: 'REBOTE' },
  { g: 'entero chico, con preposición', msg: '4 en pan y maca', fecha: '2026-08-11', esp: 'REBOTE' },
  { g: 'entero chico, sin verbo', msg: '10 comida', fecha: '2026-06-02', esp: 'REBOTE' },
  { g: 'número en palabras', msg: 'Carne, ciento noventa y ocho punto setenta.', fecha: '2026-08-07', esp: 'REBOTE' },
  { g: 'número en palabras', msg: 'Carne, ciento diez punto setenta.', fecha: '2026-08-07', esp: 'REBOTE' },
  { g: 'multi-ítem en un mensaje', msg: 'Pancito Chapala 3 \nQueso fresco 6.24 \nYogurt la Molina 11', fecha: '2026-07-27', esp: 'REBOTE' },
  { g: 'multi-ítem en un mensaje', msg: 'Eso lo tengo yape 156.40 y Plin 100', fecha: '2026-04-13', esp: 'REBOTE' },
  { g: 'monto pelado / saldo', msg: '592.91', fecha: '2026-08-01', esp: 'REBOTE' },
  { g: 'ingreso recurrente', msg: 'Yo gano al mes cada 05 487.50', fecha: '2026-04-13', esp: 'REBOTE' },
  { g: 'imperativo', msg: 'Agrega 120 a comida', fecha: '2026-03-28', esp: 'REBOTE' },

  { g: 'CONTROL entero, sin preposición', msg: 'Gasté 13 almuerzo', fecha: '2026-08-14', esp: 'OK' },
  { g: 'CONTROL decimal, sin preposición', msg: 'Gasté 9.40 taxi', fecha: '2026-08-13', esp: 'OK' },
  { g: 'CONTROL entero, sin verbo', msg: '8 taxi', fecha: '2026-06-01', esp: 'OK' },
  { g: 'CONTROL onboarding', msg: 'gasté 20 en taxi', fecha: '2026-08-18', esp: 'OK' },
  { g: 'CONTROL palabras + verbo', msg: 'Gasté en carne ciento diez punto setenta soles.', fecha: '2026-08-07', esp: 'OK' },
  { g: 'CONTROL entero, sin verbo', msg: '280 en lavado de cortinas de la casa', fecha: '2026-08-17', esp: 'OK' },
];

console.log('parsearRegistroManual — ' + N + ' corridas por mensaje (gpt-4o-mini, temperature 0)\n');
const filas = [];
for (const m of MENSAJES) {
  const montos = [];
  let ok = 0;
  for (let i = 0; i < N; i++) {
    let p;
    try { p = await parsearRegistroManual(m.msg, m.fecha); } catch (e) { p = { ok: false, _err: e.message }; }
    const bien = !!(p.ok && p.monto > 0);
    if (bien) ok++;
    montos.push(bien ? p.monto : (p._err ? 'ERR' : 'x'));
  }
  const fila = { grupo: m.g, msg: m.msg, esperado: m.esp, ok, n: N, montos };
  filas.push(fila);
  const flag = m.esp === 'OK' ? (ok === N ? '  ' : '!!') : (ok === 0 ? '  ' : (ok === N ? '  ' : '~~'));
  console.log(flag + ' ' + String(ok + '/' + N).padEnd(5)
    + JSON.stringify(m.msg).padEnd(54) + ' ' + m.g.padEnd(30) + ' ' + montos.join(' '));
}

console.log('\n  leyenda:  ~~ = INESTABLE (a veces entra, a veces rebota)   !! = un control falló');

const inest = filas.filter((f) => f.ok > 0 && f.ok < f.n);
const siempreFalla = filas.filter((f) => f.esperado === 'REBOTE' && f.ok === 0);
const siempreEntra = filas.filter((f) => f.esperado === 'REBOTE' && f.ok === f.n);
const ctrlRoto = filas.filter((f) => f.esperado === 'OK' && f.ok < f.n);
console.log('\n== RESUMEN ==');
console.log('  rebotes que fallan SIEMPRE (' + N + '/' + N + ' fallidas): ' + siempreFalla.length);
console.log('  rebotes INESTABLES (entran a veces):          ' + inest.filter((f) => f.esperado === 'REBOTE').length);
console.log('  rebotes que hoy entran SIEMPRE:               ' + siempreEntra.length);
console.log('  controles que fallaron alguna vez:            ' + ctrlRoto.length);

fs.writeFileSync(path.join(appRoot, 'qa-e2e', 'out-parser-montos-tasa.json'), JSON.stringify(filas, null, 2));
console.log('\nDetalle -> qa-e2e/out-parser-montos-tasa.json');
