@AGENTS.md

# Webapp — app.neto.pe

## Stack
- Next.js 16 + React 19 + TypeScript 5 (strict)
- Tailwind CSS v4 + shadcn/ui v4 + Magic UI
- Supabase Auth (Google OAuth) + Supabase PostgreSQL (RLS)
- React Query v5 (staleTime 5min, retry 1)
- Recharts v3 (charts), Motion v12 (animations)
- html2canvas-pro + jsPDF (export PDF)
- Sonner (toasts), Lucide (icons)

## Comandos
```bash
npm run dev      # Dev server (Turbopack)
npm run build    # Build produccion
npm run lint     # ESLint
```

## Arquitectura
```
src/
  app/                    # App Router (todas las paginas)
    layout.tsx            # Root layout (fonts, Supabase)
    auth/page.tsx         # Login Google OAuth
    dashboard/
      layout.tsx          # Sidebar + topbar + bottom-nav
      page.tsx            # Overview (KPIs, charts, widgets)
      transacciones/      # CRUD transacciones
      presupuestos/       # CRUD presupuestos
      reporte/            # Reporte PDF descargable
      metas/              # Metas de ahorro
      suscripciones/      # Deteccion automatica
      configuracion/      # Perfil, plan, referidos
    api/                  # API Routes (server-side)
      transactions/       # POST, PUT, DELETE
      budgets/            # POST, PUT, DELETE
      goals/              # POST, PUT, DELETE
      user/               # GET perfil
      advice/             # POST consejo IA (GPT-4o-mini)
      exchange-rate/      # GET tipo de cambio USD/PEN
      notifications/      # POST preferencias
      auth/callback/      # OAuth callback
  components/
    dashboard/            # Shell, sidebar, topbar, bottom-nav, KPIs
      charts/             # Donut, trend, score-gauge, heatmap
      widgets/            # Transacciones recientes, suscripciones, etc.
    shared/               # WhatsApp button
    auth/                 # OAuth button
  lib/
    supabase/client.ts    # Browser client (createBrowserClient)
    supabase/server.ts    # Server client (createServerClient + cookies)
    hooks/                # 13 React Query hooks (use-transactions, use-budgets, etc.)
    types.ts              # Interfaces TypeScript
    format.ts             # Formatters (moneda, fechas)
    constants.ts          # Constantes
    exchange-rate.ts      # Cache 1h dolar.pe
    subscriptions-catalog.ts  # 50+ servicios digitales
    validators.ts         # Validacion de inputs
```

## Patrones criticos

### Rendering: shell estatico + data en cliente (NO force-dynamic)
Las paginas del dashboard son `'use client'` y fetchean su data client-side via
React Query (RLS-scoped). NO llevan `export const dynamic = 'force-dynamic'`: el
shell se prerenderiza estatico y se sirve desde el CDN (primer paint instantaneo,
sin cold start serverless). El middleware ya protege `/dashboard` y el HTML
estatico solo contiene el skeleton (cero data de usuario). La velocidad en
revisitas la da el cache persistido de React Query (`lib/query-client.ts` +
`PersistQueryClientProvider` en `dashboard-shell.tsx`), no un render server que
bloquee el shell.

Usa `force-dynamic` SOLO si una ruta realmente renderiza data de usuario en el
server (lee `cookies()`/Supabase server en el render).

**Las cuatro pantallas de `/join/*` SON ese caso, desde el 22-ago-2026.** El patron
de arriba vale para el dashboard, donde el shell estatico se sirve del CDN y la data
llega despues con la sesion ya montada. Una invitacion es lo contrario: no hay sesion,
el contenido depende del codigo de la URL, y quien la abre viene de un WhatsApp con
datos moviles y sin cuenta. Ahi el shell estatico no adelanta nada — solo adelanta un
spinner. Medido: `fp = fcp` a los ~1.6s y el LCP entre 3.8 y 4.5s, o sea **2.1-2.8s de
"Cargando..."**; el mismo patron que en `/login` da gap 0.

Y no pagaban por serlo: las cuatro **ya** eran `ƒ` (`X-Vercel-Cache: MISS` en todas las
respuestas, porque el `export const dynamic` estaba puesto desde antes). La funcion se
invocaba igual en cada visita y devolvia un cascaron identico para cualquier codigo.
Resolver la invitacion en el server no agrega un viaje: usa el que ya se hacia.

