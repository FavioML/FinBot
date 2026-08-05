# Neto QA E2E — autonomous authenticated harness

Drives a real Chromium session against **app.neto.pe** as the QA test user, with
**no email / magic link** involved. It logs in via the Supabase password grant,
forges the `@supabase/ssr` session cookie, and runs the authenticated dashboard
checks end to end.

## Why this exists

Magic-link verification is unreliable for automation: Gmail's link scanner
consumes the single-use `verify?token` link before it can be used (every fresh
link arrives `otp_expired`), and Supabase rate-limits OTP email (~3-4/hour on the
built-in SMTP). This harness sidesteps all of that.

## La barrera de datos (leer antes de escribir un harness nuevo)

Estos harness corren contra la Supabase de **producción** con la service key, que
ignora RLS. El 01-ago-2026 un usuario que paga apareció sin sus transacciones ni
sus deudas, y reconstruir qué había pasado costó un día entero de trabajo.

Por eso todo harness que toque la DB pasa por `lib/qa-guard.mjs`:

```js
// cliente compartido del backend (el que usan también los services que importes)
import { instalarGuard } from './lib/qa-guard.mjs';
const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

// o, si el harness arma su propio cliente
import { clienteGuardado } from './lib/qa-guard.mjs';
const db = clienteGuardado(SUPA, SERVICE);
```

Las lecturas pasan libres. Un UPDATE o un DELETE tiene que estar fijado a un
usuario de la allowlist (los `NETO_QA_*_USUARIO_ID` de `qa.env`) o a una fila que
esta corrida creó o leyó bajo un filtro de usuario QA. Cualquier otra cosa aborta
con el detalle de lo que intentó tocar.

Casos que vas a necesitar:

- **Throwaway**: si lo creás con `insert` en `usuarios` con `is_test_user: true`,
  la barrera lo adopta sola y su limpieza funciona sin más.
- **Filas creadas por fuera del cliente** (por la API HTTP, típico en los harness
  de Espacios): registralas con `permitirFila(id)`.
- **Un usuario que ya existía**: `await permitirUsuarioDePrueba(id)`, que
  verifica `is_test_user` contra la DB antes de aceptarlo.

**No hay interruptor para apagarla**, y `tests/qa-guard.test.js` rompe el build si
un harness nuevo crea su propio cliente sin pasar por acá.

Lo que la barrera **no** cubre: Storage, el Admin API de Auth, y sobre todo el SQL
ad-hoc (editor del dashboard, MCP de Supabase), que no pasa por Node. Para eso
está el trigger de la migración 055, que deja en `borrados_auditoria` cada DELETE
sobre `transacciones`, `deudas` y `deuda_abonos` con la fila completa y de dónde
vino (`app_name=mgmt-api` es SQL a mano; `app_name=postgrest` con `req_path` es la
API). Si algo vuelve a desaparecer, empezá por ahí:

```sql
select borrado_at, tabla, usuario_id, contexto, fila
  from borrados_auditoria
 where usuario_id = '...'
 order by borrado_at desc;
```

## Setup (one time)

```bash
cd app/qa-e2e
npm install
npx playwright install chromium
```

Credentials are read from `~/.config/neto/qa.env` (see the
`reference_neto_qa_test_user` memory). Nothing secret is printed.

## Run

```bash
npm run dashboard      # or: node qa-login.mjs
```

Prints a JSON report and exits 0 when all critical checks pass, 1 otherwise.

## What it verifies

- Authenticated dashboard renders user data with **no `/onboarding` bounce**
  (regression guard for the `isRestoring`/`isPending` fix).
- **W4 persistence**: `localStorage['neto-rq']` is written and its `buster`
  equals the current auth user id (per-user cache isolation).
- **Logout privacy**: signing out fully removes `neto-rq` from localStorage
  (non-vacuous — it must have been present first) and clears the session cookie.
- Warm navigation timing (TTFB / domInteractive / load) for the static shell.
- Console error count.

## Focused harnesses

Same login pattern (password grant + forged cookie + Playwright), scoped to one page:

- `node qa-config-verify.mjs` — página **Configuración**: valida que "Ver planes
  y precios" enlace a `/dashboard/pro` (no a `/dashboard/planes`, que es metas),
  que el scroll-spy del índice resalte la sección clicada, y que
  `/api/categories` no devuelva raíces duplicadas. Deja `config-verify-shot.png`.

