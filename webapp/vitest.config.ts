import { defineConfig } from 'vitest/config';

/**
 * Tests de la webapp. Solo modulos de servidor (helpers de `src/lib/`), no
 * componentes: por eso no hace falta jsdom ni el plugin de React.
 *
 * `resolve.tsconfigPaths` es nativo de Vite: resuelve el alias `@/` leyendo
 * tsconfig.json, para que los tests importen igual que el codigo de produccion.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Los guards que barren `src/` entero tardan <1 s solos y 6-27 s en la suite completa con la
    // máquina cargada (13-oct-2026: `copy-claims` 0.8 s solo, 8.8 s en la suite). Con el default de
    // 5 s fallaban por reloj, nunca por aserción. Un timeout acá frena cuelgues, no mide velocidad.
    testTimeout: 30_000,
  },
});