La regla, entonces, no es "nunca `force-dynamic`" sino **de quien es la data**: si es
de la SESION, shell estatico + cliente; si viene de la URL y la lee alguien sin cuenta,
resolvela en el server. Lo vigila `src/app/join/contenido-en-el-html.test.ts`.

**`/` tambien es estatica, y su rebote vive en `middleware.ts`** (hallazgo P′6,
14-ago). Era una funcion `ƒ` que se invocaba en cada visita para hacer un
`redirect`, con `X-Vercel-Cache: MISS` siempre, sobre la primera pantalla que ve
cualquiera. El middleware ya corria ahi para atrapar el `?ref`, asi que resolver
el rebote ahi sale gratis. `app/page.tsx` quedo como un `redirect('/login')` sin
`searchParams` — eso es lo que la deja prerenderizarse.

Dos cosas del bloque de `/` en el middleware que no se tocan:
- **La rama de `code`/`token_hash`** reenvia a `/auth/callback`. Es por donde
  vuelve el magic link de Supabase cuando la Site URL apunta a la raiz. `page.tsx`
  ya NO la conserva, asi que borrarla del middleware deja el login por email sin
  retorno. La cubre `src/lib/middleware-raiz.test.ts`.
- **El bloque va ANTES del corto de `NEXT_PUBLIC_DEMO_MODE`.** Ese corto existe
  para saltear chequeos de AUTH y este rebote no es uno; con el corto por delante,
  en demo mode `/` caia al `page.tsx` reducido y el `code` se perdia en silencio.

### El root layout es una superficie de bundle, no un lugar para providers

Todo lo que se monte en `app/layout.tsx` entra al bundle de TODA ruta, incluida
`/login` — la primera pantalla del que llega desde WhatsApp, a menudo por el
navegador embebido y con datos moviles. Medido el 14-ago (P′8): `TooltipProvider`
de @base-ui costaba **51.5 KB gzip** ahi para cero tooltips fuera del dashboard.
Vive ahora en `DashboardShell`, junto a sus dos unicos consumidores.

Dos trampas que costaron descubrir:

- **`app/not-found.tsx` y `app/error.tsx` van en el arbol de cliente de toda
  ruta.** El `motion` del 404 le cobraba **38.8 KB gzip** al login; sacar `motion`
  de `login/page.tsx` bajaba 0.1 KB porque el que lo arrastraba era el 404. Si
  animas algo en esos dos archivos, hacelo con CSS (`tw-animate-css` ya esta).
- **El `<Toaster>` de sonner SE QUEDA en el root layout** (9.2 KB), y esta
  prohibido volver a bajarlo: sonner no re-emite, asi que un `toast()` seguido de
  una navegacion muere con el arbol que contiene al Toaster. El porque completo
  vive en `components/shared/app-toaster.tsx`.

**Como se mide un cambio de bundle acá:** Next 16.3 con Turbopack **ya no imprime
la tabla de First Load JS**. Los `<script src>` del HTML prerenderizado en
`.next/server/app/*.html` son lo que baja el navegador en la primera carga; el
grafo perezoso esta en claro dentro de cada chunk (`Promise.all(["static/chunks/…"])`).
Y si el delta te da ~0, sospecha del build antes que de la conclusion: pasó una vez
por leer un `.next` viejo.

### Autenticacion (2 capas)
1. **Supabase Auth** → Google OAuth → cookie session
2. **Mapeo interno**: `auth.user.id` → `usuarios.id` via `requireNetoUser()`
   (`lib/supabase/auth.ts`), con service-role client

### API Routes — patron estandar
```typescript
export async function POST(request: Request) {
  const auth = await requireNetoUser('id, plan')  // columnas que necesites
  if (!auth.ok) return auth.response
  // auth.user.id / auth.user.plan / auth.authId (id de Supabase Auth)
}
```

**No escribas el lookup a mano.** `requireNetoUser` es el unico sitio donde vive
el mapeo, y distingue tres casos que antes estaban colapsados en `null`:

| Senal | Significa | Responde |
|---|---|---|
| no hay sesion | no autenticado | 401 |
| `error` en la lectura | Supabase se cayo | 500 + log `[auth:usuarios]` |
| `data === null` | sesion valida, sin fila | 404 |

