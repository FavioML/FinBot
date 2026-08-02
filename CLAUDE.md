# CLAUDE.md — NETO Webapp

## Contexto del Proyecto

NETO es un asistente financiero personal por WhatsApp para el mercado peruano.
- Stack: Next.js 16 + TypeScript + Tailwind + shadcn/ui + Recharts + Supabase
- Repo: github.com/FavioML/FinBot
- Backend: en esta misma carpeta (index.js, handlers/, services/, lib/)
- Produccion webapp: app.neto.pe (Vercel)
- Supabase project: zvorjqlubmfrjtkbhqcx
- Numero WhatsApp produccion: +51 933 014 505

## Arquitectura del backend
- `index.js` — Express server, routes, middleware, handlers de crash (~160 lineas)
- `handlers/message-processor.js` — OpenAI Function Calling NLP + intent dispatch (~227 lineas)
- `handlers/neto-tools.js` — 14 tool definitions + mapToolToIntent (property remapping)
- `handlers/intent-registry.js` — Auto-loader que registra handlers desde `handlers/intents/`
- `handlers/intents/` — 12 archivos, 79 intents totales (social, premium, gastos, transacciones, presupuestos, metas, deudas, consultas, reportes, utilidades, analytics, moderacion)
- `gmail.js` — OAuth2 + parsers de correos bancarios (11 bancos)
- `reporte_html.js` — reportes HTML/PDF con Chart.js
- `lib/` — 11 modulos: config, constants, validators, formatters, dates, db, ai, logger, whatsapp, admin-notify, error-monitor
- `services/` — 14 modulos: transactions, budget, parsers, debts, metas, categories, neto-gpt, gmail-scanner, reports, summaries, notifications, recommendations, referrals, subscriptions

### Agregar un nuevo intent
1. Crear o editar archivo en `handlers/intents/nombre.js`
2. Exportar `{ intents: ['nombre_intent'], handle: async ({ intencion, msg, datos, usuario, from, ctx }) => string }`
3. Agregar tool definition en `handlers/neto-tools.js` (NETO_TOOLS array + TOOL_INTENT_MAP)
4. Si las propiedades del tool difieren de lo que espera el handler, agregar remap en PROPERTY_REMAP
5. El intent-registry lo carga automaticamente al inicio

## Infraestructura
- Railway: backend online, 22+ variables configuradas, health endpoint /health

### `railway.json` — por que existe y por que es una lista negra
Railway construye desde la raiz del repo, que tambien contiene `webapp/` (Vercel),
`qa-e2e/` y `docs/`. Sin `watchPatterns`, **cada push redespliega el backend de
WhatsApp**, incluido un commit que solo toca un markdown. Eso paso el 22-jul-2026:
dos deploys fallidos de Railway sobre commits sin una sola linea de backend.

**Verificado con un experimento controlado** (22-jul-2026), no asumido:
- `b2c0fe2` (agrega `railway.json`, matchea `**`) → deployment `1379f224` SUCCESS,
  backend reiniciado (uptime a 28s).
- `61efbf9` (solo `docs/`) → deployment `a02fd57e` **SKIPPED**, backend NO
  reiniciado (uptime continuo desde el proceso anterior).

> **Gotcha al verificar:** Railway crea la fila del deployment y la muestra unos
> segundos como `BUILDING` **antes** de resolverla a `SKIPPED`. Ver que aparecio
> un deployment no significa que vaya a construir. Mirar el estado terminal, y
> confirmar con el uptime de `/health`: si no reinicio, no se redesplego.

La lista es **negra a proposito** (`**` y despues excluir), no blanca. Con una lista
blanca, una carpeta de backend nueva dejaria de desplegarse **en silencio** y
produccion correria codigo viejo sin que nadie se entere. Con lista negra el default
es desplegar y cada exclusion hay que justificarla:
- `webapp/**` — lo despliega Vercel; ningun archivo de runtime del backend lo importa
  (verificado por grep). Ojo: `services/spaces-split.js` es el espejo CJS que el
  backend SI usa, y **no** esta excluido, asi que tocarlo si redespliega.
- `qa-e2e/**` — harness que corre local, nunca en el servidor.
- `docs/**` y `*.md` de la raiz — no los ejecuta nadie.

