#!/usr/bin/env node
/**
 * Comprueba, leyendo R2 de vuelta, que el backup del dia existe y es plausible.
 *
 * Que el job de backup termine en verde no prueba nada por si solo: puede
 * haber subido un objeto de 200 bytes, o haber subido bien ayer y hoy no.
 * Esto mira el bucket como lo miraria alguien que necesita restaurar.
 *
 * No descifra nada (aca no vive la clave privada), asi que se limita a lo que
 * se puede saber desde afuera: cuando es el mas reciente y cuanto pesa
 * comparado con los anteriores.
 */
import { list } from './r2.mjs';

const HORAS_MAX = 36;          // margen sobre 24h para tolerar atrasos del cron
const CAIDA_MAX = 0.5;         // no puede pesar menos de la mitad de la mediana

const objetos = (await list('daily/')).filter((o) => o.key.endsWith('.tar.gz.age'));

if (objetos.length === 0) {
  console.error('FALLA: no hay ningun backup en daily/');
  process.exit(1);
}

objetos.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
const ultimo = objetos[0];
const horas = (Date.now() - new Date(ultimo.lastModified).getTime()) / 3600000;

console.log(`ultimo:   ${ultimo.key}`);
console.log(`subido:   ${ultimo.lastModified} (hace ${horas.toFixed(1)} h)`);
console.log(`peso:     ${ultimo.size} bytes`);
console.log(`en daily: ${objetos.length} backups`);

const problemas = [];

if (horas > HORAS_MAX) {
  problemas.push(`el backup mas reciente tiene ${horas.toFixed(1)} h (maximo ${HORAS_MAX})`);
}

if (ultimo.size < 100000) {
  problemas.push(`pesa ${ultimo.size} bytes, demasiado poco para esta base`);
}

// Comparar contra la mediana de los anteriores detecta el caso feo: un dump
// que "funciona" pero salio recortado. Un backup que encoge a la mitad de un
// dia para otro es un incidente, no una variacion.
const previos = objetos.slice(1, 8).map((o) => o.size).sort((a, b) => a - b);
if (previos.length >= 3) {
  const mediana = previos[Math.floor(previos.length / 2)];
  const ratio = ultimo.size / mediana;
  console.log(`mediana de los ${previos.length} previos: ${mediana} bytes (ratio ${ratio.toFixed(2)})`);
  if (ratio < CAIDA_MAX) {
    problemas.push(`pesa ${(ratio * 100).toFixed(0)}% de la mediana previa (${mediana} bytes): posible dump recortado`);
  }
} else {
  console.log('(aun no hay suficientes backups previos para comparar tamanos)');
}

// El requisito es retener al menos 7 dias. Avisa, pero no falla mientras el
// sistema se esta llenando los primeros dias.
if (objetos.length < 7) {
  console.log(`aviso: solo ${objetos.length} backups, la ventana de 7 dias aun no esta completa`);
}

if (problemas.length) {
  console.error('\nFALLA la verificacion de frescura:');
  for (const p of problemas) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nok: hay un backup fresco y de tamano plausible en R2');
