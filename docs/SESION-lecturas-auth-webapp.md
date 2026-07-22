# Sesión: la lectura de `usuarios` tras el auth, en la webapp

Prompt de arranque autocontenido. Trabajar desde `C:\Vortik.dev\products\neto\app\webapp`
(el backend está un nivel arriba, en `app/`).

---

## Por qué existe esta sesión

Es el último pendiente del barrido de fallos silenciosos (`docs/SESION-escrituras-sobre-lectura-fallida.md`,
cerrado el 22-jul-2026). Quedó anotado como "`getSessionUser`" y diferido a propósito, con esta
razón: *"toca el camino de auth de toda la webapp y merece verificarse con el cliente en la mano,
no a ciegas"*.

**Ese título se queda corto y conviene saberlo antes de empezar.** `getSessionUser` es solo la
instancia de espacios. Al mapear el patrón aparecen **~33 archivos de ruta** que hacen el mismo
lookup, en **tres formas distintas**, y **ninguna captura el `error`**:

| Forma | Dónde | Qué pasa si la lectura falla |
|---|---|---|
| `getSessionUser()` | `src/lib/spaces-server.ts:64` | `if (!data) return null` → el caller responde **401 Unauthorized** |
| `getNetoUserId()` / `getNetoUser()` | `src/lib/supabase/auth.ts` (solo `/api/pro/*`) | devuelve `null` → 401 |
| lookup inline duplicado | ~30 rutas (`dashboard`, `transactions`, `goals`, `debts`, `score`, `budgets`, `export`, …) | `if (!usuario) return 404 'User not found'` |

En los tres casos una lectura caída se le presenta al cliente como **"no eres tú" o "no existes"**,
que es lo que un usuario legítimo con sesión válida ve cuando Supabase tose. Es exactamente la
clase del barrido: el `error` que nadie lee, no el `catch`.

`authorizeSpace` (`spaces-server.ts:91`) tiene el mismo problema un nivel más abajo con
`space_members`: lectura caída → **403 "Not a member"** sobre alguien que sí es miembro.

## La decisión de alcance, primero

Antes de tocar nada hay que decidir esto y sustentarlo, porque cambia el tamaño de la sesión:

**Opción A — solo la capa de auth (recomendada de arranque).** Arreglar los dos helpers
(`getSessionUser`, `getNetoUserId`/`getNetoUser`) y `authorizeSpace`. Cubre espacios y `/api/pro/*`
con un cambio chico y verificable.

**Opción B — unificar.** Extraer un helper único que distinga los tres casos (sin sesión → 401 /
usuario inexistente → 404 / lectura caída → 500) y migrar las ~30 rutas inline. Es la solución de
raíz y elimina la duplicación, pero toca 30 archivos de una y el riesgo de regresión en rutas que
hoy funcionan es real.

Lo que **no** se puede hacer es arreglar solo `getSessionUser` y declarar cerrado el pendiente: eso
deja 30 rutas con el mismo agujero y un doc que miente. Si se elige A, hay que dejar B anotado
explícitamente como pendiente con su alcance medido.

Punto fino que hay que resolver sí o sí: hoy `null` significa dos cosas distintas (no hay sesión /
no hay fila). Un usuario recién registrado sin fila en `usuarios` es un 404 legítimo. La lectura
caída tiene que ser un **500**, no un 401 ni un 404, o el cliente sigue sin poder distinguir.

## Por qué un 401 espurio importa más que un 500

No es solo un código de estado feo. Un 401 en la webapp puede empujar al cliente a un logout, y el
usuario pierde la sesión por un hipo de red. Un 404 "User not found" es peor de cara al usuario:
sugiere que su cuenta no existe. Un 500 dice la verdad — algo se rompió de nuestro lado — y no
destruye la sesión. **Antes de cambiar nada, verificar en el código del cliente qué hace con un 401**
(buscar interceptores, `signOut()`, redirects a `/login`) y anotarlo: es lo que dimensiona el daño
real y va en el commit.

## La restricción que define esta sesión: la webapp no tiene tests

`webapp/package.json` no tiene vitest, jest ni ningún runner, y no hay un solo `*.test.ts` en
`src/`. Los 437 tests del repo son **del backend** y no cubren nada de esto. O sea que el loop de
feedback de las otras sesiones (test de regresión + mutación) **no aplica tal cual** y hay que
decidir con qué se reemplaza. Opciones, a evaluar en la sesión:

1. Montar vitest en la webapp solo para esto (es la primera vez, así que hay costo de setup y
   queda como infraestructura para el futuro).
2. Un harness en `qa-e2e/` que fuerce el fallo de lectura contra la app desplegada.
3. Verificación manual con el cliente en la mano + los harness de espacios que ya existen.