Usa `.maybeSingle()` y no `.single()` a proposito: con `single()` cero filas
TAMBIEN llega como error (PGRST116), asi que "no hay fila" y "la lectura se cayo"
quedan indistinguibles. Ese era el bug: el lookup estaba copiado en ~30 rutas y
ninguna leia el `error`, asi que un hipo de Supabase le decia al usuario "no eres
tu" (401) o "no existes" (404). `src/lib/supabase/auth-callsites.test.ts` falla si
alguien vuelve a escribirlo a mano bajo `src/app/api/`.

Si "no tener fila" es un caso valido en tu ruta (el onboarding), usa
`findNetoUser()`: devuelve null sin fila pero **lanza** si la lectura falla.

### Tests
`npm run test` (vitest, `src/**/*.test.ts`). Solo modulos de servidor — no hay
jsdom ni testing-library. Se monto para el fix de auth de arriba.

### Espacios (`space_*`): service-role-only POR DISEÑO — la autorizacion vive en el codigo

Las tablas `shared_spaces`, `space_members`, `space_expenses` y `space_settlements`
**no tienen policies RLS para `authenticated`**, y eso es deliberado, no un olvido.

El modelo "host paga" obliga a leer la fila `usuarios` del OWNER del espacio para
resolver el tier Pro. Una policy scopeada a `auth.uid()` nunca puede permitir eso:
un miembro necesita ver data de OTROS miembros. Por eso toda la feature pasa por
`/api/spaces/*` con service-role (que ignora RLS). RLS queda activo = deny-all.

Hubo policies SELECT escritas con la intencion de habilitar lectura `authenticated`,
pero eran **inservibles**: la de `space_members` se auto-referenciaba y fallaba con
`42P17: infinite recursion`. Nunca se disparo en prod porque service-role las
bypassa, pero daban falsa sensacion de cobertura. Se eliminaron (migracion 033).

**Consecuencia operativa:** no hay red debajo. Toda ruta nueva bajo `/api/spaces/*`
DEBE autorizar con el chokepoint de `lib/spaces-server.ts`:

```typescript
const auth = await requireSpaceMember(spaceId)  // o requireSpaceOwner
if (!auth.ok) return auth.response
// auth.user.id / auth.user.plan / auth.role
```

Una ruta que se olvide ese check es IDOR directo. No repliques el chequeo a mano.

### Espacios: la division de un gasto se CONGELA al registrarlo

`space_expenses.split_snapshot` (JSONB, NOT NULL) guarda las partes en centavos
enteros con las que se registro el gasto. Los balances se leen de ahi; **no** se
recalculan desde `split_rules` / `split_percentage`. Cambiar una regla afecta
gastos futuros, nunca los pasados (antes reescribia meses de historia, o sea que
un cambio de regla movia plata real entre personas en silencio).

Reglas que no se negocian:
- **Centavos enteros, no fracciones.** "Las partes suman el total" solo es exacto
  en enteros. El reparto de sobrantes es por resto mayor con desempate por
  `user_id`, para que el backend y la webapp caigan en el mismo numero.
- **Toda escritura de gasto pasa por `buildSplitSnapshot`** (`lib/spaces-split.ts`).
  Hay un CHECK en la DB que rechaza un snapshot que no conserve el monto.
- **Los balances cubren la union** de miembros actuales y de quien aparezca en el
  historial: si un ex-miembro sale del calculo, su deuda se evapora y el pagador
  queda acreditado por plata que nadie debe. Por eso `DELETE /members` responde
  409 si su saldo no es 0.
- **`services/spaces-split.js` es el espejo CommonJS** que usa el backend de
  WhatsApp. Si tocas uno, toca el otro: `tests/services/spaces-split-parity.test.js`
  importa los dos y falla si divergen. No relajes ese test.

### Espacios: unirse NO reescribe el reparto de nadie

`split_percentage` es un **peso**, no un porcentaje: `resolveSplitPlan` lo
normaliza dividiendo entre la suma. Pesos 70/30/50 son en realidad 46.7/20/33.3.

Cuando entra un miembro, entra con `joinSplitWeight(miembrosPrevios)` (el promedio
de los pesos vigentes) y **a nadie más se le toca el peso**. Una sola regla cubre
los dos casos: un espacio que nadie personalizó queda en partes iguales, y un
70/30 acordado conserva su proporción mientras el nuevo asume su parte.

