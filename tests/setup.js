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