Los tests de paridad (`tests/services/spaces-split-parity.test.js`) si importan de
`webapp/`, pero corren en GitHub Actions, no en el build de Railway (el
`package.json` raiz no tiene script `build`). `watchPatterns` no los afecta.
- Supabase: RLS activo en todas las tablas, 11 tablas
- Vercel: webapp app.neto.pe con Google OAuth
- CI/CD: GitHub Actions (test en push/PR, Node 20)
- Tests: 292 tests automatizados (vitest)
- Logging: Pino con redaccion de secrets

### ⚠️ El backend asume INSTANCIA ÚNICA (Railway replicas=1)
Varias piezas dependen de que corra un solo proceso. Escalar a 2+ réplicas o hacer un rolling deploy con solape **rompe** estas garantías; antes de escalar hay que resolver cada una:
- **Crons (`cron/index.js`, setInterval):** cada réplica dispararía los mismos envíos (resúmenes, recordatorios, escaneo Gmail). Requiere mover el scheduling a un worker líder (lock en DB o proceso único dedicado).
- **Estado en memoria:** `authErrorNotifiedAt` (gmail-scanner), `otpIntentos` (webhook, rate-limit OTP inverso), `wamidCache` (dedup de webhooks Meta), `_tcCache` (tipo de cambio). Con N réplicas cada una tiene su copia → throttles/dedup se multiplican por N. Requiere store compartido (Redis/DB).
- **Ledgers JSONB con read-modify-write no atómico:** `deudas.recordatorios_enviados`, notificaciones. Dos réplicas leyendo-modificando-escribiendo el mismo array pierden updates (last-write-wins). Requiere updates atómicos condicionales (o mover el append a SQL).
- Ya resueltos con claim atómico a nivel DB (sí soportan concurrencia): `historico_importado` (barrido Gmail), `pagos.estado` (aprobación Pro), `gmail_msg_id` (índice único, doble barrido). Estos NO dependen de instancia única.

## Funcionalidades principales (19)
1. Registro WhatsApp (onboarding 4 pasos)
2. Lectura automatica correos bancarios (11 bancos)
3. NLP inteligente con OpenAI Function Calling (GPT-4o-mini, 14 tools → 79 intents)
4. Categorias/subcategorias personalizables
5. Presupuestos por categoria con alertas
6. Multimoneda USD/PEN (tipo de cambio dolar.pe)
7. Lectura imagenes Yape/Plin (GPT-4o Vision)
8. Carga masiva Excel/CSV
9. Dashboard web interactivo (Recharts)
10. Reportes HTML con graficos + PDF descargable
11. Trial de 14 dias + muro (S/10/mes, pagos Yape) — ver abajo
12. Referidos dos lados (1 referido Pro pagado = 1 mes gratis; el referido estrena a 50% off)
13. Resumen diario/semanal/mensual con IA
14. Aprendizaje por comercio (fuzzy match)
15. Multiples cuentas Gmail
16. Recordatorios diarios (8pm Lima)
17. Metas de ahorro con CRUD
18. Calendario financiero interactivo
19. PWA + onboarding tour

## Seguridad
- RLS en todas las tablas Supabase
- Rate limiting: 300 req/min global, 10/min admin
- Validacion de montos (NaN, Infinity, negativos, >999999.99)
- Dedup hash (MD5), ADMIN_KEY sin fallback hardcodeado
- Error handling centralizado + notificaciones admin WhatsApp

## Modelo comercial: trial de 14 dias, y el muro despues

No hay plan gratuito permanente. Todo usuario estrena Pro completo por 14 dias
desde su **primer gasto** (no desde el alta: con el alta reordenada alguien tarda
dias en registrar algo, y un trial sobre una cuenta vacia no produce un pago
informado). Al dia 15 cae al **muro**.

**La regla, y no se negocia: escribir nunca se corta; lo que se cobra es leer.**
Registrar gastos por WhatsApp es gratis para siempre — es la promesa del sprint de
activacion. Lo que se cobra es el dashboard, el historial, las features Pro y toda
consulta agregada por WhatsApp. Sobrevive un solo numero: el total del mes, pegado
a la confirmacion del gasto.

