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

> **La tabla cubría 7 de los ~50 que había (barrido del 09-ago-2026).** El resto
> estaba exactamente en el estado que este párrafo describe. Para recontar en vez de
> creerle a un número escrito acá:
>
> ```bash
> node -e "const fs=require('fs'),c=require('./webapp/.claude/deploy-config.json'),r=fs.readFileSync('qa-e2e/README.md','utf8'),k=new Set(c.canary.harnesses.map(h=>h.cmd.replace(/^node qa-e2e\//,'')));const f=fs.readdirSync('qa-e2e').filter(x=>x.endsWith('.mjs'));console.log('total',f.length,'canary',k.size,'huerfanos',f.filter(x=>!k.has(x)&&!r.includes(x)).length)"
> ```
>
> Si eso devuelve huérfanos > 0, alguien agregó un `.mjs` sin decidir dónde vive.

### El criterio: qué gana un lugar en el canary DIARIO

No es "el harness es bueno". Los de abajo son buenos y se quedan afuera. La pregunta
es **¿esto se puede romper sin que nadie haga un commit?** Un harness que solo falla
cuando tocás su código ya está cubierto por correrlo post-deploy, y el hook de
`git push` lo recuerda. Lo que justifica el costo diario es la deriva que ningún
diff muestra: una env var rotada en una sola plataforma, un dato que cruza un borde
de mes, un cron que deja de disparar.

Y lo descalifica: quemar cuota de OpenAI o un cupo de Google, escribir sobre
usuarios reales, o correr un cron **bulk** cuyo radio de daño dependa de qué haya en
producción esa mañana. Ese último es el motivo de que `qa-trial-gate.mjs` siga acá
abajo pese a cubrir el muro, que es de lo que se cobra: corre `checkTrialExpiry`, que
barre a todos los usuarios con el trial por vencer, y su seguridad un día con gente
real en ventana descansa en que la barrera `qa-guard` aborte la escritura **dentro
del `try/catch` por usuario** del cron — donde un throw es una línea de log. Eso no
está medido, y no se puede medir un día con la ventana vacía. El pre-vuelo del propio
harness mide el radio pero solo lo **imprime** (`check(..., true, ...)`), no lo gatea.
Si alguien lo quiere diario, el cambio que lo habilita es convertir ese pre-vuelo en
exit 2 cuando `realesEnVentana > 0`; hasta entonces, a mano.

| Harness | Qué afirma | Cuándo correrlo |
|---|---|---|
| `qa-parity-allroutes.mjs` | Barrido Free-vs-Pro sobre las 13 rutas del dashboard: errores de consola, 4xx/5xx, si aparece el `ProGate` y a dónde redirige cada una | Después de tocar gating, rutas nuevas, o el layout del dashboard |
| `qa-pro-features.mjs` | Importar un CSV por `/api/transactions/import` deja al heatmap "Actividad de gastos" renderizando para el Pro. Limpia sus filas (`E2E-IMPORT-TEST`) | Al tocar import o el heatmap |
| `qa-deshacer-restaura.mjs` | El contrato de `deshacer_ultimo` → `restaurar_eliminado`: el snapshot en `transacciones_eliminadas` se escribe ANTES del borrado, que es lo único que hace verdadera la promesa "escribe *restaura* y lo devuelvo" | Al tocar borrado o restauración de transacciones |
| `qa-join-check.mjs` | Los links de invitación colaborativa (`/join/meta/[code]`, `/join/deuda/[code]`) renderizan para un invitado SIN sesión (contexto sin cookies) | Al tocar metas/deudas compartidas o las páginas públicas de join |
| `qa-toggles.mjs` | Round-trip de `/api/notifications` por plan: `recordatorios_activos` y `alertas_transaccion` persisten lo que se les manda, y si el gating de Pro existe también del lado del servidor y no solo en la UI | Al tocar preferencias de notificación |
| `probe-reporte-gmail.mjs` | Con el webhook y el NLP REALES: el copy del modo de reporte respeta la regla de UNA cuenta de Gmail por usuario, aun con historial adverso sembrado que empuja a "agregar otra cuenta" | Al tocar el copy de Gmail o el ruteo de ese intent |
| `qa-unlink-overlap.mjs` | El botón "Cambiar" de Cuentas conectadas no queda tapado por los FAB flotantes en 390px. Mide intersección de rects, y antes scrollea a propósito para llevar el botón a la banda del FAB: en la posición natural no se tocan, así que probarlo ahí no prueba nada. Read-only (el único POST es el grant de auth) | Al tocar los FAB, el shell del dashboard o la sección Cuentas conectadas |

