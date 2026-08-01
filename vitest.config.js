import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 10000,
    setupFiles: ['./tests/setup.js'],
    // La webapp tiene su propia suite (`cd webapp && npm run test`), con su alias `@/` y
    // sus rutas relativas a `webapp/`. Corridos desde acá fallaban SIEMPRE — el barrido de
    // call-sites busca `src/app/api` bajo la raíz del backend y no existe. Eran 2 suites
    // rojas permanentes que entrenaban a ignorar el rojo de `npm test`.
    // Los tests de paridad (tests/services/spaces-split-parity.test.js) IMPORTAN de
    // webapp/ pero viven en tests/, así que esta exclusión no los toca.
    exclude: ['**/node_modules/**', '**/dist/**', 'webapp/**'],
  },
});
