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

describe('hooks en orden (react-hooks/rules-of-hooks)', () => {
  it('detecta un hook después de un return temprano', async () => {
    // La contraprueba va PRIMERO y es lo que separa este guard de uno vacío: que el árbol
    // esté limpio hoy no dice nada sobre si el linter estaría mirando. Si un cambio de
    // config apaga la regla, este caso muere y el de abajo pasaría en verde sin ver nada.
    const eslint = new ESLint({ cwd: RAIZ });
    const codigo = `
      'use client';
      import { useMemo, useState } from 'react';
      export function Roto({ items }: { items: number[] }) {
        const [n] = useState(0);
        if (items.length === 0) return null;
        const total = useMemo(() => items.length + n, [items, n]);
        return <div>{total}</div>;
      }
    `;
    const encontradas = violaciones(
      await eslint.lintText(codigo, { filePath: path.join(RAIZ, 'src', '__fixture-roto.tsx') }),
    );
    expect(encontradas.length).toBeGreaterThan(0);
  });

  // El barrido completo tarda ~15s: es ESLint recorriendo todo `src/`, no un cuelgue.
  it('no hay ninguna en src/', { timeout: 120_000 }, async () => {
    const eslint = new ESLint({ cwd: RAIZ });
    const resultados = await eslint.lintFiles(['src']);

    // Antivacuidad: si el barrido deja de encontrar archivos (un glob que cambia, un
    // `ignores` nuevo que se come `src/`), "cero violaciones" significa "no miré nada".
    expect(resultados.length).toBeGreaterThan(200);

    const encontradas = violaciones(resultados);
    expect(encontradas, `Hooks llamados condicionalmente:\n${encontradas.join('\n')}`).toEqual([]);
  });
});
