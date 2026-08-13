// Todo INSERT en `usuarios` desde `qa-e2e/` va con `is_test_user`.
//
// Por qué hace falta un guard estático y no alcanza con `qa-guard`: la barrera de
// `qa-e2e/lib/qa-guard.mjs` solo ve clientes de supabase-js, y varios harness usan su propio
// cliente REST crudo A PROPÓSITO (`qa-bsuid-username.mjs`: "este harness es el ORÁCULO, y
// compartir cliente con el código bajo prueba deja de serlo"). Esos quedan fuera de la barrera
// por diseño, y son justamente los que le pegan a producción.
//
// Lo que se paga sin la marca, medido el 13-ago-2026: el harness siembra `whatsapp = '519' +
// 8 dígitos AL AZAR` —el espacio de los celulares peruanos reales—, así que
//   1. `enviarWhatsapp` llama a Meta de verdad para ese número, y
//   2. `avisarPrimeraVezSilencioso` le manda a Favio un Telegram con el comando del probe ya
//      armado sobre él, indistinguible del evento real que ese detector existe para avisar.
// Y si el borrado falla, la persona dueña del número queda MUDA (ver qa-usuarios-marcados.mjs).
//
// El commit `afca4ee` arregló eso con dos literales `is_test_user: true`. Borrarlos dejaba toda
// la suite en verde: el fix no traía nada que impidiera la regresión. Esto lo impide.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const aquí = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:');
const QA_DIR = path.resolve(aquí, '..', 'qa-e2e');

// Sitios que siembran SIN la marca a propósito. Cada exención se justifica acá, que es el punto
// de la lista: la excepción tiene que ser una decisión visible, no un olvido.
//
// Hoy está VACÍA, y conviene que se entienda por qué antes de agregarle algo. Se intentó una
// exención para darle cobertura viva a `avisarPrimeraVezSilencioso` —sembrar un usuario sin la
// marca, que es el caso real— y `qa-guard` la bloqueó: prohíbe insertar en `usuarios` sin
// `is_test_user` porque esas filas entran al embudo y a las métricas como un alta real. Esa
// regla vale más que la cobertura, así que el aviso se prueba unitario (5 tests en
// tests/handlers/webhook-bsuid-media.test.js) y su supresión se asevera viva en
// qa-bsuid-media.mjs contra `h.telegrams`. El hueco que queda está escrito en docs/DEFECTOS.md.
const EXENTOS = [];

function archivosQa() {
  return fs.readdirSync(QA_DIR).filter((f) => f.endsWith('.mjs'));
}

// Devuelve el texto del objeto que se está insertando, desde la llave de apertura hasta su
// cierre balanceado. Contar llaves y no cortar por N caracteres importa: un insert con un objeto
// anidado se truncaría y `is_test_user` quedaría afuera del pedazo mirado, dando un falso rojo.
function objetoInsertado(texto, desde) {
  const abre = texto.indexOf('{', desde);
  if (abre === -1) return null;
  let nivel = 0;
  for (let i = abre; i < texto.length; i++) {
    if (texto[i] === '{') nivel++;
    else if (texto[i] === '}') {
      nivel--;
      if (nivel === 0) return texto.slice(abre, i + 1);
    }
  }
  return null;
}

// Las dos formas que aparecen en el árbol: el cliente REST propio (`sb.insert('usuarios', {…})`)
// y supabase-js (`.from('usuarios').insert({…})`).
const FORMAS = [
  /\binsert\(\s*['"]usuarios['"]\s*,/g,
  /\.from\(\s*['"]usuarios['"]\s*\)\s*\.insert\(/g,
];

function siembras() {
  const out = [];
  for (const archivo of archivosQa()) {
    const texto = fs.readFileSync(path.join(QA_DIR, archivo), 'utf8');
    for (const forma of FORMAS) {
      for (const m of texto.matchAll(forma)) {
        const obj = objetoInsertado(texto, m.index + m[0].length - 1);
        out.push({
          archivo,
          linea: texto.slice(0, m.index).split('\n').length,
          objeto: obj,
          marcado: !!obj && /\bis_test_user\s*:\s*true\b/.test(obj),
        });
      }
    }
  }
  return out;
}

function estaExento(s) {
  return EXENTOS.some((e) => e.archivo === s.archivo && s.objeto && s.objeto.includes(e.marcador));
}

describe('siembra de `usuarios` desde qa-e2e', () => {
  // Si esto da 0, el guard es verde por vacuidad: alguien cambió la forma del insert (o movió
  // los harness) y el test dejó de mirar nada, sin ponerse rojo. Es el modo de falla de todo
  // guard que busca por patrón, y ya me pasó tenerlo verde por exactamente esto.
  it('encuentra las siembras que dice vigilar', () => {
    const s = siembras();
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(new Set(s.map((x) => x.archivo)).size).toBeGreaterThanOrEqual(2);
    // Y que sepa leer el objeto: un `objeto` null es el parser fallando, no un insert sin marca.
    expect(s.filter((x) => x.objeto === null)).toEqual([]);
  });

  it('todas llevan is_test_user salvo las exentas declaradas', () => {
    const culpables = siembras()
      .filter((s) => !s.marcado && !estaExento(s))
      .map((s) => `${s.archivo}:${s.linea}`);
    expect(culpables).toEqual([]);
  });

  it('cada exención sigue existiendo (una exención muerta oculta que el guard se aflojó)', () => {
    for (const e of EXENTOS) {
      const texto = fs.readFileSync(path.join(QA_DIR, e.archivo), 'utf8');
      expect(texto.includes(e.marcador), `exención muerta: ${e.archivo} ya no contiene ${e.marcador}`).toBe(true);
    }
  });

  it('las exentas son exentas de verdad: no llevan la marca', () => {
    const exentasMarcadas = siembras()
      .filter((s) => estaExento(s) && s.marcado)
      .map((s) => `${s.archivo}:${s.linea}`);
    expect(exentasMarcadas).toEqual([]);
  });
});