#### Canal WhatsApp por el webhook real — queman cuota de OpenAI

Todos bootean el Express real en proceso y firman el webhook como Meta, así que cada
corrida pasa por el clasificador NLP de verdad. Es lo que los hace valiosos y lo que
los deja fuera del diario. `qa-muro-whatsapp.mjs` sí está en el canary porque es el
único que vigila de qué se cobra; el resto se corre post-deploy.

| Harness | Qué afirma | Cuándo correrlo |
|---|---|---|
| `qa-e2e-registro-gasto.mjs` | El loop núcleo: registrar un gasto por lenguaje natural, del webhook firmado a la fila en Postgres, sin mockear nada | Al tocar el pipeline de registro, el NLP o los parsers |
| `qa-e2e-registro-gasto-foto.mjs` | El mismo loop por el branch `image` con Vision REAL (captura de Yape/Plin) | Al tocar Vision, el branch de imagen o los parsers de captura |
| `qa-e2e-pago-pro.mjs` | El flujo Pro por el branch `image`: la captura de pago deja al usuario en "solicitud pendiente" | Al tocar `lib/pro-payment.js` o la detección de comprobante |
| `qa-e2e-aprobacion-pro.mjs` | La otra mitad: la APROBACIÓN Free → premium, que es donde se mueve la plata. Complementa al anterior, no lo repite | Al tocar aprobación de pagos, `activarPro` o el panel admin |
| `qa-e2e-onboarding.mjs` | El alta por WhatsApp punta a punta, con el reordenamiento que pone el valor antes que la identidad | Al tocar `handlers/onboarding.js` o el orden del alta |
| `qa-onboarding-paso2-pro.mjs` | Quien elige Pro durante el alta queda en `onboarding_paso=2`, y las cuatro vías que lo devuelven a 0 (no solo `/pago`) | Al tocar el alta con Pro o `esperaComprobante()` |
| `qa-instrumentacion-funnel.mjs` | La instrumentación del funnel (migración 050): que los turnos del alta se registren, que era el punto ciego del barrido de churn | Al tocar el logging del funnel o las métricas de alta |
| `qa-bsuid-username.mjs` | Reconocimiento por BSUID: un usuario con username de WhatsApp llega sin `from`, por los DOS caminos (mensaje entrante y callback de status) + control negativo | Al tocar `persistirBsuid`, el webhook o `lib/whatsapp.js` |
| `qa-handler-directo.mjs` | Despacha intents contra el intent-registry SALTEANDO el NLP, que es lo único que permite verificar la respuesta de un intent concreto sin que el clasificador elija por vos | Al tocar un handler de intent puntual |
| `qa-respuestas-finales.mjs` | El pipeline completo (NLP incluido) y el tiempo de cada intent: la respuesta exacta que recibiría el usuario | Al tocar redacción con IA o el registry |
| `probe-system-prompt.mjs` | Que el system prompt maestro llegue REALMENTE al modelo. Cierra el ENOENT silencioso que dejó a producción respondiendo con un fallback de una línea | Al mover o renombrar los archivos de prompt |
| `probe-ratelimit-ipv6.mjs` | Rate limiting real sobre el Express montado: las IPv6 de un mismo /56 comparten clave (el bypass `ERR_ERL_KEY_GEN_IPV6`) | Al tocar los limiters de `index.js` |
| `probe-bancos.mjs` | Que WhatsApp NO emita el enlace de OAuth ni el menú de bancos: la capability es web-only y el paso 30 murió | Al tocar `/conectar`, `/bancos` o los intents de Gmail |

#### Gmail — cada corrida puede costar un cupo de Google, irrecuperable

Los cupos son 100 para todo el ciclo de vida del proyecto y no se recuperan (ver
CLAUDE.md). Ninguno de estos va al canary aunque hoy no gasten: el que un harness
gaste o no depende de por qué rama caiga, y esa es exactamente la clase de apuesta
que no se hace todas las mañanas sin mirar.

