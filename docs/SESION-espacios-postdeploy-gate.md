# Sesión: gate post-deploy de Espacios (¿vale el mecanismo?)

Prompt de arranque autocontenido. Trabajar desde `C:\Vortik.dev\products\neto\app`.

---

## Por qué existe esta sesión

Al cablear el canary diario de Neto (ver `docs/SESION-canary-e2e.md` y
`docs/SESION-canary-checks-extra.md`) se dejó explícitamente fuera un pedazo: los
harness de **Espacios** (`qa-e2e/qa-espacios-*.mjs`). No van al canary diario
porque **escriben filas reales en la Supabase de prod** (crean espacios, registran
gastos, liquidan, hacen join real) y tardan minutos. Correrlos 365 veces al año
contra las mismas dos cuentas QA deja basura si fallan a mitad.

La idea pendiente: encajarlos como **gate post-deploy** que corra **solo cuando el
push toque `spaces-*` / `services/spaces-*`** — un hook de git o un step de CI, NO
una entrada en `canary.harnesses`.

**Esta sesión NO es "implementar el gate". Es decidir si el mecanismo vale**, y si
vale, cuál es el más barato que da la garantía real. La mitad del trabajo es
cuestionar si hace falta.

## Estado actual (verificado, no asumido)

**5 harness de espacios, TODOS escriben en prod** (ninguno es read-only puro):

- `qa-espacios-config.mjs` — gating Free/Pro + config plan display + join. Crea
  espacios, limpia lo que crea.
- `qa-espacios-gating-verify.mjs` — modelo "host paga": Free 2º espacio 403,
  split-rules/budgets 403, default-split 200; Pro+Free member con regla 70/30 que
  mueve el balance real. Crea espacios, limpia.
- `qa-espacios-join-split.mjs` — unirse NO reescribe el reparto de nadie; paridad
  webapp↔WhatsApp. Crea espacios + gastos + join.
- `qa-espacios-reglas-aviso.mjs` — avisos de reparto por WhatsApp: **webhook real
  (firma HMAC) + NLP real + Supabase real**. El más pesado.
- `qa-espacios-split-parity.mjs` — 3 miembros desiguales + regla Pro por categoría:
  webapp y backend devuelven los mismos balances; división congelada. Stubea
  `enviarWhatsapp`, pero crea espacio + gastos en prod.

**Lo que YA está cubierto sin tocar prod — tests de paridad en CI** (GitHub
Actions, corren en cada push/PR, Node 20, no tocan prod):
`tests/services/spaces-split-parity.test.js`, `spaces-join-split.test.js`,
`spaces-split.test.js`, `spaces-avisos.test.js`, `shared-spaces-balance.test.js`,
`spaces-lecturas-fallidas.test.js`. Cazan la **lógica**: divergencia de motores
TS↔CJS, conservación de dinero, congelamiento de la división, avisos.

## La pregunta central de la sesión

Los tests de CI ya cazan los bugs de **lógica** sin tocar prod. Entonces, ¿qué
caza un gate post-deploy contra prod que CI no ve? Solo lo de **entorno**:

1. Que la **migración corrió** en la Supabase de prod (columnas nuevas, los CHECK
   constraints de conservación de monto, las policies eliminadas de la migración
   033).
2. Que el **service-role liquida en prod de verdad** (RLS deny-all en `space_*` +
   bypass por service-role, funcionando con las env vars reales de Vercel).
3. Que el **endpoint real** responde con la cookie SSR real (no un mock).

Ese es un conjunto chico y de naturaleza **infra**, no lógica. La decisión es si
ese riesgo justifica un mecanismo que **escribe en prod automáticamente**.

## Recomendación de arranque (sustentarla o rebatirla)

**Escéptico del mecanismo pesado.** Un hook post-deploy que corre los 5 harness
que escriben en prod tiene mal ratio costo/beneficio: complejidad de cleanup
robusto, riesgo de basura si falla a mitad, minutos de wall-clock, y todo para
cazar un fallo (migración no aplicada) que además saltaría en el primer uso real.
Propuesta a evaluar, en dos piezas separadas:

- **(a) Un check post-deploy LIGERO y read-only** que verifique solo los
  invariantes de entorno, sin crear nada: ¿existe la columna `split_snapshot`?
  ¿están los CHECK constraints? ¿un `GET /api/spaces` con cookie forjada responde
  200 con la forma esperada? Eso puede ir al molde de `qa-gating-*` (barato,
  determinista, sin escritura) e incluso al canary diario. Caza "la migración no
  corrió" sin ensuciar prod. **Verificar por API/DB de Supabase (MCP), no por
  render.**