Sea cual sea, la regla del barrido no se negocia: **un fix sin una prueba que falle al revertirlo no
está demostrado.** Si se elige (1), aplica mutación igual que siempre.

## Cómo verificar

```bash
cd C:\Vortik.dev\products\neto\app\webapp
npx tsc --noEmit          # tiene que quedar limpio
npm run build             # next build
npm run lint              # BASELINE: 57 problems (21 errors, 36 warnings)
```

El baseline de lint es **57** medido el 22-jul-2026. No hay que bajarlo, pero **no puede subir** y
ninguno de los hallazgos puede caer en los archivos tocados.

Harness de espacios que ya existen y son los más cercanos a lo que se toca (correr desde `app/`):

```bash
node qa-e2e/qa-espacios-join-split.mjs
node qa-e2e/qa-espacios-gating-verify.mjs
node qa-e2e/qa-espacios-split-parity.mjs
node qa-e2e/qa-espacios-config.mjs
```

Y el login autenticado, que es la vía autónoma preferida:

```bash
cd qa-e2e && npm install && npx playwright install chromium && node qa-login.mjs
```

### Gotchas de verificación que ya costaron caro (no re-descubrirlos)

- **Verificar contra `https://app.neto.pe` post-deploy, no contra `next dev`.** El dev server se
  queda en skeleton: el bootstrap de `/api/dashboard` no dispara client-side. Contra el build real
  de Vercel sí pinta el dashboard completo.
- **La API de Next exige la cookie de sesión SSR de `@supabase/ssr`. NO acepta `Authorization:
  Bearer`** (probado: Bearer → 401). Si un probe da 401, primero descartar que sea esto y no el bug.
- **Overlays:** `neto_welcome_seen` y `neto_tour_v2` montan un `.fixed.inset-0.z-50` que intercepta
  clicks y **se re-montan** si se borran del DOM. Setear ambas keys de localStorage con
  `context.addInitScript()` antes de cargar.
- **Verificar el efecto, no el HTTP 200.** Correr la prueba contra el estado actual y verla fallar
  es lo que demuestra que la prueba sirve.

### Usuarios QA

Dos, ambos con auth de webapp y data sembrada (creds en `~/.config/neto/qa.env`):
- **QA Dashboard (Pro):** `ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172`, vars `NETO_QA_*`
- **QA Free:** `a9664eeb-ee0b-4640-b848-fdd0daa5aff0`, vars `NETO_QA_FREE_*`

Los dos tienen `is_test_user=true`, así que `lib/whatsapp.js` saltea los envíos reales de Meta.

## Método (el que destapó todo lo anterior)

Para cada sitio: **"¿qué pasa si esta lectura falla SIEMPRE?"** Si la respuesta es "el usuario ve
algo creíble pero falso", es un bug aunque hoy no se haya manifestado.

1. **Demostrar antes de proponer.** Forzar el fallo y ver qué recibe el cliente, no razonarlo.
2. **Capturar `error` y loguear con tag propio** donde el fallback sea legítimo.
3. **Fallar ruidoso** donde la dependencia sea obligatoria.
4. **Prueba de regresión + mutación.** Revertir el fix a mano, ver fallar la prueba correcta,
   restaurar.
5. **Registrar también lo sano.** Un archivo verificado correcto es un resultado; anotarlo con cómo
   se demostró evita que alguien lo re-audite en tres meses.

## Contexto de lo ya hecho (no repetir)

El backend está cerrado para esta clase. Ver `docs/SESION-escrituras-sobre-lectura-fallida.md`:
`referrals.js`, `lib/pro-payment.js`, `services/shared-spaces.js` y `services/neto-score.js`, más
sus espejos de webapp `spaces-server.ts` (`getSpaceBalances`, `getSpaceSplitContext`,
`getSpaceMemberIds`) y `api/score/route.ts` + `api/score/backfill/route.ts`. **Esos espejos ya
lanzan; lo que queda sin tocar en `spaces-server.ts` es específicamente `getSessionUser`.**

También cerrado: `docs/SESION-barrido-candidatos-restantes.md` y `docs/SESION-fallos-silenciosos.md`.

Cuando esta sesión cierre, **el barrido de fallos silenciosos queda completo**. Actualizar el
"Estado del doc" de `SESION-escrituras-sobre-lectura-fallida.md` para decirlo.

## Convenciones

- Webapp: TypeScript, Next.js 16, App Router. Editar con Edit tool, UTF-8 sin BOM.
- Commit + push directo, mensajes en inglés con prefijo. Claude pushea y valida E2E.
- Nunca correr pruebas contra la DB real con data que no sea de los usuarios QA.
- El deploy de la webapp es Vercel (auto on push). Verificar contra prod después, no antes.
