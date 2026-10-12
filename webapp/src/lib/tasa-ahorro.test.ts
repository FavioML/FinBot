import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tasaDeAhorro, etiquetaTasaDeAhorro } from './tasa-ahorro';

/**
 * El hero móvil del dashboard mostraba `ahorro / ingresos` del mes con la etiqueta
 * "vs mes anterior". El caso real: ingresos S/3,450, gastos S/2,600 y S/338.70 de
 * ahorro el mes anterior; la pantalla decía "+24.6% vs mes anterior" cuando el
 * ahorro casi se triplicó. Estos tests atan el número a lo que dice su etiqueta.
 */

const SRC = join(process.cwd(), 'src');
const leer = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('tasaDeAhorro', () => {
  it('es la parte de los ingresos del MISMO mes que no se gastó', () => {
    expect(tasaDeAhorro(3450, 2600)).toBeCloseTo(24.638, 3);
    expect(tasaDeAhorro(1000, 1000)).toBe(0);
    expect(tasaDeAhorro(1000, 1200)).toBeCloseTo(-20, 6);
  });

  it('sin ingresos no hay tasa (no divide por cero)', () => {
    expect(tasaDeAhorro(0, 500)).toBe(0);
  });
});

describe('etiquetaTasaDeAhorro', () => {
  it('dice de qué es el porcentaje', () => {
    expect(etiquetaTasaDeAhorro(tasaDeAhorro(3450, 2600))).toBe('24.6% de tus ingresos');
    expect(etiquetaTasaDeAhorro(-20)).toBe('-20.0% de tus ingresos');
  });

  it('no promete una comparación con otro mes que la cuenta no hace', () => {
    for (const p of [24.6, -20, 0.1]) {
      expect(etiquetaTasaDeAhorro(p)).not.toMatch(/mes anterior|mes pasado|\bvs\b/i);
    }
  });
});

describe('el dashboard usa este módulo para calcular y para rotular', () => {
  it('page.tsx calcula ahorroPorcentaje con tasaDeAhorro', () => {
    expect(leer('app/dashboard/page.tsx')).toMatch(/ahorroPorcentaje\s*=\s*tasaDeAhorro\(/);
  });

  it('kpi-cards.tsx no formatea el porcentaje a mano ni lo rotula como comparación', () => {
    const src = leer('components/dashboard/kpi-cards.tsx');
    // Las dos superficies (hero móvil y tarjeta de escritorio) pasan por la etiqueta.
    expect(src.match(/etiquetaTasaDeAhorro\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Formatear el número a mano es como volvió a separarse de su etiqueta.
    expect(src).not.toMatch(/orcentaje\s*\.toFixed\(/);
    // ComparisonBadge (ingresos/gastos) no lleva texto: "mes anterior" acá solo puede
    // ser este badge mal rotulado. Una comparación real del ahorro necesita su propio
    // cálculo (prevAhorro) y entonces este test se actualiza junto con ella.
    expect(src).not.toMatch(/mes anterior/i);
  });
});