Lo que había antes, y por qué no vuelve:
- El backend reescribía a **todos** a 100/n. Un 70/30 acordado moría porque
  apareció un tercero.
- La webapp metía al nuevo con un **50 fijo** sin mirar al resto. El mismo espacio
  dividía distinto según por qué puerta se hubiera entrado.

Como los gastos congelan su división, nada de eso reescribía el pasado, pero sí
cambiaba los gastos futuros sin consentimiento. Era el último camino por el que la
parte de alguien se movía sin avisarle. Reglas que lo sostienen:
- **Los dos caminos de join usan `joinSplitWeight`**: `services/shared-spaces.js`
  (`unirseEspacio`) y `api/spaces/join/route.ts`. La paridad la cubre
  `tests/services/spaces-join-split.test.js` más el test de espejo.
- **Se avisa al que ya estaba.** `notificarNuevoMiembro` manda el % efectivo antes
  y después. La webapp no puede mandar WhatsApp (no tiene token de Meta), así que
  llama a `POST /admin/espacio-nuevo-miembro` con ADMIN_KEY. Es best-effort: fuera
  de la ventana de 24h de Meta el mensaje libre no se entrega, así que la garantía
  real es la webapp.

### Espacios: quién puede cambiar el reparto

La línea de autorización del módulo, deliberada:

| Manda el owner | Manda cualquier miembro |
|---|---|
| quién ESTÁ en el espacio (`members` DELETE) y si el espacio existe (`[id]` PUT/DELETE) | cómo se REPARTE y qué se gasta (`default-split`, `split-rules`, `budgets`, `expenses`, `settle`) |

`default-split` es de cualquier miembro **a propósito**. Se evaluó gatearlo al
owner y se descartó por tres razones:
1. **No cierra el hueco, solo elige quién lo abre.** El owner podría igual cambiar
   lo que pagan todos en silencio. El problema nunca fue el permiso.
2. **Rompe el caso principal.** En un espacio de pareja, si tu pareja creó el
   espacio, no podrías ajustar tu propio porcentaje sin pedírselo.
3. **Partiría la línea de arriba a la mitad**, dejando `split-rules` (que mueve la
   misma plata) abierto igual.

Lo que hace que sea seguro es el **aviso**, no el permiso: `notificarRepartoEditado`
le escribe a todos menos al que editó, con su % efectivo antes y después. A quien
no le cambió la parte no se le escribe, porque un aviso de "pasó de 50% a 50%"
entrena a ignorar los que sí importan.

Los tres caminos que mueven plata futura avisan, y comparten la fontanería
(`avisarAMiembros` en `services/shared-spaces.js`: a quién se le escribe, el
encabezado, el pie, el best-effort). Lo único propio de cada uno es el cuerpo:

| Camino | Aviso | Cuerpo |
|---|---|---|
| join (`POST /api/spaces/join`) | `notificarNuevoMiembro` | "tu parte por defecto pasó de X% a Y%" |
| `PUT default-split` | `notificarRepartoEditado` | igual, con el actor en el encabezado |
| `PUT split-rules` (Pro) | `notificarReglasEditadas` | una línea POR CATEGORÍA que le cambió |

`split-rules` no reusa `avisarCambioDeParte` porque ahí la parte de alguien es un
número y acá es uno por categoría: un "tu parte pasó de X% a Y%" sin nombrar la
categoría sería falso, ya que su parte en todo lo demás no se movió. El aviso
nombra explícitamente cuando una categoría **vuelve al reparto por defecto** (regla
borrada), y corta a 5 categorías con un "Y N categorías más" — un WhatsApp de diez
líneas no se lee, y el detalle completo está en la webapp.

Los porcentajes de todos los avisos salen de `effectiveSplitPercentsFor` (el mismo
motor que cobra), nunca de una fórmula aparte, y la paridad TS↔CJS la cubre
`tests/services/spaces-split-parity.test.js`.
- **La UI muestra el % efectivo** (`effectiveSplitPercents`), nunca la columna
  cruda. Pintar el peso con un "%" pegado le decía "70%" a quien paga 46.7%.

### Multimoneda
- Columnas: `monto` (original) + `monto_pen` (convertido) + `tipo_cambio`
- Conversion en insert/update via `getExchangeRate()`

