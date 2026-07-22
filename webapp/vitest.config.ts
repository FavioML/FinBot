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
  },
});
