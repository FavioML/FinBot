import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as ts from '../../webapp/src/lib/gmail-conectado.ts';

const require = createRequire(import.meta.url);
const cjs = require('../../lib/gmail-conectado');

/**
 * El backend es CommonJS y la webapp TS/ESM, así que "¿tiene Gmail conectado?" vive en dos
 * archivos: `webapp/src/lib/gmail-conectado.ts` (fuente de verdad) y su espejo
 * `lib/gmail-conectado.js`.
 *
 * ESTE archivo es lo único que impide que se separen, y la divergencia que viene a prevenir ya
 * ocurrió una vez con otro nombre: el panel admin leía `usuarios.gmail_access_token` mientras el
 * cron leía `gmail_cuentas`, y durante meses la pantalla dijo "sin Gmail" sobre gente a la que
 * sí se le escaneaba la bandeja. Un desacuerdo acá no se ve: los dos lados muestran un punto.
 *
 * Si un caso falla, arregla el espejo. No relajes la comparación.
 */

// PRNG con semilla fija: cientos de casos, los mismos en cada corrida.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ordenado = (set) => [...set].sort();

function comparar(usuarios, cuentas, etiqueta) {
  const a = ts.indexarGmail(usuarios, cuentas);
  const b = cjs.indexarGmail(usuarios, cuentas);
  expect(ordenado(a.conectados), `conectados — ${etiqueta}`).toEqual(ordenado(b.conectados));
  expect(ordenado(a.caidos), `caidos — ${etiqueta}`).toEqual(ordenado(b.caidos));
  expect(ordenado(a.cupoGastado), `cupoGastado — ${etiqueta}`).toEqual(ordenado(b.cupoGastado));
  return a;
}

describe('paridad gmail-conectado TS ↔ CJS', () => {
  it('exporta lo mismo de los dos lados', () => {
    expect(typeof ts.indexarGmail).toBe('function');
    expect(typeof cjs.indexarGmail).toBe('function');
  });

  it('coincide sobre 400 escenarios aleatorios con semilla fija', () => {
    const rnd = lcg(20260901);
    for (let caso = 0; caso < 400; caso++) {
      const n = 1 + Math.floor(rnd() * 6);
      const usuarios = [];
      const cuentas = [];
      for (let i = 0; i < n; i++) {
        const id = `u${i}`;
        usuarios.push({ id, gmail_access_token: rnd() < 0.3 ? 'cifrado' : null });
        // 0, 1 o 2 filas por usuario: el modelo permite historial (una activa, otras revocadas).
        const filas = Math.floor(rnd() * 3);
        for (let k = 0; k < filas; k++) {
          // `activa` es NULLABLE en la base y el tipo lo declara así. El generador lo
          // produce a propósito: con solo `true`/`false`, una mutación del espejo a
          // `c.activa !== false` —que trata el null como conectado— pasaba en verde. Lo
          // encontró una revisión adversarial atacando este mismo archivo.
          const dado = rnd();
          cuentas.push({
            usuario_id: rnd() < 0.05 ? null : id, // huérfanas de vez en cuando
            activa: dado < 0.4 ? true : dado < 0.8 ? false : null,
            auth_error_at: rnd() < 0.3 ? '2026-09-01T00:00:00Z' : null,
          });
        }
      }
      comparar(usuarios, cuentas, `caso ${caso}`);
    }
  });

  // Anti-vacuidad: si los generadores de arriba dejaran de producir las tres poblaciones, la
  // paridad pasaría comparando conjuntos vacíos contra conjuntos vacíos. Estos casos fijan que
  // cada uno de los tres conjuntos se puebla por su propio camino.
  it('los casos fijos ejercitan los tres conjuntos', () => {
    const e = comparar(
      [
        { id: 'legacy', gmail_access_token: 'cifrado' },
        { id: 'activo', gmail_access_token: null },
        { id: 'roto', gmail_access_token: null },
        { id: 'exconectado', gmail_access_token: null },
        { id: 'nulo', gmail_access_token: null },
        { id: 'nunca', gmail_access_token: null },
      ],
      [
        { usuario_id: 'activo', activa: true, auth_error_at: null },
        { usuario_id: 'roto', activa: true, auth_error_at: '2026-09-01T00:00:00Z' },
        { usuario_id: 'exconectado', activa: false, auth_error_at: null },
        { usuario_id: 'nulo', activa: null, auth_error_at: null },
      ],
      'fijos',
    );
    expect(ordenado(e.conectados)).toEqual(['activo', 'legacy', 'roto']);
    // `activa: null` NO es una cuenta conectada. Va en los casos fijos además del PRNG
    // porque es la distinción que separa `c.activa` de `c.activa !== false`, y es la que
    // decide si el cron le escanea la bandeja a alguien que no tiene conexión viva.
    expect(ordenado(e.conectados)).not.toContain('nulo');
    expect(ordenado(e.caidos)).toEqual(['roto']);
    expect(ordenado(e.cupoGastado)).toEqual(['activo', 'exconectado', 'legacy', 'nulo', 'roto']);
  });
});