| Harness | Qué afirma | Cuándo correrlo |
|---|---|---|
| `qa-gmail-pro-pagado.mjs` | Solo un Pro PAGADO consume un cupo: durante el trial `plan` vale `premium`, así que los gates viejos dejaban conectar a quien probaba | Al tocar los gates de Gmail o `esProPagado()` |
| `qa-gmail-segundo-correo.mjs` | La rama 409 de `routes/public.js`: autorizar con un correo distinto al ya vinculado se rechaza y suelta el grant sobrante. Sin gastar cupo | Al tocar `guardarTokens` o el callback OAuth |
| `qa-gmail-webonly.mjs` | El state lleva `uid` y el callback resuelve por identidad, así que un usuario sin `whatsapp` ya no cae en 404 tras el consent | Al tocar `/pro/gmail-auth-url` o el callback |
| `qa-gmail-estado-reconexion.mjs` | `auth_error_at` separa "conectada" de "sana": la tarjeta ya no dice "Gmail conectado ✓" con el token muerto. Siembra y limpia sin gastar cupo | Al tocar `gmail-estado.ts`, el banner o `configurarClienteParaCuenta` |

#### Trial y muro

| Harness | Qué afirma | Cuándo correrlo |
|---|---|---|
| `qa-trial-gate.mjs` | El muro BLOQUEA: las tres cosas que comparten `plan='premium'` (paga / prueba / ya no tiene nada) no se confunden entre sí. Corre `checkTrialExpiry`, un cron **bulk** — ver el criterio de arriba | Al tocar `lib/trial.js`, los gates o `cron/checks.js` |
| `qa-trial-integridad.mjs` | El complemento: el trial ENTREGA y nadie se lo quita por accidente. Los seis huecos de la auditoría del 01-ago | Al tocar el trial, referidos o el descuento |
| `qa-trial-flujo.mjs` | Las tres cadenas que `qa-trial-gate` no toca: los avisos de día 11 y 14, y el downgrade visto desde el flujo | Al tocar los avisos de fin de trial |

#### Espacios compartidos

| Harness | Qué afirma | Cuándo correrlo |
|---|---|---|
| `qa-espacios-split-parity.mjs` | Paridad webapp ↔ backend con 3 miembros en porcentajes DESIGUALES y una regla Pro por categoría. Con 50/50 los dos motores coincidían de casualidad | Al tocar `lib/spaces-split.ts` o su espejo CJS |
| `qa-espacios-join-split.mjs` | Qué le pasa al reparto de los que ya estaban cuando entra un tercero, por los dos caminos de join | Al tocar `joinSplitWeight` o `/api/spaces/join` |
| `qa-espacios-reglas-aviso.mjs` | Los avisos de reparto tras extraer `avisarAMiembros`, incluido el de reglas por categoría que antes movía plata futura en silencio | Al tocar los avisos de espacios |

#### Webapp y datos

| Harness | Qué afirma | Cuándo correrlo |
|---|---|---|
| `qa-money-edge.mjs` | Montos límite en las rutas de EDICIÓN, que los harness felices no tocan. Encontró 4 bugs, uno P0 (`Infinity` por sobrepago en abonos de deuda) | Al tocar cualquier ruta que acepte un monto |
| `qa-budgets-recurrence.mjs` | `POST /api/budgets/apply-forward`: la recurrencia espeja una categoría hacia TODOS los meses posteriores, altas y bajas | Al tocar presupuestos o la recurrencia |
| `qa-categorias-crud.mjs` | El CRUD completo de categorías desde el panel, incluidos los bordes del rework (crear raíz y sub sin registrar gasto, reactivar inactivas, tombstones). Ojo: rate-limit de 30/min | Al tocar `/api/categories` o `services/categories.js` |
| `qa-monto-nulo.mjs` | Una transacción con `monto_pen = NULL` no tira el dashboard al error boundary y se pinta honesta, no como "S/ 0.00" | Al tocar el render de montos o la conversión multimoneda |
| `qa-por-revisar.mjs` | El badge y filtro "Por revisar" + el toggle `alertas_transaccion` | Al tocar la vista de transacciones o esas preferencias |
| `qa-regla-lote.mjs` | La edición masiva (`PATCH /api/transactions`) hace que Neto APRENDA la regla comercio → categoría, igual que la individual | Al tocar edición en lote o el aprendizaje por comercio |
| `qa-tour-gate.mjs` | El gate del tour de onboarding es SERVER-side (1 vez por cuenta, no por navegador) | Al tocar el tour o `usuarios.tour_visto` |
| `qa-gate.mjs` | Verificación visual del gating por plan con sesión real: `pro` ve todo abierto, `free` (el muro) ve el paywall | Al tocar el paywall o el `ProGate` |
| `qa-referido-web.mjs` | El alta web con `?ref=CODE`: el middleware guarda la cookie `neto_ref` y `/auth/callback` la canjea | Al tocar referidos por la puerta web |
| `qa-web-signup-merge.mjs` | El corazón del onboarding web-first: `merge_and_link` (migración 046) fusiona dos filas en una, atómico, sin duplicar ni perder | Al tocar la vinculación de identidades |
| `qa-whatsapp-unlink.mjs` | El invariante del "cambiar número" self-serve: `POST /api/whatsapp/unlink` deja `whatsapp = null` sin romper el ciclo | Al tocar el desvinculado de número |

