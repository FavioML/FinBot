import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validarMonto } = require('../lib/validators');

/**
 * D8 — la validación de montos de deudas vivía SOLO en el código.
 *
 * El hallazgo original hablaba de las policies `FOR ALL` de `public` con `with_check` NULL.
 * Medido: eso NO es un agujero de aislamiento — Postgres reusa el `USING` como `WITH CHECK`
 * cuando no hay uno explícito, así que nadie escribe sobre filas ajenas. Lo que sí podía
 * hacer el dueño es escribir con SU anon key (que viaja en el browser) directo contra
 * PostgREST y saltearse `validarMonto`.
 *
 * La migración 068 lo cierra con CHECKs, que además cubren al service-role —que ignora RLS
 * por completo— o sea al próximo endpoint del backend que se olvide de validar. Verificado
 * contra prod con un probe transaccional: rechaza negativo, rechaza sobre el tope, acepta un
 * monto válido, y hace rollback (62 deudas y 44 abonos intactos, residuo cero).
 *
 * Este guard vigila lo único que un test unitario puede vigilar acá: que los topes de la
 * migración no se separen de los de `validarMonto`. Dos fuentes para el mismo número divergen
 * solas, y este repo ya lo pagó con `FREE_LIMITS`.
 */

const TOPE = 999999.99;

describe('D8 — los CHECK de deudas dicen lo mismo que validarMonto', () => {
  const sql = fs.readFileSync(path.join(projectRoot, 'migrations', '068_deudas_montos_check.sql'), 'utf8');

  it('la migración existe y declara los tres CHECK', () => {
    for (const c of ['deudas_monto_original_rango', 'deudas_monto_pendiente_rango', 'deuda_abonos_monto_rango']) {
      expect(sql, `falta ${c}`).toContain(c);
    }
  });

  it('el tope de la migración es el mismo que el de validarMonto', () => {
    // Si alguien sube el tope en `lib/validators.js` y no en la migración, la app acepta un
    // monto que la DB rechaza: el usuario ve un 500 en vez de un mensaje.
    expect(validarMonto(TOPE)).toBe(TOPE);
    expect(validarMonto(TOPE + 0.01)).toBeNull();
    const topes = [...sql.matchAll(/<=\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    expect(topes.length).toBe(3);
    for (const t of topes) expect(t).toBe(TOPE);
  });

  it('el piso coincide: los montos de deuda son estrictamente positivos', () => {
    expect(validarMonto(0)).toBeNull();
    expect(validarMonto(-1)).toBeNull();
    expect(validarMonto(0.01)).toBe(0.01);
    // Las dos columnas de monto "que se cobra" exigen > 0.
    expect(sql).toMatch(/monto_original\s*>\s*0/);
    expect(sql).toMatch(/monto\s*>\s*0/);
  });

  it('monto_pendiente admite 0: es una deuda saldada, no un monto inválido', () => {
    expect(sql).toMatch(/monto_pendiente\s*>=\s*0/);
  });

  it('los CHECK toleran NULL (no cambian la nulabilidad de las columnas)', () => {
    // Cambiar la forma de la tabla y agregar rangos en la misma migración mezcla dos cosas
    // que fallan por motivos distintos.
    for (const col of ['monto_original', 'monto_pendiente', 'monto']) {
      expect(sql).toMatch(new RegExp(col + '\\s+IS NULL OR'));
    }
  });
});
