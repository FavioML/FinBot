# Sesión: qué merece un slot en el canary diario

Prompt de arranque autocontenido. Trabajar desde `C:\Vortik.dev\products\neto\app`.

---

## Por qué existe esta sesión

Quedó como deuda del 22-jul-2026: al cerrar el barrido de lecturas de auth
(`docs/SESION-lecturas-auth-webapp.md`) se propuso "meter los harness de `qa-e2e/` al canary
diario", Favio aceptó, y se cayó del alcance porque se cruzó un incidente de Railway. Esto la
retoma.

**No es "agregar los harness al canary".** Al mapearlo, la mitad de la premisa no se sostiene y
la sesión tiene que decidir, no ejecutar.

## Estado actual (verificado, no asumido)

El canary es la scheduled task `canary-daily-deploys`, cron `0 10 * * 1-7` (10am Lima),
definida en `C:\Users\USUARIO\.claude\scheduled-tasks\canary-daily-deploys\SKILL.md`. Hoy hace:

1. Checks HTTP de los 5 deploys, leyendo `canary.checks` de cada `.claude/deploy-config.json`.
2. Core Web Vitals vía CrUX para vortik.dev y neto.pe.
3. **Un harness de `qa-e2e`**: `node qa-e2e/qa-tono-neto.mjs`, con su costo anotado en línea
   ("gasta ~4 llamadas a OpenAI por corrida").

Reporta una línea si todo pasa y **solo crea archivo si hay fallo**
(`C:\Vortik.dev\memory\canary\canary-YYYY-MM-DD.md`). Esa regla de "silencio = sano" es lo que
hace que el reporte se lea; cualquier cosa que se agregue no puede romperla generando ruido.

## Las decisiones, primero

### 1. El probe de deploy no es canary material tal como está

`qa-e2e/probe-deploy-fetchnetouser.mjs` (commit `27cd0c7`) busca el string literal
`'No se pudo leer el usuario'` en los chunks del dashboard. Sirvió para lo que se escribió:
confirmar que un commit puntual llegó a producción. **Como check diario se pudre** en cuanto
alguien toque ese mensaje, y va a fallar sin que haya nada roto — el peor tipo de alerta, la que
entrena a ignorar el canal.

Lo que sí vale la pena a diario es la pregunta generalizada: **¿el bundle que sirve app.neto.pe
corresponde al HEAD de `main`?** Eso caza un deploy de Vercel que falló en silencio o que quedó
atrás, que es un riesgo real y hoy no lo cubre nada. Decidir si se generaliza el probe hacia eso
(y cómo se determina "corresponde": build id, un marcador inyectado en build time, comparar contra
la API de Vercel) o si se descarta.

### 2. Cuáles de los harness pesados se ganan un slot diario

Los de espacios (`qa-espacios-join-split`, `-gating-verify`, `-split-parity`, `-config`) **escriben
filas reales en la Supabase de producción** con los usuarios QA: crean espacios, registran gastos,
liquidan y limpian al final. Eso es otra clase de cosa que un `curl`:

- Si una corrida falla a mitad, deja basura en prod que nadie limpia.
- Levantan Chromium; entre los cuatro son varios minutos, no segundos.
- Corren todos los días contra la misma cuenta.

`qa-login.mjs` es distinto: autentica, carga el dashboard, verifica que sembró data y que el
logout limpia, y **casi no escribe**. Cubre todo el camino de auth, que es justo lo que el barrido
del 22-jul tocó en 36 sitios.

**Recomendación de arranque (sustentarla o rebatirla, no aceptarla por defecto):** `qa-login.mjs`
diario, los de espacios NO diarios. Los de espacios encajan mejor como semanales o como gate
post-deploy cuando el push toca `spaces-*`. La pregunta que decide cada caso es: *¿qué regresión
caza este harness que los checks HTTP no cazan, y con qué frecuencia puede aparecer?*

### 3. Dónde se declara: config o SKILL.md

