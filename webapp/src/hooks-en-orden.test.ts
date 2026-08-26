import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

/**
 * Ningún componente puede llamar un hook DESPUÉS de un `return` temprano.
 *
 * POR QUÉ EXISTE (22-ago-2026)
 *
 * `/dashboard/presupuestos` estuvo **11 días** cayendo al error boundary del dashboard.
 * El fix del hallazgo F6 (`45bf872`, 12-ago) agregó un `useMemo` debajo de los tres
 * `return` de carga/sesión/error: el primer render ejecutaba 12 hooks y el siguiente 13,
 * o sea React #310, *"rendered more hooks than during the previous render"*. Y no era el
 * único: `components/dashboard/top-merchants.tsx` tenía DOS hooks debajo de su corte por
 * lista vacía, en el **dashboard home**.
 *
 * Lo que más enseña del episodio no es el bug: es que **el control ya estaba instalado y
 * nadie lo corría**. `eslint-config-next/core-web-vitals` trae `react-hooks/rules-of-hooks`
 * en nivel error desde siempre, y `npm run lint` existe en el `package.json`. El job
 * `webapp` del CI corre `tsc` + tests, no lint, así que la regla estaba en el repo sin
 * gatear nada. Un linter que no corre en el camino del deploy es documentación.
 *
 * POR QUÉ NO ES `npm run lint` A SECAS EN EL CI
 *
 * Hoy `eslint src` reporta 22 errores, y 20 son de otras reglas (el compilador de React
 * quejándose de `setState` dentro de efectos, entidades sin escapar). Meter eso al gate
 * dejaría el deploy rojo por deuda preexistente y la reacción sería apagarlo. Este guard
 * gatea SOLO la regla cuya violación tira una pantalla entera. Subir el resto del estándar
 * es otro trabajo, y este archivo no lo bloquea.
 */

const REGLA = 'react-hooks/rules-of-hooks';
const RAIZ = path.resolve(__dirname, '..');

function violaciones(resultados: ESLint.LintResult[]) {
  return resultados.flatMap((r) =>
    r.messages
      .filter((m) => m.ruleId === REGLA)
      .map((m) => `${path.relative(RAIZ, r.filePath)}:${m.line} — ${m.message}`),
  );
}

const FIXTURE_ROTO = `
  'use client';
  import { useMemo, useState } from 'react';
  export function Roto({ items }: { items: number[] }) {
    const [n] = useState(0);
    if (items.length === 0) return null;
    const total = useMemo(() => items.length + n, [items, n]);
    return <div>{total}</div>;
  }
`;

/**
 * LA CONTRAPRUEBA CORRE ACÁ, EN LA FASE DE IMPORT, Y NO ADENTRO DEL `it`.
 *
 * Sigue yendo PRIMERO —que es lo que la separa de un guard vacío— y ahora además va antes
 * que los dos casos, no sólo antes del segundo.
 *
 * El motivo del traslado es de medición. `new ESLint()` es perezoso: cuesta 1 ms. Lo que
 * cuesta es el PRIMER `lintText`, que resuelve la config y carga el parser de
 * eslint-config-next — medido el 26-ago-2026: **2606 ms el primero y 12 ms el segundo**.
 * Ese costo se paga una vez por worker y caía adentro del primer `it`, que corría con el
 * `testTimeout` por DEFECTO de vitest: **5 s**. O sea 2.6 s de un presupuesto de 5 gastados
 * en cargar un módulo, sobre una suite de 39 archivos en paralelo.
 *
 * No es teórico: en la corrida del 26-ago ese caso salió **rojo a los 50876 ms** con la
 * suite completa, y en aislado pasó en 2895 ms. Su hermano de abajo ya declaraba 120 s
 * porque su autor sabía lo que tardaba; éste no, y ésa era toda la diferencia.
 *
 * Y NO se arregla subiéndole el número: la fase de import no tiene `testTimeout`, así que
 * mover el costo acá lo saca del presupuesto en vez de agrandarlo. El cuerpo del test queda
 * midiendo lo que afirma. La misma instancia se reusa abajo, así que el barrido completo
 * tampoco vuelve a pagar la carga.
 *
 * Ojo: si esto explota, vitest lo reporta como error del ARCHIVO y no como test rojo. Sigue
 * siendo rojo, que es lo que importa — un guard que no puede fallar es el problema, no éste.
 */
const eslint = new ESLint({ cwd: RAIZ });
const VIOLACIONES_DEL_FIXTURE = violaciones(
  await eslint.lintText(FIXTURE_ROTO, { filePath: path.join(RAIZ, 'src', '__fixture-roto.tsx') }),
);

describe('hooks en orden (react-hooks/rules-of-hooks)', () => {
  it('detecta un hook después de un return temprano', () => {
    // Que el árbol esté limpio hoy no dice nada sobre si el linter estaría mirando. Si un
    // cambio de config apaga la regla, este caso muere y el de abajo pasaría en verde sin
    // ver nada. El lint ya corrió arriba; acá sólo se afirma sobre su resultado.
    expect(VIOLACIONES_DEL_FIXTURE.length).toBeGreaterThan(0);
  });

  // El barrido completo tarda ~15s: es ESLint recorriendo todo `src/`, no un cuelgue.
  it('no hay ninguna en src/', { timeout: 120_000 }, async () => {
    const resultados = await eslint.lintFiles(['src']);

    // Antivacuidad: si el barrido deja de encontrar archivos (un glob que cambia, un
    // `ignores` nuevo que se come `src/`), "cero violaciones" significa "no miré nada".
    expect(resultados.length).toBeGreaterThan(200);

    const encontradas = violaciones(resultados);
    expect(encontradas, `Hooks llamados condicionalmente:\n${encontradas.join('\n')}`).toEqual([]);
  });
});
