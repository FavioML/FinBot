# Sesión: más checks con veredicto para el canary de Neto

Prompt de arranque autocontenido. Trabajar desde `C:\Vortik.dev\products\neto\app`.

---

## Resolución (2026-07-22) — CERRADA

Se leyeron los endpoints reales, no la intención de los sweeps. Eso cambió la
recomendación de arranque del brief.

**Rebatido — gating de alertas NO se agrega.** `/api/alerts/route.ts` no hace
stripping por plan: devuelve `{ alerts: [...todas], isPro }`. El gate de
"Proyección de exceso" / "Poner límite" es client-side (blur+lock en el DOM), no
existe a nivel API. Lo único afirmable por API (`isPro` correcto + 200 + forma)
usa el mismo `requireNetoUser` que `gating-score` ya ejercita y el render ya lo
cubre `login-e2e` → un check que casi nunca falla. No vale un slot.

**Confirmado — suscripciones NO se agrega.** La detección es 100% client-side;
`/api/recurring/override` solo escribe (POST/DELETE). Sin data sembrada no hay
invariante read-only. Fuera del canary.

**Reportes → el gate real es otro.** El PDF se genera en el cliente
(`html2canvas-pro` + `jsPDF`, sin endpoint server). Investigándolo apareció el
gate que sí vale: `/api/export` (feature Pro "Exportar datos", Configuración),
que devuelve TODA la data del usuario. Gate API limpio: Pro → 200 + payload;
Free → 403 + `{upgrade:true}`.

**Agregado 1 — `gating-export` (`qa-e2e/qa-gating-export.mjs`, nuevo slot).**
Gemelo de `gating-score` sobre `/api/export`. Protege la fuga más cara (dump
completo de datos a un Free). Exit 0/1/2, `process.exitCode`, read-only.

**Agregado 2 — hardening de `gating-score` (sin slot nuevo).** El dashboard no
siembra desde `/api/score` sino desde `/api/dashboard` (`route.ts:150-172`), que
replica el mismo gate de `factors`/`history`. `gating-score` verificaba solo
`/api/score`: un leak podía vivir en el seed con `/api/score` limpio. Se le
sumaron 2 fetch a `/api/dashboard` con las mismas aserciones (Free sin
`score.factors`, history del seed sin campos `factor_*`).

**deploy-config:** `gating-export` agregado a `canary.harnesses`; costo de
`gating-score` actualizado a "2 logins + 4 fetch".

**Verificado (los dos escenarios del brief):**
- Sano → `gating-export` y `gating-score` exit 0 (todos PASS contra prod).
- Fallo forzado (slot Free apuntando a la cuenta Pro vía `process.env`) →
  `gating-export` exit 1 (Free recibe 200 = leak) y `gating-score` exit 1 con
  las aserciones NUEVAS del seed disparando de forma independiente
  (`dashHasFactors` y `dashHistoryLeak` en FAIL). Los checks sirven.

Nota: `qa-e2e/**` y `webapp/.claude/**` los excluye `railway.json` → el backend
WhatsApp no se redesplegó.

---

## Por qué existe esta sesión

El 22-jul-2026 se cableó el canary diario de Neto con 4 harness (ver
`docs/archive/SESION-canary-e2e.md`, Resolución). Al hacerlo se encontró que los sweeps
E2E existentes (`qa-analysis-sweep`, etc.) son **dumps de inspección manual sin
veredicto binario** (solo salen != 0 si cae el login), así que no sirven como
check de canary tal cual. Se construyó uno a medida, `qa-gating-score.mjs`, que
verifica el gating Free/Pro del score por API. Esta sesión extiende ese molde a
más dominios.

**No es "convertir los sweeps al canary".** Es decidir, dominio por dominio, qué
regresión concreta merece un check diario y si es verificable de forma barata y
determinista. La mitad del trabajo es decidir cuáles valen y cuáles no.

## Estado actual (verificado, no asumido)

El canary (`canary-daily-deploys`, cron 10am Lima) itera la sección
`canary.harnesses` de `webapp/.claude/deploy-config.json` — esa lista es la fuente
de verdad, el SKILL.md no hardcodea. Hoy corre 4:

- `deploy-fresh` — ¿app.neto.pe sirve los últimos commits de `webapp/`? (vía `gh
  compare`, usa el endpoint `/api/version`).
- `gating-score` — ¿Free NO ve los `factors` del score? (por API, cookie SSR
  forjada, sin Chromium).
- `login-e2e` — auth + dashboard + logout reales (Chromium).
- `tono-neto` — linter de tono de la IA de WhatsApp.

Regla **"silencio = sano"**: si todo pasa, una línea y NO se crea archivo. Solo
se escribe reporte (`C:/Vortik.dev/memory/canary/canary-YYYY-MM-DD.md`) si hay
fallo. Cualquier check que se agregue no puede romper eso con ruido falso.

## El molde a seguir: `qa-gating-score.mjs`

Es el patrón de referencia. Un check de canary bien hecho:

1. **Verifica por API, no por render** cuando se puede: forja la cookie SSR (la
   API no acepta Bearer) y hace `fetch` plano con header `Cookie`. Sin Chromium =
   segundos y determinista. Solo usar Playwright si la regresión solo se ve en el
   DOM.
2. **Tiene veredicto binario**: exit 0 = OK, exit 1 = regresión (con un JSON que
   nombra qué falló), exit 2 = infra (login/red caídos) — que NO es una regresión
   y el canary debe reportar distinto.
3. **No depende de data sembrada.** Los QA users no tienen subs/alerts/gastos
   sembrados por defecto (verificado). Un check que asuma "hay N suscripciones"
   dará falsos. Verificar invariantes que se cumplan con data vacía: gating,
   status codes, forma de la respuesta, ausencia de console errors / 4xx-5xx.
