---
paths:
  - "handlers/**/*.js"
  - "services/**/*.js"
  - "routes/**/*.js"
  - "lib/**/*.js"
  - "helpers/**/*.js"
  - "index.js"
  - "gmail.js"
---

# Reglas Backend Neto (Node 20+, Express 5)

- CommonJS (`require`, `module.exports`). NO ES modules salvo archivo nuevo donde se justifique.
- Supabase: usar service role solo en server. RLS NO aplica al service role — verificar permisos en el query.
- OpenAI/Claude: nunca instanciar dentro de handlers, usar singleton en `lib/`.
- Errores: log con `pino` (no console.log). Nivel `error` para excepciones, `warn` para flujo recuperable.
- Tests: vitest. Mockear Supabase y APIs externas, NUNCA correr tests contra DB real.
- Secrets: solo via `process.env`. Nunca hardcodear ni loggear tokens.
- Rate limit: respetar `express-rate-limit` configurado. NO bypassear en handlers nuevos.
