# Sesión: la lectura de `usuarios` tras el auth, en la webapp

**Estado: CERRADA el 22-jul-2026.** Commits `fa89461` (capa de auth + vitest) y `5121425`
(migración de las rutas). Con esto **el barrido de fallos silenciosos queda completo**; ver
`docs/SESION-escrituras-sobre-lectura-fallida.md`.

---

## El alcance real: 36, no 1

El pendiente estaba anotado como "`getSessionUser`". Al mapearlo resultó ser el mismo lookup —
sesión Supabase → fila de `usuarios` — repetido en **36 sitios y 3 formas**, y **ninguna capturaba
el `error`**:

| Forma | Dónde | Qué pasaba si la lectura fallaba |
|---|---|---|
| helper inline duplicado (las mismas ~8 líneas copiadas) | 30 rutas de `src/app/api/` | 401 `Unauthorized` o 404 `User not found` |
| `getNetoUserId()` / `getNetoUser()` | `lib/supabase/auth.ts` → 4 rutas `/api/pro/*` | 401 |
| `getSessionUser()` | `lib/spaces-server.ts` → 2 rutas + `authorizeSpace` | 401 |

En los tres casos, un usuario legítimo con sesión válida veía "no eres tú" o "no existes" porque
Supabase tosió. Es exactamente la clase del barrido: el `error` que nadie lee, no el `catch`.

## Dos hallazgos que no estaban en el mapeo inicial

**1. `auth/callback/route.ts` era la peor instancia del repo.** Busca al usuario por
`supabase_auth_id` y, si no lo encuentra, por `email`. Las dos lecturas se comían el `error`: con
Supabase caído ambas devuelven `null` y el callback **mandaba a `/onboarding` a un usuario que ya
existe**, incluido uno Pro que paga, a re-verificar su número por OTP. Ahora vuelve al login con
`?error=temporal` y un mensaje propio (distinto del `?error=auth`, que sí tiene sentido ofrecer el
email como alternativa; acá la sesión está bien y lo único correcto es reintentar).

**2. `getSpaceOwnerIsPro` seguía tragando el error**, aunque el doc daba `spaces-server.ts` por
cerrado salvo `getSessionUser`. Degradaba a `false`, así que presupuestos compartidos y reglas de
reparto le respondían "esta función es solo Pro" al owner que **sí** es Pro. Ahora lanza, igual que
`getSpaceBalances` y `getSpaceSplitContext` al lado.

También `authorizeSpace` un nivel más abajo: un fallo leyendo `space_members` era un 403
"Not a member" sobre alguien que sí es miembro.

## El espejo cliente (`use-user.ts`) — y por qué casi se escapa

Al cerrar la sesión dejé fuera los dos lookups del lado cliente diciendo "no es la misma clase,
ahí una lectura caída devuelve `null` y React Query reintenta". **Las dos mitades eran falsas, y
lo afirmé sin trazar a los consumidores.** Commit `c1befdc`.

**No reintenta.** Tragarse el `error` después de `maybeSingle()` hace que la queryFn **resuelva**
con `null`; `retry` solo cubre promesas *rechazadas*. React Query cachea ese `null` como resultado
bueno y lo persiste **24h en localStorage** (`PERSIST_MAX_AGE`). Un error se hubiera reintentado.

**Y el `null` no es inerte.** Dos consumidores lo leen como hecho:

- `canAccess(user?.plan, …)` trata `undefined` como Free (`lib/plan.ts:79`): un usuario Pro pierde
  calendario, consejo IA, breakdown del score, y empieza a comer los límites Free de metas y
  presupuestos.
- `AuthRedirect` (`dashboard-shell.tsx`) leía `null` como "no tiene fila" y lo mandaba a
  `/onboarding` a re-verificar por OTP. **Es el mismo fallo de `auth/callback`, alcanzable desde
  adentro del dashboard**, contra alguien que ya tiene cuenta y puede estar pagándola.

`fetchNetoUser` ahora lanza, así que `null` vuelve a significar una sola cosa. Arreglar el hook solo
no alcanzaba: con `isError` la data queda `undefined` y el shell expulsaba igual, así que la
decisión se extrajo a `decidirRedirectAuth`, donde `isError` espera en vez de expulsar.