**Modelado (importante antes de tocar cualquier gate):** durante el trial `plan`
vale `'premium'`. Eso es lo que hace barato el cambio — los ~40 sitios que miran
esa columna entregan Pro sin tocarse — pero significa que **`plan === 'premium'`
ya NO significa "paga"**. Para eso esta `trial_estado` (migracion 052):
`null` = nunca tuvo trial · `activo` · `vencido` · `convertido`. Las metricas de
ingreso usan `esProPagado()` (`webapp/src/lib/admin-revenue.ts`), no el plan.

Y `free` dejo de ser un plan: **es el muro**.

| Pieza | Donde |
|---|---|
| Fuente unica del trial y del muro | `lib/trial.js` |
| Que intent/comando es lectura | `handlers/intents-acceso.js` (+ su test: un intent sin clasificar rompe el build) |
| Gate WhatsApp | chokepoint en `handlers/message-processor.js` antes de `getHandler` + cascada de `/` en `webhook.js` |
| Gate webapp | `requireLectura()` en `webapp/src/lib/supabase/auth.ts` → 402 (+ `lectura-callsites.test.ts`) |
| Gate crons (lo que se EMPUJA) | gate de plan en cada cron que empuja (+ `tests/cron/lecturas-proactivas.test.js`) |
| Por que canales sale un aviso proactivo | `notificarUsuario()` en `lib/notify-user.js` (+ `tests/notificaciones-duales.test.js`) |
| Avisos d11/d14 + downgrade | `cron/checks.js:checkTrialExpiry` |
| E2E | `qa-e2e/qa-trial-gate.mjs` (el muro bloquea), `qa-e2e/qa-trial-integridad.mjs` (el trial entrega), `qa-e2e/qa-gate.mjs free\|pro` |

**Tres preguntas distintas, no una** (auditoria 2026-08-01, seis huecos). `plan === 'premium'`
responde "¿tiene Pro AHORA?", y durante el trial eso es `true`. Las otras dos preguntas
necesitan las DOS columnas y tienen su predicado, en `lib/trial.js` y su espejo
`webapp/src/lib/plan.ts` — no las reimplementes inline:

| Pregunta | Predicado |
|---|---|
| ¿esta probando? | `enTrial(usuario)` — exige `plan='premium'` **y** `trial_estado='activo'` |
| ¿PAGA? | `esProPagado()` / `admin-revenue.ts` para MRR |
| ¿esta en el muro? | `estaEnMuro(usuario)` |

Cuatro de los seis huecos salieron de mirar una sola columna: el banner de prueba encima del
paywall, `/dashboard/pro` diciendole "Eres Neto Pro ⭐" a quien probaba (escondiendole el
precio y el 50% de referidos), `/premium` por WhatsApp igual, y el descuento invisible.

**Dos reglas que se pagaron caras:**
- **Una fila parcial no puede decidir.** `mensajeMuro` ramifica por `trial_estado`; el cron no
  seleccionaba esa columna y el mensaje del dia 15 prometia otros 14 dias gratis a quien
  acababa de gastarlos. Si tu `select` alimenta una decision, trae **todas** las columnas que
  esa decision mira.
- **El muro tiene dos caras.** Los chokepoints cortan lo que el usuario PIDE. Un cron EMPUJA, y
  cuatro empujaban gratis lo que el muro cobra. Todo cron que empuje necesita gate de plan o
  estar declarado exento en `tests/cron/lecturas-proactivas.test.js`.

Los avisos de fin de trial salen **solo en texto libre**, o sea que llegan a quien está dentro
de la ventana de 24h de Meta. Decision de Favio (2026-08-01): quien no escribio en 11 dias no
esta usando el producto, y no se paga por perseguirlo. El canal fiable para todos es el banner
del dashboard. `WA_TRIAL_TEMPLATE_ENABLED` se queda en `false`; el cableado esta probado y
reactivarlo es una env var. **No es un bloqueo de Meta** — ver `docs/whatsapp-templates.md`.

## Todo aviso proactivo sale por los DOS canales

