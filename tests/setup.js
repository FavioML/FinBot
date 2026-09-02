import { vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Create a controllable mock and expose it globally.
// Individual tests can call globalThis.__mockOpenAICreate.mockResolvedValue(...)
// to customize responses per test.
globalThis.__mockOpenAICreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: '{}' } }]
});

// Load the real lib/ai module via CJS require. This creates the actual
// OpenAI client instance (constructor doesn't validate the API key).
// Then patch .create() on the shared instance. Since CJS modules share
// the same exports object, every file that did
//   const { openai } = require('../lib/ai')
// holds a reference to the SAME openai instance — so the patch
// propagates to parsers.js, neto-gpt.js, etc. without needing vi.mock.
const ai = require('../lib/ai');
ai.openai.chat.completions.create = globalThis.__mockOpenAICreate;

/**
 * **Ningún test sale a la red.** `.claude/rules/backend.md` lo dice desde siempre —"Mockear
 * Supabase y APIs externas, NUNCA correr tests contra DB real"— y hasta el 2026-09-02 no había
 * nada que lo hiciera cumplir. El día que se cambió `obtenerCuentasGmail` para que dejara de
 * tragarse el `{ error }`, aparecieron DOS suites pegándole a Supabase de PRODUCCIÓN con la
 * service key: pasaban en verde porque el error se descartaba y el `[]` resultante era
 * indistinguible de una respuesta real.
 *
 * O sea: la regla llevaba meses violada y en silencio, y lo que la destapó fue un cambio en
 * otra parte. Un control que corre es lo único que separa "la regla se cumple" de "nadie miró".
 *
 * Falla RUIDOSO y nombra la URL: un test que necesita la red está mal escrito, no es un test
 * lento. Si algo tiene que salir de verdad, es un harness de `qa-e2e/`, no un test.
 */
const fetchReal = globalThis.fetch;

/**
 * Loopback SÍ: varios tests levantan un Express de verdad en un puerto efímero y le pegan
 * (`tests/routes/*`), que es la forma correcta de probar una ruta entera. Lo que no se permite
 * es salir de la máquina.
 */
const ES_LOCAL = /^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

globalThis.fetch = function fetchBloqueado(recurso, opciones) {
  const url = typeof recurso === 'string' ? recurso : (recurso && recurso.url) || String(recurso);
  if (/^https?:\/\//i.test(url) && !ES_LOCAL.test(url)) {
    throw new Error(
      'Un test intentó salir a la RED: ' + url + '\n' +
      'Los tests no hablan con Supabase ni con ninguna API externa (.claude/rules/backend.md). ' +
      'Mockeá el módulo que hace la llamada — para `gmail.js` el patrón está en ' +
      '`tests/gmail-tiene-conectado.test.js`; para el resto, interceptá con `require.cache`.',
    );
  }
  return fetchReal.apply(this, arguments);
};
