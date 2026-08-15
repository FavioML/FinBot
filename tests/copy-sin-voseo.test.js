import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Neto le habla a peruanos, de TÚ. El voseo argentino se coló tres veces y llegó a producción:
// dos mensajes de WhatsApp y —peor— un ejemplo dentro del prompt de recomendaciones, desde
// donde el modelo lo podía propagar a todo lo que genera.
//
// Solo formas INEQUÍVOCAS: cada una de estas es voseo y nada más. Ojo con las tentadoras que
// NO se pueden incluir porque tienen homónimo válido en español peruano:
//   - `decí`   choca con "decía" (pasado de decir, correctísimo)
//   - `sos`    aparece dentro de palabras y en siglas
//   - `escribí`/`agregué` son primera persona del pasado
// El precio de esa prudencia es que el guard no atrapa TODO el voseo posible; el beneficio es
// que no tiene falsos positivos, que es lo que hace que alguien lo apague.
const VOSEO = [
  'querés', 'podés', 'tenés', 'sabés', 'necesitás', 'debés', 'tendrías que ver vos',
  'decime', 'contame', 'mirá', 'andá', 'fijate', 'fijáte', 'dejame que te diga vos',
  'agregá', 'escribí vos', 'elegí vos', 'poné', 'sacá', 'guardá', 'revisá', 'probá',
];
// El 15-ago-2026 se me escapó un `confirmá` en un aviso al admin y este guard no lo vio. Lo
// agregué a la lista y hubo que sacarlo: el match es por SUBCADENA, así que `confirmá` prende
// dentro de `confirmárselo` y `confirmándole` —español impecable— y salieron 3 falsos positivos
// en archivos que nadie tocó. Es la trampa que el comentario de arriba ya advertía.
//
// Se podría arreglar exigiendo borde de palabra, pero eso cambia el matching de las 23 formas
// existentes y las hace MÁS ciegas en el otro sentido: `poné` dejaría de atrapar `ponéle`. La
// decisión es no tocarlo: el guard prefiere perderse voseo antes que tener falsos positivos,
// porque un guard con falsos positivos termina apagado. La forma se pescó igual, revisando.

// Runtime que produce texto para el usuario, más el prompt de recomendaciones (que no es
// runtime pero alimenta al modelo, y un ejemplo con voseo ahí vale por mil mensajes).
const OBJETIVOS = ['handlers', 'services', 'lib', 'cron', 'routes', 'helpers'];
const ARCHIVOS_SUELTOS = ['docs/NETO_recomendaciones_prompt.md'];

function recolectar(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recolectar(p, acc);
    else if (/\.(js|mjs|ts)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

describe('el copy le habla a peruanos, de tú', () => {
  it('no hay voseo argentino en el runtime ni en el prompt de recomendaciones', () => {
    const archivos = [
      ...OBJETIVOS.flatMap(d => recolectar(path.join(RAIZ, d))),
      ...ARCHIVOS_SUELTOS.map(f => path.join(RAIZ, f)),
    ];
    const hallazgos = [];
    const exentas = [];
    for (const archivo of archivos) {
      const lineas = fs.readFileSync(archivo, 'utf8').split('\n');
      lineas.forEach((linea, i) => {
        // Única exención: la instrucción del prompt que ENUMERA las formas prohibidas, que
        // por definición las contiene. Está contada abajo para que no sea una puerta abierta.
        if (linea.includes('voseo-ok')) { exentas.push(`${path.relative(RAIZ, archivo)}:${i + 1}`); return; }
        for (const forma of VOSEO) {
          if (new RegExp('\\b' + forma + '\\b', 'i').test(linea)) {
            hallazgos.push(`${path.relative(RAIZ, archivo)}:${i + 1}  «${forma}»  ${linea.trim().slice(0, 90)}`);
          }
        }
      });
    }
    expect(hallazgos, 'Voseo argentino encontrado. Neto tutea:\n' + hallazgos.join('\n')).toEqual([]);
    // El conteo está fijado a propósito: `voseo-ok` es una vía de evasión, así que agregar
    // una exención nueva ROMPE el build y obliga a justificarla en el diff.
    expect(exentas, 'Exenciones `voseo-ok` (fijadas a 1):\n' + exentas.join('\n')).toHaveLength(1);
  });

  // El guard mismo: si la lista queda vacía o las formas dejan de detectarse, arriba pasa
  // verde por vacuidad y nadie se entera.
  it('las formas de la lista SÍ se detectan (el guard no es vacío)', () => {
    expect(VOSEO.length).toBeGreaterThan(10);
    const fixture = 'return "Si querés corregirlo, decime y lo hago";';
    const detecta = VOSEO.some(f => new RegExp('\\b' + f + '\\b', 'i').test(fixture));
    expect(detecta).toBe(true);
  });

  // Y que no se pase de listo: estas son palabras legítimas que aparecen en el árbol real.
  it('no marca español peruano correcto', () => {
    for (const ok of ['decía que no', 'lo escribí ayer', 'ya agregué la fila', 'sos_token', 'quieres corregirlo', 'dime el monto']) {
      const falsoPositivo = VOSEO.find(f => new RegExp('\\b' + f + '\\b', 'i').test(ok));
      expect(falsoPositivo, `"${ok}" marcado por «${falsoPositivo}»`).toBeUndefined();
    }
  });
});