El WhatsApp libre no se entrega fuera de la ventana de 24h de Meta (131047) y las plantillas
estan descartadas. O sea que **un aviso que solo existe en WhatsApp, para el usuario inactivo
no existe** — y el inactivo suele ser justo el destinatario (trial por vencer, recordatorio de
inactividad, un gasto que le cargaron en un espacio). La in-app es el unico canal que llega a
todos.

`notificarUsuario()` (`lib/notify-user.js`) es el unico camino. Es dueño de una sola cosa: **por
que canales sale esto**. No dedupea (eso vive en el call-site y hoy tiene cuatro mecanismos
distintos) y no gatea por plan (eso es `lecturas-proactivas.test.js`).

```js
const { notificarUsuario, CANALES } = require('../lib/notify-user');

await notificarUsuario({
  canales: CANALES.AMBOS,          // obligatorio; sin motivo cuando es AMBOS
  usuarioId: u.id, whatsapp: u.whatsapp || null,   // null es valido (usuario web-first)
  tipo: 'slug_para_notification_deliveries',
  mensaje: msgConMarkdownDeWhatsApp,
  titulo: 'Titulo de la campana',  // obligatorio si el canal in-app esta declarado
  tipoInApp: 'recordatorio',       // familia de icono (notification-bell.tsx). Default 'sistema'
  link: '/dashboard/x',            // deeplink; va a datos.link
});
```

Devuelve `{ wa, inApp }`. El canal in-app se escribe **aunque WhatsApp falle o el usuario no
tenga numero**: cada canal tiene su try/catch, no uno global.

Un canal unico (`CANALES.SOLO_WHATSAPP` / `SOLO_IN_APP`) exige `motivo` pegado al `canales`.
Hoy hay cinco excepciones y todas comparten la misma forma: la query que selecciona al
destinatario exige que NO tenga cuenta web, asi que no hay campana donde mostrar nada.
`grep -rn "CANALES.SOLO_" .` es la auditoria completa.

**Guard: `tests/notificaciones-duales.test.js`.** Ningun archivo fuera de los declarados puede
llamar `enviarWhatsapp` crudo, y los conteos de los declarados estan fijados (agregar una
llamada rompe el build a proposito: te obliga a decidir si lo tuyo es una RESPUESTA o un
EMPUJE). Si es respuesta, subi el numero; si es empuje, usa `notificarUsuario`.

Un `tipo` in-app nuevo **no** necesita migracion (`notificaciones.tipo` es varchar libre) ni
tocar la webapp (`TIPO_CONFIG[tipo] || TIPO_CONFIG.sistema`). Agregarlo a `TIPO_CONFIG` en
`notification-bell.tsx` es solo para que tenga icono propio.

## Pendientes activos
- [ ] Testimonios reales
- [ ] Video demo 30-60s
- [ ] Exit-intent popup con lead magnet
- [ ] Blog posts comparativos SEO
- [ ] Activar social media (3x/semana IG + 2x/semana TikTok)
- [ ] Verificacion de negocio en Meta (manual)
- [ ] Modularizar los monolitos reales: `services/subscriptions.js` (~1515 lineas). `handlers/webhook.js` ya se modularizo (2026-07-14): la maquina de estados de onboarding vive en `handlers/onboarding.js` (`manejarOnboarding` -> string|null; webhook solo delega), bajando webhook de ~1009 a ~758 lineas. index.js ya esta modularizado (~160 lineas).

## Convenciones criticas
- Archivos grandes (>10KB): editar con Edit tool, nunca reescribir completo
- Encoding: siempre UTF-8 sin BOM
- Git push: Claude hace commit + push directo de TODOS sus cambios, incluidos los que tocan `.github/workflows/**`, y valida en flujo E2E cuando el cambio lo amerita. Git esta configurado (`gh auth setup-git`) para usar la credencial de `gh` de FavioML (scope `workflow`), no el Git Credential Manager. Si algun push falla con "bad credentials" o falta de scope, correr `gh auth setup-git` de nuevo
- Verificar duplicados (grep) antes de aplicar cualquier patch
- Patches secuenciales, nunca paralelos al mismo archivo
- Variables de entorno: gestionar en Railway, nunca hardcodear

## Principios
- **Simplicidad:** Impacto minimo en el codigo
- **Causas raiz:** No soluciones temporales
- **Verificar:** Nunca marcar tarea como completa sin demostrar que funciona