### React Query hooks
- Ubicacion: `src/lib/hooks/`
- Query keys incluyen filtros (mes, anio) para invalidacion
- Mutations con `onSuccess` → `queryClient.invalidateQueries()`

## Theme "Nocturnal Precision"
- Dark-only, OLED-friendly
- Background: #0E0E0C, Foreground: #F0EFE8
- Primary: #1D9E75 (verde Neto)
- Solid surface tiers (no glassmorphism): `.glass-card` uses #131311 + border
  rgba(240,239,232,0.08) + drop shadow. `.glass-card-elevated` uses #1C1C19
  for modals/nested content. Surface tokens live in `@theme` as
  `--color-neto-bg2` (#131311) and `--color-neto-bg3` (#1C1C19).
  Note: the class is named `.glass-card` for backwards compatibility but
  the blur was removed during the mobile-comfort sprint (feat/mobile-comfort,
  April 2026) because it drained battery on Android mid-range and was
  nearly invisible on #0E0E0C anyway.
- Form inputs use `.form-input` utility: #1A1A17 bg, focus ring #1D9E75.
- Typographic tokens: `--text-display` (44px hero), `--text-hero` (52px),
  `--text-section` (18px), `--text-label` (12px) — defined in `@theme`.
- Tokens en `globals.css` via `@theme` (Tailwind v4)

## Deploy
- Vercel: **el auto-deploy de `main` esta APAGADO** (`webapp/vercel.json`,
  `git.deploymentEnabled.main = false`). La webapp llega a produccion por un solo
  camino: el job `deploy-webapp` de `.github/workflows/ci.yml`, que corre despues de
  `needs: [test, webapp]`. Un tsc o un test rojo = no hay deploy.
  Probado el 05-ago-2026 rompiendo `estaEnMuro` a proposito: `webapp` rojo,
  `deploy-webapp` skipped, produccion sirviendo todavia el commit anterior.
  Los previews de PR siguen funcionando por la integracion de Git.
- Env vars en Vercel: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY

### `npm audit` deja 2 moderate a propósito — no las "arregles"

`npm audit --omit=dev` reporta `uuid` y `exceljs`, y el único fix que ofrece npm es
**bajar exceljs a 3.4.0**, que es un downgrade de dos majors sobre la librería que genera
los Excel de export. No se hace, y no es pereza: la vulnerabilidad es *"missing buffer
bounds check en v3/v5/v6 **cuando se pasa `buf`**"*, y exceljs importa **solo `v4`**
(`node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`, única
aparición) sin argumento `buf`. El código vulnerable no es alcanzable desde acá.

Recomprobarlo cuando cambie exceljs, con el comando y no con la memoria:

```bash
grep -rn "from 'uuid'\|require('uuid')" node_modules/exceljs/lib
```

Si aparece un `v3`, `v5` o `v6`, entonces sí hay que actuar. El resto de lo que reportaba
la auditoría del 10-ago (S′4: sharp, postcss bajo next, nanoid, dompurify — esta última
corre en el browser de todos, vía jspdf y posthog-js) se cerró con `npm audit fix`: eran
in-range y quedaron en el lock.

> **Ojo con `npm audit fix --omit=dev`**: además de arreglar, deja el `node_modules` sin
> devDependencies, así que `npx tsc` se cae a un paquete `tsc` cualquiera del registro que
> imprime "This is not the tsc command you are looking for" **y sale con código 0**. Un
> typecheck en verde que no compiló nada. Correr `npm install` después, siempre.

## Gotchas
- Next.js 16 tiene breaking changes vs versiones anteriores — leer `node_modules/next/dist/docs/` antes de escribir codigo
- Tailwind v4 usa `@import` en CSS, NO plugin en postcss.config
- Imagenes remotas: solo `lh3.googleusercontent.com` (avatars Google)
- Dashboard = shell estatico (sin `force-dynamic`) + data en cliente; ver "Rendering" arriba
- Service-role key SOLO en API routes server-side, NUNCA en cliente

## Deploy & monitoring
- Config: `.claude/deploy-config.json` (Vercel app.neto.pe + Supabase RLS check).
- Daily canary 10am Lima vía scheduled task `canary-daily-deploys`. Reporte solo si hay fallo en `C:/Vortik.dev/memory/canary/`.
- Verificación manual post-push: `curl -I https://app.neto.pe/` y `curl -I https://api.neto.pe/health`.