**`PostHogProvider` queda tal cual, a propósito** (resultado sano, anotado para no re-auditarlo):
ahí el fallback es legítimo y ya está documentado en el código — la lectura corre sin gate y puede
perderle la carrera a la propagación del token. Si falla, `identify()` no dispara y el funnel pierde
un stitch. No le llega nada falso al usuario.

**La lección de proceso, que vale más que el fix:** el método del barrido ("¿qué pasa si esta
lectura falla SIEMPRE?") se aplicó a 36 rutas y se abandonó exactamente en los dos archivos que se
decidió excluir. Una exclusión necesita la misma evidencia que una inclusión: trazar consumidores
solo puede *agregar* consecuencias, nunca quitarlas, así que toda estimación sin trazar lee bajo.

## Lo que hace el cliente con un 401 (verificado, no razonado)

Esto es lo que dimensiona el daño y por eso se midió antes de tocar nada:

- **No hay interceptor global ni `signOut()` automático.** `signOutAndClear()`
  (`lib/query-client.ts:73`) solo corre desde acciones explícitas del usuario (`user-menu.tsx`,
  `configuracion/page.tsx`, `onboarding/page.tsx`). **Un 401 espurio no desloguea el dashboard**;
  ahí el daño es data faltante, no pérdida de sesión. Esto es un resultado sano: anotado para que
  nadie lo re-audite.
- **Las 4 páginas de invitación sí ramificaban en 401** → `router.push('/login?redirect=…')`, y
  `middleware.ts:63` rebota a `/dashboard` a quien ya tiene sesión. O sea que **la invitación se
  perdía en silencio** y el usuario aparecía en el dashboard sin explicación. Ese era el daño
  concreto.
- El bootstrap del dashboard (`use-dashboard-bootstrap.tsx:82`) trata todo `!res.ok` igual, así que
  pasar de 404 a 500 no cambió nada del lado cliente.

## La decisión de alcance: unificar (opción B)

Se descartó arreglar solo los tres helpers, y no por completismo: **esa opción dejaba el fix sin
forma de probarse**. Con el lookup copiado 30 veces harían falta 30 pruebas para demostrar una sola
decisión. Unificando, un test del helper cubre las 36 rutas y la regla del barrido ("un fix sin una
prueba que falle al revertirlo no está demostrado") se puede cumplir. Además *borra* código: el
saldo de la migración es **-271 líneas**.

Se partió en dos commits revertibles por separado: la capa de auth primero (chica y verificable), la
migración mecánica después.

### El punto fino: `single()` vs `maybeSingle()`

`null` significaba dos cosas. Peor: con `.single()` **cero filas también llega como `error`**
(PGRST116), así que "no hay fila" y "la lectura se cayó" estaban mezcladas dentro del mismo objeto.
`requireNetoUser` usa `.maybeSingle()`, donde la señal queda limpia:

| Señal | Significa | Responde |
|---|---|---|
| no hay sesión | no autenticado | **401** |
| `error` presente | la lectura se cayó | **500** + log `[auth:usuarios]` (el mensaje de Postgres nunca sale al cliente) |
| `data === null` | sesión válida, sin fila | **404** |

Para los sitios donde no tener fila es el caso *normal* hay `findNetoUser()`: devuelve `null` sin
fila pero **lanza** si la lectura falla.

### Las tres que no fueron mecánicas

- **`/api/onboarding`** es la única excepción documentada y conserva sus lecturas propias: ahí "no
  hay fila" es lo normal (el usuario todavía no vinculó su WhatsApp), así que un 404 sería falso.
  Captura el `error`. El GET es el que el cliente pollea, y con el error tragado una lectura caída
  se veía igual que "todavía no confirmó" — el usuario mirando un spinner de una verificación que
  ya había ocurrido.
- **`/api/dashboard`** necesita el id de Supabase Auth (no el de Neto) para su gate de admin. Por
  eso `requireNetoUser` devuelve `authId` además de la fila, en vez de obligar al caller a sacarlo
  de las columnas seleccionadas.
- **`/api/score`** usaba el tipo de retorno del helper como tipo. Se reemplazó por un `ScoreUser`
  explícito.

### El split 401/404 sirve solo si el cliente lo usa

Las 4 páginas `/join/*` ahora ramifican también en 404 → `/onboarding`, que es el caso que antes
desaparecía. Y `/onboarding` respeta `?redirect` (solo rutas internas), así que terminar la
vinculación devuelve a la invitación en vez de aterrizar en el dashboard.

## Cómo se verificó

Loop de feedback: **vitest en la webapp** (no tenía runner). Las otras dos opciones que estaban
sobre la mesa se descartaron con motivo: un harness contra prod no puede hacer fallar a Supabase a
demanda sin inyectar un fault-injection env var y desplegarlo, y la verificación manual no da
mutación.

Dos pruebas, en `src/lib/supabase/`:
- `auth.test.ts` — los tres casos del helper más `findNetoUser`. Cubre las 36 rutas de una.
- `auth-callsites.test.ts` — **guard estático**: ninguna ruta bajo `src/app/api/` puede escribir el
  lookup a mano. Arreglar las 30 vale poco si la 31 nace igual.

**Mutación, en los dos sentidos:**
- Tragarse el `error` en el helper → la lectura caída vuelve a responder **404** y falla
  `auth.test.ts`. Es el bug original reproducido.
- Revertir una ruta migrada a su helper inline → falla el guard, nombrando el archivo.

```bash
cd C:\Vortik.dev\products\neto\app\webapp
npx tsc --noEmit          # limpio
npm run test              # 9 tests
npm run build             # OK, /onboarding sigue estático
npm run lint              # 57 (21 errors, 36 warnings) — igual que el baseline
```

**El alcance de la verificación lo define qué deploys dispara el push, no qué archivos tocaste.** Un
push a `main` dispara Vercel **y** Railway, porque el backend y la webapp comparten repo. En esta
sesión se verificó solo Vercel tras un cambio de webapp y quedaron dos deploys de Railway fallidos
sin mirar. Correr los tres, siempre:

```bash
curl -I https://neto.pe/            # landing (Cloudflare)
curl -I https://app.neto.pe/        # webapp (Vercel) — 307 en la raíz es normal
curl -s https://api.neto.pe/health  # backend (Railway)
```

Si un deploy falló, distinguir antes de opinar: **falló el build** (hay logs, puede ser el commit)
es distinto de **no hubo build** (`Deployment does not have an associated build`, etapas en "Not
started" = plataforma o cuenta, no el código). Esos dos eran del segundo tipo, sobre commits sin una
sola línea de backend. Se cerró con `railway.json` + `watchPatterns` (commit `b2c0fe2`): ver el
razonamiento de por qué es lista negra y no blanca en `app/CLAUDE.md`.

E2E contra `https://app.neto.pe` post-deploy (nunca contra `next dev`, que se queda en skeleton):
`qa-e2e/qa-espacios-join-split.mjs`, `qa-espacios-gating-verify.mjs`, `qa-espacios-split-parity.mjs`,
`qa-espacios-config.mjs`, `qa-login.mjs`.

### Gotchas de verificación (no re-descubrirlos)

- La API exige la cookie de sesión SSR de `@supabase/ssr`. **No acepta `Authorization: Bearer`**
  (Bearer → 401). Si un probe da 401, descartar esto antes que el bug.
- Overlays: `neto_welcome_seen` y `neto_tour_v2` montan un `.fixed.inset-0.z-50` que intercepta
  clicks y **se re-monta** si se borra del DOM. Setear ambas keys con `context.addInitScript()`
  antes de cargar.
- Usuarios QA (creds en `~/.config/neto/qa.env`, los dos con `is_test_user=true`):
  Pro `ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172` (`NETO_QA_*`), Free `a9664eeb-ee0b-4640-b848-fdd0daa5aff0`
  (`NETO_QA_FREE_*`).

## Método (el que destapó todo el barrido)

Para cada sitio: **"¿qué pasa si esta lectura falla SIEMPRE?"** Si la respuesta es "el usuario ve
algo creíble pero falso", es un bug aunque hoy no se haya manifestado.