## Known limitation

The forged-cookie session hydrates the client's data queries only partially
(the `@supabase/ssr` client's token-refresh timing differs from a real login),
so the number of persisted queries varies (1–11) and the score KPI may not render
in every run. Full-data rendering (e.g. the score value) is verified separately
against a real magic-link session. The auth / persistence / logout-purge checks
above are reliable.

## Harnesses que NO corren en el canary (se corren a mano)

Los `.mjs` de esta carpeta no son todos iguales (no se escribe cuántos: ese número
envejece en cada sesión, que es justo lo que la ola 4 sacó de los CLAUDE.md). Los que corren solos están
declarados en `canary.harnesses` del `deploy-config.json` del webapp, y esa lista
es la fuente de verdad. El resto vive acá sin cablear a nada — no porque sobren,
sino porque su costo o su alcance no justifica correrlos todos los días.

El problema que esta tabla resuelve (Q6, auditoría CTO ola 4) es que estaban
**indocumentados**: un harness que nadie sabe que existe ni qué afirma es un
archivo muerto que igual hay que mantener, y la siguiente auditoría vuelve a
descubrirlo desde cero. Si agregás uno que no va al canary, agregá su fila.

| Harness | Qué afirma | Cuándo correrlo |
|---|---|---|
| `qa-parity-allroutes.mjs` | Barrido Free-vs-Pro sobre las 13 rutas del dashboard: errores de consola, 4xx/5xx, si aparece el `ProGate` y a dónde redirige cada una | Después de tocar gating, rutas nuevas, o el layout del dashboard |
| `qa-pro-features.mjs` | Importar un CSV por `/api/transactions/import` deja al heatmap "Actividad de gastos" renderizando para el Pro. Limpia sus filas (`E2E-IMPORT-TEST`) | Al tocar import o el heatmap |
| `qa-deshacer-restaura.mjs` | El contrato de `deshacer_ultimo` → `restaurar_eliminado`: el snapshot en `transacciones_eliminadas` se escribe ANTES del borrado, que es lo único que hace verdadera la promesa "escribe *restaura* y lo devuelvo" | Al tocar borrado o restauración de transacciones |
| `qa-join-check.mjs` | Los links de invitación colaborativa (`/join/meta/[code]`, `/join/deuda/[code]`) renderizan para un invitado SIN sesión (contexto sin cookies) | Al tocar metas/deudas compartidas o las páginas públicas de join |
| `qa-toggles.mjs` | Round-trip de `/api/notifications` por plan: `recordatorios_activos` y `alertas_transaccion` persisten lo que se les manda, y si el gating de Pro existe también del lado del servidor y no solo en la UI | Al tocar preferencias de notificación |
| `probe-reporte-gmail.mjs` | Con el webhook y el NLP REALES: el copy del modo de reporte respeta la regla de UNA cuenta de Gmail por usuario, aun con historial adverso sembrado que empuja a "agregar otra cuenta" | Al tocar el copy de Gmail o el ruteo de ese intent |
| `qa-unlink-overlap.mjs` | El botón "Cambiar" de Cuentas conectadas no queda tapado por los FAB flotantes en 390px. Mide intersección de rects, y antes scrollea a propósito para llevar el botón a la banda del FAB: en la posición natural no se tocan, así que probarlo ahí no prueba nada. Read-only (el único POST es el grant de auth) | Al tocar los FAB, el shell del dashboard o la sección Cuentas conectadas |

**`shot-*.mjs` / `*-shot.mjs` son one-offs, y no se commitean.** Capturan una
pantalla para un sprint concreto (un rediseño, un banner nuevo, una tarjeta
bloqueada) y su valor se agota cuando ese trabajo cierra. No afirman nada: no
tienen aserciones ni exit code útil. Dejarlos en el repo los convierte en
mantenimiento perpetuo de código que nadie va a volver a correr. Si necesitás
capturar algo, copiá el forjado de cookie de `qa-login.mjs` y borrá el archivo al
terminar. Por eso se eliminó `shot-gmail-bloqueado.mjs` en la ola 4.