- **(b) Los 5 harness que escriben quedan como "correr a mano cuando toques
  `spaces-*`"**, disparado por un hook que lo **RECUERDE** (igual que el
  PostToolUse de `git push` ya recuerda los curls), NO que los ejecute solo. El
  humano decide correrlos post-deploy cuando cambió algo de espacios.

Rebatir esto si el valor de la ejecución automática pesa más de lo que estimo (p.
ej. si los deploys de espacios son frecuentes y el humano se olvida de correrlos).
Pero el default debería ser: **mejor un check de entorno read-only barato que un
harness de escritura automático.**

## Qué NO hacer

- **No meter los harness de escritura a `canary.harnesses`.** Ese es exactamente
  el error que esta sesión existe para evitar.
- **No asumir que hace falta un mecanismo.** Si la conclusión honesta es "los
  tests de CI + correrlos a mano bastan", esa es una resolución válida y se cierra
  la sesión documentándolo.

## Gotchas ya pagados (no volver a descubrir)

- **`railway.json` excluye `qa-e2e/**` y `webapp/**`.** Tocar los harness o el
  deploy-config NO redespliega el backend de WhatsApp (Railway hace SKIPPED). Ver
  `CLAUDE.md` (sección railway.json).
- **La API exige la cookie SSR de `@supabase/ssr`, no acepta `Bearer`** (→ 401).
  Forjarla como en `qa-e2e/qa-gating-score.mjs` / `qa-gating-export.mjs`.
- **`process.exitCode`, no `process.exit()`** (assertion de libuv en Windows con
  el socket keep-alive de fetch abierto → 127 en vez del código real).
- **Verificar contra `https://app.neto.pe`, nunca `next dev`.**
- **Espacios es service-role-only POR DISEÑO.** `space_*` no tiene policies RLS
  para `authenticated` (deny-all); la autorización vive en `lib/spaces-server.ts`
  (`requireSpaceMember` / `requireSpaceOwner`). Un check read-only que quiera leer
  `space_*` con la cookie de sesión verá deny-all: leer vía el endpoint
  `/api/spaces/*` (service-role) o vía el MCP de Supabase, no con RLS de sesión.
- **`services/spaces-split.js` es el espejo CJS** que usa el backend; su paridad
  con `webapp/.../lib/spaces-split.ts` la cubre el test de CI. No es material de
  gate post-deploy (CI ya lo corre sin tocar prod).

## Credenciales y datos

Creds en `~/.config/neto/qa.env`. Ambos QA users con `is_test_user=true`:
- **QA Pro:** `ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172`, vars `NETO_QA_*`.
- **QA Free:** `a9664eeb-ee0b-4640-b848-fdd0daa5aff0`, vars `NETO_QA_FREE_*`.

Nunca correr nada con data que no sea de esos dos. Si se construye un check de
escritura, verificar que su cleanup no deje espacios/gastos huérfanos en esas dos
cuentas.

## Cómo verificar esta sesión

Depende de la decisión:
- **Si sale un check read-only (a):** los dos escenarios de siempre — sano →
  exit 0 sin ruido; fallo forzado (p. ej. apuntar a una columna/constraint
  inexistente, o simular la migración sin correr) → exit 1 con detalle. Y que el
  canary siga con "silencio = sano".
- **Si sale solo el hook que recuerda (b):** provocar un `git push` que toque
  `spaces-*` y confirmar que el recordatorio aparece; uno que NO los toque y
  confirmar que NO aparece.
- **Si la conclusión es "no hace falta mecanismo":** documentar el porqué en la
  Resolución y en la memory `project_neto_qa_roadmap` (el gate de espacios quedaba
  como pendiente ahí).

## Contexto de lo ya hecho (no repetir)

El canary corre 6 harness con veredicto (`deploy-fresh`, `gating-score` — que ya
cubre `/api/score` + el seed `/api/dashboard` —, `gating-export`, `login-e2e`,
`tono-neto`). El molde de check read-only por API está probado en
`qa-gating-score.mjs` / `qa-gating-export.mjs`. La memory
`project_neto_qa_roadmap` lleva el estado vivo del roadmap QA.