Hay una inconsistencia real que conviene resolver, no heredar. El `CLAUDE.md` del workspace dice
que **`deploy-config.json` es la fuente de verdad** de cada deploy, pero `qa-tono-neto.mjs` está
hardcodeado en el SKILL.md del canary. Dos opciones:

- Extender el schema con una sección `canary.harnesses` (comando, costo, criterio de fallo) y que
  el SKILL.md solo itere. Consistente con la regla del workspace.
- Dejarlo hardcodeado, aceptando que la fuente de verdad del canary es el SKILL.md y no el config.

Cualquiera sirve; lo que no sirve es que queden las dos a medias.

## Prerequisito que hay que verificar antes de prometer nada

`qa-tono-neto.mjs` es Node puro (llama a OpenAI). **`qa-login.mjs` y los de espacios usan
Playwright y Chromium**, que es una dependencia que el entorno de la scheduled task puede no
tener. Confirmarlo antes de wirear:

```bash
cd C:\Vortik.dev\products\neto\app\qa-e2e && npm install && npx playwright install chromium
node qa-login.mjs
```

Si el entorno del cron no puede levantar Chromium, toda la sesión cambia de forma y hay que
decidir entre instalarlo ahí o quedarse con checks HTTP.

## Credenciales y datos

Usuarios QA, ambos con `is_test_user=true` (así `lib/whatsapp.js` no manda WhatsApp reales).
Creds en `~/.config/neto/qa.env`:
- **QA Dashboard (Pro):** `ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172`, vars `NETO_QA_*`
- **QA Free:** `a9664eeb-ee0b-4640-b848-fdd0daa5aff0`, vars `NETO_QA_FREE_*`

Nunca correr nada contra la DB real con data que no sea de esos dos.

## Gotchas ya pagados

- **La API exige la cookie de sesión SSR de `@supabase/ssr`. No acepta `Authorization: Bearer`**
  (Bearer → 401). Si un probe da 401, descartar esto antes de buscar un bug.
- **Overlays:** `neto_welcome_seen` y `neto_tour_v2` montan un `.fixed.inset-0.z-50` que intercepta
  clicks y **se re-monta** si se borra del DOM. Setear ambas keys con `context.addInitScript()`
  antes de cargar la página.
- **Verificar contra `https://app.neto.pe`, nunca contra `next dev`**, que se queda en skeleton.
- **Railway muestra un deployment como `BUILDING` unos segundos antes de resolverlo a `SKIPPED`.**
  Que aparezca una fila no significa que vaya a construir. Mirar el estado terminal y confirmar con
  el uptime de `/health`: si el proceso no reinició, no se redesplegó.

## Cómo verificar esta sesión

El canary no se puede "probar" esperando a mañana. Correr la task a mano contra el estado actual y
ver el reporte que produce, en los dos escenarios:

1. **Todo sano** → tiene que seguir siendo una línea y **no crear archivo**. Si empieza a escribir
   archivo todos los días, el cambio empeoró el sistema.
2. **Fallo forzado** → romper a propósito un check (una URL inexistente en el config, o un harness
   que exit != 0) y confirmar que el reporte lo nombra con detalle accionable, y restaurar.

Esa segunda es la que demuestra que sirve, igual que la mutación en las sesiones de código.

## Contexto de lo ya hecho (no repetir)

`docs/SESION-lecturas-auth-webapp.md` cerró el barrido de fallos silenciosos y dejó montado vitest
en la webapp (`npm run test` desde `webapp/`, 17 tests). El backend ya tiene sus 437. Esta sesión
es sobre **monitoreo en producción**, que es lo que ningún test cubre: los tests dicen que el
código está bien, el canary dice que lo que está desplegado sigue vivo.

`railway.json` con `watchPatterns` (commit `b2c0fe2`, verificado) hace que commits de `webapp/`,
`qa-e2e/`, `docs/` y `*.md` de raíz ya no redesplieguen el backend. O sea que tocar `qa-e2e/` en
esta sesión es barato: no reinicia el WhatsApp.