4. **Es read-only.** No escribe en la Supabase de prod. Si el check necesita
   escribir para probar algo, no es material de canary diario (va a demanda).
5. `process.exitCode`, no `process.exit()` (gotcha de Windows/libuv, ver abajo).

## Los candidatos, y qué decidir de cada uno

Para CADA uno la pregunta es: *¿qué regresión concreta caza que `login-e2e` no
ve, es verificable por API sin data sembrada, y con veredicto binario?* Si la
respuesta es floja, NO agregarlo — un check que nunca falla es peor que nada.

### 1. Gating de alertas (probable sí)
`qa-analysis-sweep` ya observa que Free no debe ver ciertas alertas Pro
("Proyección de exceso", "Poner límite"). Confirmar si `/api/alerts` expone eso
por API (el sweep tiene `isPro`, `projectionGate`, `proBanner` en su intercept).
Si sí, es un `gating-alerts` gemelo de `gating-score`. Casi seguro vale.

### 2. Reportes (a investigar)
El reporte HTML/PDF se genera server-side. Verificar si hay un endpoint que
devuelva el reporte (o su metadata) con status 200 y forma esperada para un user
con y sin data. El riesgo real es "la generación del reporte se rompió". Decidir
si es verificable barato o si requiere render (y entonces si vale el costo).

### 3. Suscripciones (a investigar, con cuidado)
La detección automática corre sobre las transacciones del user. Con QA users sin
subs sembradas, `/api/recurring` (o el que sea) probablemente devuelve vacío —
que es un estado válido, no una regresión. Pensar qué invariante SÍ se puede
afirmar sin sembrar (¿el endpoint responde 200 con la forma correcta? ¿el catálogo
de servicios carga?). Si lo único verificable requiere data sembrada, este NO es
buen candidato a canary — dejarlo como sweep manual.

**Recomendación de arranque (sustentarla o rebatirla):** hacer `gating-alerts`
(alto valor, molde ya probado), investigar reportes, y ser escéptico con
suscripciones. Mejor 1-2 checks sólidos que 3 flojos.

## Pieza separada: gate post-deploy de espacios (NO es un check de canary diario)

Los harness de espacios (`qa-espacios-*`) **escriben filas reales en la Supabase
de prod** (crean espacios, registran gastos, liquidan) y tardan minutos. NO van
al canary diario: correrlos 365 veces al año contra la misma cuenta deja basura si
fallan a mitad. Encajan como **gate post-deploy** que corra solo cuando el push
toque `spaces-*` o `services/spaces-*`. Eso es un hook de git (o un step de CI),
no una entrada en `canary.harnesses`. Es trabajo de naturaleza distinta a lo de
arriba; puede ser su propia sesión. Evaluar si el valor (cazar que la migración
corrió y que el service-role liquida en prod) justifica el mecanismo, dado que los
splits ya tienen tests de paridad TS↔CJS en CI que corren sin tocar prod.

## Gotchas ya pagados (no volver a descubrir)

- **La API exige la cookie SSR de `@supabase/ssr`. No acepta `Bearer`** (→ 401).
  Forjarla como en `qa-gating-score.mjs` / `qa-login.mjs` y mandarla en `Cookie`.
- **`process.exitCode`, no `process.exit()`.** En Windows, salir de golpe mientras
  el socket keep-alive de `fetch` aún se cierra dispara una assertion de libuv
  (UV_HANDLE_CLOSING) y devuelve 127 en vez del código real.
- **Verificar contra `https://app.neto.pe`, nunca `next dev`** (se queda en skeleton).
- **Overlays:** `neto_welcome_seen` y `neto_tour_v2` montan un `.fixed.inset-0.z-50`
  que se re-monta si se borra. Solo relevante si usas Playwright; sembrar con
  `addInitScript` antes de cargar.
- **Los QA users no tienen subs/alerts/gastos sembrados.** Un check no puede
  asumir data. Si un dominio solo es verificable con data sembrada, no es canary.
- **`process.env` gana sobre `qa.env`** en `qa-gating-score.mjs`: permite overrides
  operacionales y forzar el camino de fallo en la verificación.

## Credenciales y datos

Creds en `~/.config/neto/qa.env`. Ambos QA users con `is_test_user=true`:
- **QA Pro:** `ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172`, vars `NETO_QA_*`.
- **QA Free:** `a9664eeb-ee0b-4640-b848-fdd0daa5aff0`, vars `NETO_QA_FREE_*`.

Nunca correr nada con data que no sea de esos dos.

## Cómo verificar esta sesión

Igual que la anterior, los dos escenarios:

1. **Todo sano** → correr los harness (los 4 actuales + los nuevos); todos exit 0
   → el canary sigue emitiendo una línea y NO crea archivo.
2. **Fallo forzado** → por cada check nuevo, provocar la regresión que dice cazar
   (p. ej. apuntar el slot Free a la cuenta Pro para un gating, como en
   `qa-gating-score.mjs`) y confirmar exit 1 con detalle accionable. Ese es el
   test que demuestra que el check sirve; sin él, es decoración.

## Contexto de lo ya hecho (no repetir)

Endpoint `/api/version` (expone `VERCEL_GIT_COMMIT_SHA`), `probe-deploy-fresh.mjs`
(robusto al build-config de Vercel vía `gh compare` sobre `webapp/`),
`qa-gating-score.mjs`, hardening anti-flake de `qa-login.mjs`, y la sección
`canary.harnesses` en el deploy-config. Tocar `qa-e2e/` y `webapp/.claude/` es
barato: Railway hace SKIPPED (`railway.json` los excluye), el backend WhatsApp no
reinicia.