#### Herramientas de decisión, ya usadas

No afirman una regresión: imprimen material para tomar una decisión que **ya se
tomó** (`docs/SESION-ia-vs-texto-fijo.md`). Se conservan porque la decisión se puede
querer revisitar con datos nuevos, no porque haya algo que vigilar. Queman OpenAI.

| Harness | Para qué |
|---|---|
| `qa-lado-a-lado.mjs` | Imprime, para cada camino que pasa por `redactarConNETO`, la respuesta de la IA y el texto fijo exacto del `\|\| '...'`, lado a lado |
| `qa-ia-vs-fijo.mjs` | Mide si revivir la redacción con IA hizo a NETO más verboso, más lento o menos exacto |

#### Imprimen JSON y salen 0 pase lo que pase — se leen a ojo

**Estos no son automatizables tal como están, y es lo que hay que saber de ellos.**
Calculan el veredicto (`noDuplicates`, `pastRowVisible`, `caseDuplicates`) pero lo
vuelcan a stdout sin `process.exit(1)`, así que cablearlos a cualquier automatismo
daría verde siempre — que es la forma exacta en que un check muerto le miente a la
próxima auditoría, igual que la sección `supabase.checks` que se borró en la ola 4.
Si alguno de estos merece vigilarse solo, primero hay que darle exit code; mientras
tanto, se corren a mano y se lee la salida.

| Harness | Qué imprime |
|---|---|
| `qa-sweep.mjs` | Barrido adversarial de `/dashboard` + `/dashboard/transacciones` por plan: errores de consola y 4xx/5xx |
| `qa-analysis-sweep.mjs` | Lo mismo sobre score, reportes, suscripciones y alertas |
| `qa-planning-sweep.mjs` | Lo mismo sobre presupuestos, planes y deudas |
| `qa-espacios-config.mjs` | Gating de Espacios Free-vs-Pro + display de plan en Configuración + las páginas de join |
| `qa-espacios-gating-verify.mjs` | El modelo "host paga", que el split custom mueva balances, y el endpoint `default-split` |
| `qa-filter-effect.mjs` | Que los filtros de transacciones tengan EFECTO sobre los datos, no solo que devuelvan 200 |
| `qa-cat-dedup.mjs` | Que el donut de categorías no parta la misma categoría por mayúsculas |
| `qa-porrevisar-escape.mjs` | El escape hatch "+N en otros meses". **Depende de las filas que siembra `qa-por-revisar.mjs`**: corré ese primero o no prueba nada |
| `qa-susc-override.mjs` | Round-trip de detección de suscripciones y su override (renombrar, recargar, verificar, resetear) |
| `diag-load.mjs` | **No es un harness y su nombre lo dice**: diagnostica qué requests hacen lento el dashboard autenticado. Se conserva como herramienta |
| `webhook-harness.mjs` | **Tampoco es un harness: es la librería** que los demás importan (bootea el Express real, stubea `enviarWhatsapp`, firma como Meta). No se corre solo |

**`shot-*.mjs` / `*-shot.mjs` son one-offs, y no se commitean.** Capturan una
pantalla para un sprint concreto (un rediseño, un banner nuevo, una tarjeta
bloqueada) y su valor se agota cuando ese trabajo cierra. No afirman nada: no
tienen aserciones ni exit code útil. Dejarlos en el repo los convierte en
mantenimiento perpetuo de código que nadie va a volver a correr. Si necesitás
capturar algo, copiá el forjado de cookie de `qa-login.mjs` y borrá el archivo al
terminar. Por eso se eliminó `shot-gmail-bloqueado.mjs` en la ola 4.
