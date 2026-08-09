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
- `qa-e2e/**` — harness que corre local o en CI, nunca en el servidor.
- `docs/**` y `*.md` de la raiz — no los ejecuta nadie.

Los tests de paridad (`tests/services/spaces-split-parity.test.js`) si importan de
`webapp/`, pero corren en GitHub Actions, no en el build de Railway (el
`package.json` raiz no tiene script `build`). `watchPatterns` no los afecta.

**Y desde el 07-ago la flecha va tambien al reves: la suite importa de `qa-e2e/`.**
`tests/railway-watchpatterns-paridad.test.js` y `tests/railway-gate-timing.test.js`
importan predicados de `qa-e2e/backend-deploy-{fresh,gated}.mjs`. La exclusion sigue
siendo correcta —Railway no necesita redesplegar por un harness— pero "nunca corre en
el servidor" ya no significa "nadie mas lo mira": romper uno de esos archivos pone la
suite roja y, via "Wait for CI", **frena el deploy del backend**. Es el comportamiento
que se quiere (guard roto = no desplegar), pero no es obvio leyendo solo la exclusion.
Por eso los dos harness tienen guarda de `import.meta.url`: sin ella, importar el
predicado desde un test dispararia el fetch a prod como efecto secundario.

**El modelo de globs no es una lectura de la sintaxis: hay comportamiento medido detras.**
Los supuestos que podrian estar mal en las DOS implementaciones a la vez (y que
ningun test de paridad puede detectar, porque comparan una copia contra la otra):

| supuesto | por que podria fallar | que lo prueba |
|---|---|---|
| `**` matchea **dotfiles** | con minimatch/micromatch en default (`dot:false`) NO matchearia `.github/**` | `096593a` toco **solo** `.github/workflows/ci.yml` y Railway **construyo** |
| `!dir/**` excluye tambien los **sub-directorios con punto** | mismo `dot:false`: `webapp/**` no matchearia `webapp/.claude/...`, y esa ruta pasaria a estar observada | 4 observaciones independientes: `42d17d1`, `3b1d617`, `257f2f5`, `cde2525` tocaron `webapp/.claude/deploy-config.json` y salieron `No changes to watched files` |
| `!docs/**` excluye | — | experimento controlado del 22-jul (`61efbf9` → SKIPPED) |
| `!/*.md` **ancla a la raiz** | sin ancla seria recursivo y `handlers/notas.md` dejaria de desplegar | **NADA. Sigue sin medir** — ver abajo |

**El ancla de `!/*.md` era un supuesto disfrazado de medicion, y esta fila lo decia mal
hasta el 07-ago.** Citaba `aaed32e` y `cf6029b` ("tocaron solo `CLAUDE.md` de raiz →
`No changes`"). Las dos observaciones son reales y no separan nada: son igual de
compatibles con que el patron sea **recursivo**, que tambien excluiria un `.md` de raiz.
Para distinguirlos hace falta un commit cuyo veredicto dependa de un `.md` **anidado**, y
en 100 deployments no hubo ninguno (medido con `qa-e2e/backend-watchpatterns-real.mjs`,
que reporta `anclaDeRaizEjercitada` justamente por esto). Una observacion que no contradice
la hipotesis no es lo mismo que una que la prueba.

Se puede vivir con el supuesto porque el error cae del lado seguro: si Railway fuera
recursivo y el modelo anclado, el harness prediria "redespliega" donde Railway saltea, o sea
una **falsa alarma de STALE**. Nunca un falso PASS sobre un backend viejo, que es el modo de
falla que importa. Ningun archivo de runtime es `.md`, asi que produccion no depende de esto.

Lo que sigue **sin** prueba es la PRECEDENCIA (¿gana el ultimo patron que matchea, o es
"algun include y ningun exclude"?). Hoy es inobservable: hay un solo include y las
exclusiones no se solapan. Desde el 07-ago el harness ya **no adivina**: una lista que
re-incluye despues de excluir (`[..., '!infra/**', 'infra/**']`) **no compila**, con un
mensaje que manda a medirlo con un deploy de control primero. Antes esa lista pasaba los
tests en verde con el harness sub-reportando.

**`REMOVED` no significa "construyo".** Un deployment cae en `REMOVED` apenas deja de ser el
vigente, y ahi adentro conviven dos cosas muy distintas: los que construyeron y fueron
reemplazados, y los que **nunca construyeron** —el que otro push supero a mitad de build, el
que quedo en `WAITING` esperando una suite que nunca llego—. La señal que los separa es
**`meta.imageDigest`**, y se confirma pidiendo `buildLogs`:

| commit | status | `imageDigest` | `buildLogs` |
|---|---|---|---|
| `89206ac`, `112465b` | `REMOVED` | si | 127 / 129 lineas |
| `cbf267c` | `REMOVED` | **no** | 10 (superado a los 103s, menos que un build) |
| `8e338ff` | `REMOVED` | **no** | *"Deployment does not have an associated build"* |

Importa por dos cosas. Una: solo un deployment que construyo puede ser la BASE del diff que
Railway mira despues, y tomar como base a uno que no llego inventa desacuerdos (le paso al
harness nuevo con `112465b`, cuya base real era `41b3aca`). Dos, y es la trampa: el `meta` de
los que no construyeron viene **sin `configFile` y con `watchPatterns: []`**, porque nunca
llegaron a la etapa que escribe esos campos. Leer eso como *"Railway resolvio la config a una
lista vacia y por eso desplego igual"* es una conclusion entera armada sobre un campo que
falta — y estuvo escrita aca durante una hora el 07-ago antes de que los `buildLogs` la
desmintieran. No hay ninguna evidencia de que Railway haya desplegado ignorando
`watchPatterns`: **86 de 86 deployments juzgables coinciden con el modelo.**

**Ojo con una sutileza que se descubrio leyendo `meta.skippedReason`:** Railway evalua
`watchPatterns` sobre el diff desde el ultimo commit **DESPLEGADO**, no sobre el commit
suelto. Por eso `352356f` —un revert que toca `tests/`, ruta observada— dio
`"No changes to watched files"`. `backend-deploy-fresh` ya lo implementa bien (compara
`deployed...main`); no lo "arregles" a un diff por commit.

**Esta lista se escribe UNA sola vez**, en `railway.json`. `disparaBuildRailway()` de
`qa-e2e/backend-deploy-fresh.mjs` la **deriva** de ahi (`qa-e2e/lib/railway-watch.mjs`).

Hasta el 07-ago estaba copiada a mano en el harness, con un test de paridad pagando el
precio de la copia. El argumento para copiarla era que implementar el dialecto de globs
era mas superficie de error silencioso que comparar las dos listas. **Medido: era al reves.**
El test comparaba PROYECCIONES de una lista contra la otra —el conjunto de exclusiones, el
veredicto sobre los archivos que existen— y por cada proyeccion hay mutaciones que no la
cruzan. Tres pasaban 5/5 en verde con el harness sub-reportando, que es la direccion
peligrosa: `backend-deploy-fresh` da PASS sobre un backend genuinamente stale.

Lo que queda por verificar ya no es "¿las dos copias coinciden?" sino "¿este modelo coincide
con **Railway**?", que es otra pregunta y se responde midiendo:

| que lo vigila | que prueba | que NO prueba |
|---|---|---|
| `tests/railway-watchpatterns-paridad.test.js` | el compilador implementa los patrones declarados, contra una reimplementacion que traduce los globs a **expresiones regulares** (otro mecanismo a proposito: una copia literal solo detecta que editaste una de las dos), sobre el arbol real + probes **derivados de cada patron** (una exclusion nueva trae sus propios casos sola, aunque no exista todavia un archivo bajo esa ruta) | que el modelo sea cierto: dos copias de acuerdo pueden estar las dos equivocadas |
| el mismo test, tres casos mas | que el harness **se niegue a adivinar**: forma de glob nueva, lista blanca, y re-inclusion (precedencia no medida) **no compilan** | — |
| el mismo test, tres casos mas | que **ningun eslabon** de la cadena del predicado conozca una ruta (ni una comilla ni una barra en `disparaBuildRailway`, el closure de `crearPredicado` y `evaluarReglas`), que ningun directorio real del repo quede excluido a mano, y que las dos implementaciones coincidan sobre entradas adversariales | los closures de `compilarPatrones()`, que llevan barra legitima; y un directorio que **todavia no existe** — el hueco original era sobre `infra/` |
| `qa-e2e/backend-watchpatterns-real.mjs` | el modelo contra lo que Railway **hizo**, deployment por deployment, juzgando cada uno con SUS patrones. El 07-ago: **48/48** con la ventana por defecto, **86/86** con `NETO_WP_VENTANA=100` | las distinciones que la historia no ejercita: quitarle el ancla de raiz a `!/*.md`, o cambiar `startsWith` por `includes`, pasan en verde. Por eso reporta `ejercitado` |

Si tocas `railway.json`, no hay segunda mitad que actualizar — pero **corre el harness real**:
es lo unico que puede decirte si Railway entiende tu patron nuevo como vos.
- Supabase: RLS activo en todas las tablas (varias con deny-all a proposito, ver migr 033). El
  conteo de tablas no se escribe aca: decia 11 cuando ya eran 37
- Vercel: webapp app.neto.pe con Google OAuth
- CI/CD: GitHub Actions. `test` (backend, Node 20 = el piso que declara `engines.node`),
  `webapp` (tsc + tests, Node 24 = el que usa Vercel) y `deploy-webapp`, que **gatea el
  deploy**: Vercel ya no despliega `main` por su cuenta. Ver `webapp/CLAUDE.md`

### Los dos deploys estan gateados, pero por caminos DISTINTOS

Ninguna plataforma frena sola: por default las dos despliegan `main` apenas entra el push,
mire o no la suite. Cada una se cerro donde se podia, y las formas no son intercambiables.

| | Webapp (Vercel) | Backend (Railway) |
|---|---|---|
| Como se apago el auto-deploy | `webapp/vercel.json` (`git.deploymentEnabled: false`) | no se apago |
| Quien decide desplegar | el job `deploy-webapp` (`vercel deploy --prod`) | Railway, con **"Wait for CI"** ON |
| Donde vive la config | en el repo | en el **dashboard** de Railway |
| Que lo mantiene honesto | `needs: [test, webapp]` | el job `railway-gate` |

**Por que el backend no se despliega desde Actions.** `railway up` sube el directorio del
runner y **no consulta `watchPatterns`**, asi que habria que replicar la lista negra de
`railway.json` a mano, en otro dialecto de globs (`paths-ignore` no expresa el `!` igual).
Esa lista es negra a proposito — ver mas arriba — y desincronizada produce exactamente el
fallo que viene a prevenir: **una carpeta de backend nueva que deja de desplegarse en
silencio**. Ademas `railway up` construye desde el working tree del runner, no desde el
commit, y se pierde el enlace commit↔deployment del dashboard.

**El precio, y como se paga.** El toggle de Railway es invisible desde el repo. Por eso
`scripts/verify-railway-gate.mjs` lo consulta por API (`DeploymentTrigger.checkSuites`,
que **el MCP de Railway no expone** — mira `ServiceInstance`, y ahi no esta) y falla si
alguien lo apago. No frena nada: con el toggle apagado Railway ya desplego para cuando el
guard corre. Es el testigo, no el gate.

**Acoplamiento que conviene tener presente:** Railway espera el check suite ENTERO, no el
job `test`. Si `deploy-webapp` falla, el backend tampoco sale. Deja los dos lados en el
commit anterior — coherente, y la suite roja lo dice.

**Verificado con un experimento controlado el 05-ago-2026**, no asumido, y midiendo el reloj:

| commit | qué era | resultado |
|---|---|---|
| `52241cd` | el gate mismo, suite verde | `WAITING` a los 6s → `BUILDING` 15s después de la suite verde → `SUCCESS` |
| `6f76cbe` | una **aserción** rota a propósito | `WAITING` → **`SKIPPED`**, y `/version` siguió en `52241cd` |

Push → inicio de build pasó de **~7 segundos a ~2m50s**. Ese es el delator más barato de que
el gate sigue vivo: si un deploy vuelve a arrancar a los segundos del push, se cayó.

Se rompió la ASERCIÓN del test y no el código de producción, a propósito: si el gate hubiera
fallado, lo que llegaba a `api.neto.pe` era un backend sano igual. Acá se le escribe por
WhatsApp a gente real; el margen de error no es una pantalla fea.

**Repetido el 07-ago-2026 (`a213794`) para cerrar lo que faltaba**: con el commit roto en HEAD,
`NETO_INFLIGHT_MIN=0 node qa-e2e/backend-deploy-fresh.mjs` → **exit 1, `STALE`**, listando
`tests/codigos-seguros.test.js`. Esa variable no es opcional para esta prueba: **sin ella el
harness da exit 0** porque el default de 10 minutos trata el commit como deploy en vuelo, y por
eso la corrida del 05-ago —hecha después del revert— no probaba nada.

**Los motivos, leídos de la API el 07-ago** (hace falta un API token de **cuenta**: el del CLI en
`~/.railway/config.json` vence y da `Not Authorized`; el MCP muestra el estado pero no `meta`):

| commit | qué era | status | `meta.skippedReason` |
|---|---|---|---|
| `a213794` | aserción rota | `SKIPPED` | **`CI check suite failed`** |
| `352356f` | el revert | `SKIPPED` | **`No changes to watched files`** |
| `89206ac` | toca `tests/`, suite verde | `SUCCESS` | — |
| `096593a` | el deploy sin gate del 06-ago | `REMOVED` | **ninguno** |

La última fila es la prueba directa del fail-open: **no tiene motivo de skip porque no fue
skipeado**, se construyó y desplegó. `REMOVED` es Railway marcándolo reemplazado cuando `89206ac`
lo sustituyó. Y el resto de ese día (`aaed32e`, `cf6029b`) dice `No changes to watched files`: con
Actions caído, lo único que frenó a esos commits fue `watchPatterns`, no el gate. `096593a` salió
justamente porque tocaba `.github/workflows/ci.yml`, que sí está observado. Cualquier commit de
runtime esa tarde habría salido igual.

> **`SKIPPED` tiene dos motivos distintos y no se distinguen desde la UI.** Railway los nombra
> en `meta.skippedReason` del deployment (por API): `"CI check suite failed"` es el gate
> haciendo su trabajo, `"No changes to watched files"` es `watchPatterns`. Confundirlos hace
> creer que el gate funciona cuando en realidad nunca se evaluó. Ojo también con que un
> **revert** cae siempre en el segundo caso: deja el árbol idéntico al último desplegado, así
> que Railway no tiene nada que construir y eso es correcto, no un fallo.

### El gate falla cerrado, MENOS en un caso: cuando la suite nunca arranca

Descubierto el 06-ago-2026 durante el outage de Actions, y contradice la primera versión de
esta sección. **"Wait for CI" espera los check suites que EXISTEN cuando Railway evalúa.** Si
GitHub está tan degradado que todavía no creó el workflow run, Railway no encuentra nada que
esperar y despliega.

| | |
|---|---|
| push de `096593a` | ~17:27:35 UTC |
| Railway crea el deployment | 17:27:36 |
| Railway termina, `SUCCESS` | **17:28:42** |
| GitHub crea el run de CI | **17:30:48** |

Tres minutos de diferencia. El deploy salió sin gate y nadie lo frenó. Ese día no pasó nada
—entre el último commit testeado y ese no cambió un solo archivo de runtime del backend— pero
el agujero es real y **no tiene arreglo del lado de Railway**: no se puede esperar algo que no
existe.

Es una versión mucho más chica del problema original (ventana de segundos, y solo durante un
incidente de GitHub), pero es exactamente cuando menos querés un deploy sin gate. Lo único que
lo puede atrapar es **detectarlo después**: preguntar si el commit DESPLEGADO tuvo su suite
verde. `backend-deploy-fresh` no sirve para eso — da PASS, porque el commit sí está desplegado.

**Eso es `qa-e2e/backend-deploy-tested.mjs`** (07-ago-2026), harness `backend-deploy-tested` del
canary. Son preguntas distintas sobre el mismo commit y hacen falta todas — las tres primeras
sobre ESTE deploy, la cuarta sobre el modelo del que las tres dependen:

| harness | pregunta | el caso que solo él ve |
|---|---|---|
| `backend-deploy-fresh` | ¿está al día? | quedó código de backend en `main` sin desplegar |
| `backend-deploy-tested` | ¿lo que corre pasó los tests? | se desplegó un commit **sin suite verde** |
| `backend-deploy-gated` | ¿el deploy **esperó** al gate? | el bypass cuya suite después salió **verde** |
| `backend-watchpatterns-real` | ¿el modelo de `watchPatterns` es **cierto**? | el predicado del que dependen los otros miente sobre Railway, con todo en verde |

### La API de compare TRUNCA en 300 archivos, y los tres primeros dependen de esa lista

Medido el 08-ago-2026 contra la API en vivo, no leído en la doc de GitHub:
`repos/{repo}/compare/{base}...{head}` devuelve **como máximo 300 entradas en `files`**, sin
bandera y sin campo de total. El corte está caracterizado: la lista es **byte-idéntica** a
`git diff --name-only base...head | LC_ALL=C sort | head -300`.

| `1bdbd6a` (`HEAD~400`) `...main` | |
|---|---|
| archivos reales (`git`) | 667 |
| observados por `railway.json` | 302 |
| lo que devolvía la API | 300 → **193** observados |
| **observados invisibles** | **109** |

Las dos salidas que **no** existen, las dos medidas antes de descartarlas:

- **No hay campo de total.** Los únicos numéricos del payload son `ahead_by`, `behind_by` y
  `total_commits`.
- **Paginar no sirve y falla del lado peligroso.** `per_page`/`page` paginan los **commits**:
  `files` viene poblado solo en la página 1 y siempre topado en 300; `page=2` devuelve
  `files: 0`. Un harness que paginara ingenuamente concluiría "no hay más archivos".

La que **sí** existe: el media type `application/vnd.github.diff` del mismo endpoint **no está
topado**, y conserva la semántica de RANGO. Eso es `qa-e2e/lib/github-compare.mjs`, y de ahí
toman la lista `backend-deploy-fresh` y `severidad()`.

Medido: entrega **667 y 744 bloques `diff --git`** en los dos rangos de arriba, contra 667 y 744
archivos que reporta `git`. La igualdad es sobre los BLOQUES; la lista de rutas que sale del
parser es un **superconjunto** (668 y 749) porque un rename aporta sus dos puntas, igual que el
`previous_filename` del JSON. Es deliberado: mover un archivo de una ruta observada a una
excluida es un cambio en la ruta observada. Lo que se verificó es que **no falta ninguna**
(`solo-en-git` vacío en los dos rangos), no que los largos coincidan.

> **No lo "arregles" uniendo diffs por commit ni por tramos: es INCORRECTO, no solo caro.**
> Railway evalúa el diff desde el último commit DESPLEGADO, así que un revert como `352356f`
> —que toca `tests/` en su propio diff pero deja el árbol idéntico— saldría como cambio
> observado: **STALE falso**. Un archivo tocado en un tramo y revertido en otro aparece en los
> dos. La única forma correcta es un diff de rango.

**La regla al consumir esa lista:** una lista incompleta solo puede ESCONDER archivos, nunca
inventarlos. Así que "encontré observados" sigue siendo de fiar aunque falten otros, y "no
encontré ninguno" **no dice nada**. Por eso `decidirFrescura()` da exit 2 —no PASS— con la lista
marcada incompleta y cero observados, y `severidad()` deja de emitir *"el runtime que corre es el
mismo que sí se testeó"*, que es la frase que el `on_fail` del canary traduce a "alcanza con
anotarlo". El truncado solo puede BAJAR ese conteo, o sea que solo podía empujar hacia la calma.

**Y lo que este truncado NO hace, porque la nota original decía que sí:** no produce hoy un PASS
falso en `backend-deploy-fresh`. Rompe la LISTA, no la conclusión. Para que `pendingBackend`
saliera vacío harían falta ≥300 archivos **excluidos** ordenando antes del primer observado.

Y eso **no es alcanzable por aritmética**, no por suerte. `railway.json` excluye cuatro cosas, y
de ellas `webapp/**` (las tres cuartas partes de los archivos excluidos) **ordena ÚLTIMO**: hoy no
hay ni un archivo del árbol que ordene después de `webapp/`, así que ninguno de sus archivos puede
preceder a un observado. Los excluidos que sí podrían son `docs/` + `qa-e2e/` + `*.md` de raíz, y
son **dos órdenes de magnitud menos que 300**, así que la cota cierra con muchísimo aire:

```bash
# recontarlo, en vez de creerle a un número escrito acá
git ls-files ':(glob)*.md' docs/ qa-e2e/ | wc -l    # ~126, contra el tope de 300
git ls-files | awk '$0 > "webapp/\xef\xbf\xbf"' | wc -l   # 0 = nada ordena después de webapp/
```

**El número exacto no va escrito a propósito.** La primera vez que se escribió decía 137, después
124, después 125, y ya son 126: crece con cada archivo que se agrega a `docs/` o `qa-e2e/`, o sea
que nace vencido en el mismo commit. Lo que hay que saber es la FORMA del argumento y el comando
para recomprobarlo.

Medido aparte, la posición real del primer observado sobre 120 bases consecutivas: **102 veces 0,
una vez 1, y 16 veces 2** (el peor caso es `2fc4dca`, con `CLAUDE.md` y `docs/DEFECTOS.md`
delante). El 0 tan frecuente lo explica `.claude/**`, que **está OBSERVADO** —no aparece en las
exclusiones— y ordena primero en bytes (`.` = 0x2E).

> Una versión anterior de esta nota decía "0 en todas, el primer observado cae en el índice 0
> siempre", medido sobre 40 bases tomadas cada 20 commits. Es falso: ese muestreo produce rangos
> largos que **siempre** tocan `.claude/`, o sea que no podía devolver otra cosa. Y cambiaba una
> demostración (la cota de 125) por una muestra sesgada. Lo que cierra el caso es la aritmética.

La cota hay que **re-derivarla** si cambia `railway.json` o si aparece un directorio que ordene
después de `webapp/`: no es un invariante, es una propiedad del árbol de hoy, y nada la vigila.

**Por qué hicieron falta tres, y por qué el segundo no alcanzaba.** `backend-deploy-tested` se
escribió creyendo que tapaba el fail-open, y tapa la mitad. Pregunta si el commit desplegado tuvo
suite verde, así que solo ve el bypass **que además salió rojo**. Si el gate se salta un commit y
la suite después sale verde, los tres testigos dicen PASS —`fresh` porque está desplegado,
`tested` porque la suite terminó verde, y `verify-railway-gate` porque el toggle nunca se apagó—
y el bypass no deja un solo rastro. El 06-ago se vio de casualidad: la suite estaba roja.

Mira el run de **`ci.yml`** del sha desplegado, no los check suites. Es a propósito: un commit
puede tener varios suites de github-actions —`bd9b77a` tiene dos, el push de CI y el "Backup DB"
agendado— y exigirlos todos verdes lo pondría rojo por un backup fallido, que no dice nada sobre
si el código pasó los tests. Un guard que grita por lo que no es se termina ignorando.

Distingue *nunca corrió* (el fail-open puro), *no pasó*, *todavía corriendo* (la ventana en vivo)
y **guard ciego** si alguien renombra `ci.yml` — un 404 saliendo como exit 2 lo mandaría al cajón
de "problemas de red" y el gate se quedaría sin testigo, que es la misma lección de
`validCheckSuites`. En veredicto malo imprime qué archivos observados por Railway llegaron sin
testear: es la diferencia entre anotarlo y arreglarlo ahora.

> **Un 404 dice que dio 404, no por qué, y hasta el 08-ago el mensaje elegía una de cuatro
> causas.** Medido: workflow inexistente, repo inexistente, repo privado sin acceso y owner
> inexistente dan un stderr **byte-idéntico** (`gh: Not Found (HTTP 404)`). Con
> `NETO_REPO=github/github` el harness decía "GUARD CIEGO: no existe el workflow ci.yml" y
> mandaba a revisar un archivo intacto. Ahora `diagnosticar404()` sondea `repos/{repo}` y
> `users/{owner}`: repo alcanzable → falta el workflow; owner 404 → `NETO_REPO` mal escrito;
> owner ok y repo 404 → **no se puede partir más**, porque GitHub devuelve 404 tanto para "no
> existe" como para "privado sin acceso", a propósito, para no filtrar la existencia de repos
> privados. El mensaje nombra las dos en vez de elegir. Los cuatro siguen siendo exit 1: el
> gate quedó sin testigo en todos, lo que cambia es a dónde apunta el hint.

**Baja un nivel más, hasta el job, y en las DOS ramas.** El mismo argumento que eligió `ci.yml`
sobre los check suites vale adentro de `ci.yml`: el run también corre `webapp`, `deploy-webapp`
(un `vercel deploy`) y `railway-gate`. Un token de Railway vencido o un deploy de Vercel caído
lo ponen rojo **sin decir nada sobre el backend**, y el harness mandaba a "arreglar la suite"
con la suite del backend verde. Por eso el veredicto *"EL RUN QUEDÓ ROJO, PERO NO POR LOS TESTS"*:
sigue siendo exit 1 —un commit desplegado con el run rojo es anómalo igual— pero apunta al job.

**El mismo argumento vale para el run VERDE, y ahí faltaba entero hasta el 08-ago.** La
conclusion de un run es un AGREGADO, y un job `skipped` la deja en `success`: `nlp-agent` lo
demuestra en cada run desde el 14-jul. El harness devolvía PASS sin consultar un solo job, así
que el día que `test` lleve un `if:` que evalúe false —un filtro por paths, un toggle de standby
como el del propio `nlp-agent`— el run sale verde, el harness dice PASS y **la suite del backend
no corrió**. Es el fail-open que este archivo existe para atrapar, un nivel más arriba.
Reproducido: con `NETO_CI_JOB_TESTS=job-que-no-existe` daba PASS.

Tres reglas al leer los jobs, y las tres se pagaron:

| regla | qué pasaba sin ella |
|---|---|
| `filter`, no `find` | con una matriz de varias patas `test`, verde la primera y roja la segunda daba "no fue culpa de los tests" **con `test: failure` en `jobsRojos` del mismo objeto** |
| `skipped` **no** es `success` para ESTE job (sí lo es para `jobsRojos`) | un job que no corrió contaba como backend sano |
| el nombre se compara EXACTO | mutar `===` a `startsWith` dejaba los 10 tests en verde; `test-e2e` pasaba por `test` |

Si el job `test` no aparece (lo renombraron), es **guard ciego**, mismo cajón que el 404 del
workflow. Si la lista de jobs no se puede leer, depende del color: con el run rojo cae en el
caso grave (el run rojo ya es la anomalía), con el run verde es exit 2, porque lo único que
falta es la comprobación. Una lista **truncada** cuenta como ilegible: con la pata roja de
una matriz fuera de la página saldría PASS con la suite roja.

**Y el triage cambió de oráculo con el veredicto.** `severidad()` —lo que decide entre
"anotalo" y "arreglalo ahora"— definía "último commit con CI verde" con `runs?status=success`,
o sea el mismo agregado que el resto del archivo declara no confiable: con `test` filtrado por
paths llegaba a imprimir *"el runtime que corre es el mismo que sí se testeó"* sobre commits
que nunca se testearon. Ahora baja al job de cada candidato, y distingue "no hay ancestro sano"
de "no pude verificar ninguno", que un blip de red convertía en la primera.

El ensamblado del veredicto vive en `veredicto()`, puro y con un `switch` exhaustivo cuyo
default es exit 2. Antes era una cascada de `if` en `main()` que **caía libre a PASS**, así que
un caso nuevo salía exit 0. Los dos guards que lo cubrían leían el código fuente buscando la
cadena `'PASS'`, y una revisión adversarial los evadió con comillas dobles.

**Corren en dos lados a propósito.** El canary de las 10am y el recordatorio post-push
(`~/.claude/hooks/post-git-push-reminders.mjs`). Post-push no agrega ruido: si el gate funcionó,
prod sigue en el commit viejo con su suite verde y da PASS; si falló abierto, prod ya saltó al
commit nuevo con la suite corriendo y sale exit 1 en minutos en vez de a la mañana siguiente.

**`qa-e2e/backend-deploy-gated.mjs`** (07-ago-2026) es el que responde la tercera pregunta.
Compara el **INICIO del build** contra el fin del run de `ci.yml`. Es exactamente el delator que
esta sección ya nombraba sin automatizar: *"push → inicio de build pasó de ~7 segundos a
~2m50s"*. Con el gate sano Railway deja el deployment en `WAITING` y **no construye** hasta que
el check suite termina, así que el inicio del build cae después por construcción.

> **La primera versión miraba el FIN y estaba mal.** `finDeploy − finSuite` es en realidad
> `duraciónBuild − duraciónSuite`, y acá el build tarda 140-185s contra 39-180s de suite: un
> deploy SIN gate termina después igual y salía *"esperó"*. Sobre el historial real del servicio
> detectaba el **16%** de los deploys sin gate, y **0%** en los dos días en que el gate
> demostrablemente no existía. Lo encontró una revisión adversarial el 07-ago, no la suite.

Las dos poblaciones, medidas sobre 12 deployments reales, no se solapan:

| | inicio del build vs fin de la suite |
|---|---|
| con gate (`b6e44e8`, `0c55f6b`, `89206ac`, `52241cd`) | **+5 a +6s** |
| sin gate (05-ago, antes del toggle: `a9c5bdf`, `3611f9b`, `9728433`, `0b697e0`, `87f3682`, `e92e2d8`) | **−44 a −159s** |
| `096593a`, el incidente | **−1068s** |

Cuatro cosas que conviene saber antes de tocarlo:

- **El inicio sale del timestamp más viejo de `buildLogs`.** NO de `createdAt` (Railway crea la
  fila apenas llega el push, incluso cuando va a quedarse en `WAITING`) ni de `updatedAt`, que
  es el fin. Si Railway ya purgó los logs, es exit 2, nunca PASS.
- **Solo puede juzgar el deployment VIGENTE.** Railway pisa `updatedAt` con la hora del
  reemplazo cuando pasa a `REMOVED`, así que un barrido histórico daría por bueno justo a
  `096593a`. Por eso corre seguido, no en batch.
- **La tolerancia (15s) vive entre las dos poblaciones** y hay un test que la mantiene ahí: si
  alguien la sube a 60s "por las dudas", los seis deploys sin gate pasan a verde.
- **Un margen de más de una hora es INDETERMINADO, no PASS.** Un redeploy o rollback desde el
  dashboard no consulta "Wait for CI" y es la vía humana más probable de saltearlo; sin cota
  salía PASS con margen de días.
- **"No hay run" no prueba "nunca hubo run", y hasta el 08-ago el detalle afirmaba lo segundo**
  ("se desplegó y NUNCA existió un run de CI"). Tres causas dejan el mismo rastro, cero runs y
  cero check suites, y solo una es un fail-open:

  | causa | estado |
  |---|---|
  | el sha es un **commit INTERMEDIO de un push en lote**: GitHub crea UN run por evento de push, con `head_sha` en la PUNTA | **medido y vivo acá**: `112734f` (mismo segundo que `89206ac`, que sí tiene run) y `373f82b` no tienen run ni check suite |
  | la retención de Actions borró el run y el deployment de Railway le sobrevivió | el mecanismo existe; **en este repo no hay una sola observación de que haya pasado** (ver abajo) |
  | el deploy salió sin gate de verdad | el caso del 06-ago |

  **Ninguna se separa automáticamente, así que el veredicto sigue siendo exit 1 y lo único que
  cambió es el texto.** Para la pregunta de este harness las tres dan lo mismo igual: si el sha
  desplegado no tiene run, Railway no tuvo ningún check suite que esperar.

  > **Se intentó descartar la retención con un dato y hubo que revertirlo. No lo reconstruyas.**
  > La idea era preguntar cuál es el run más viejo que todavía existe y ablandar a exit 2 los
  > builds anteriores. Medido: el run más viejo de `ci.yml` es del `2026-03-21T23:03:16Z` y el
  > commit que **crea** `ci.yml` (`48155ca`) es de las `22:50:09Z` del mismo día. Trece minutos.
  > No expiró ningún run: ese número era la fecha de nacimiento del workflow.
  >
  > "No hay runs anteriores a X" es igual de compatible con "la retención los borró" que con "el
  > workflow no existía", y las dos piden lo CONTRARIO: un build anterior al primer run de CI es
  > el fail-open más puro que hay, porque no había CI. Con un workflow nuevo o renombrado —lo que
  > el hint del harness hermano te manda a hacer— el horizonte cae a hace días, y con eso el
  > incidente del 06-ago salía exit 2 con un detalle afirmando una causa falsa. Para que la
  > retención sirva de explicación hace falta evidencia **independiente** de que se borraron runs.

  Ojo con una causa que la cola daba por buena y **no aplica**: "el sha llegó a main por PR".
  `ci.yml` corre con **los dos** triggers (`on: push: branches:[main]` **y**
  `pull_request: branches:[main]`; el segundo lleva 29 runs de 693), y lo que la descarta es el
  primero: mergear un PR genera un evento `push` sobre main, así que la punta tiene su run igual.
  Solo sería un problema si se quitara el trigger de `push`.

  > La primera versión de esta nota citaba solo la mitad del `on:` y apoyaba la conclusión en
  > "de los 100 runs más recientes, 100 son `event: push`". Ese número es real y no prueba nada:
  > es la distribución de los RUNS, y la afirmación es sobre las PUNTAS de main. Para eso hay que
  > muestrear puntas, no runs — y la ventana de 100 es una franja donde no cayó ningún PR.

El corazón es una función pura (`evaluarGate`) probada contra **los timestamps reales de las dos
poblaciones** (`tests/railway-gate-timing.test.js`), no contra números inventados. Si alguien
ablanda la regla, lo que se rompe son deploys que de verdad pasaron.

Necesita `RAILWAY_API_TOKEN` (el mismo del `.env` local y del secret de CI) y **falla con exit 1
si falta**: un guard que se vuelve no-op sin credencial es verde por vacuidad.

**Encontró un positivo real apenas se escribió.** `api.neto.pe` seguía en `096593a` —el commit del
incidente— con la suite en `failure` **14 horas** después (desplegado 06-ago 17:27Z, reemplazado
07-ago 07:24Z). El triage dijo que el único archivo observado sin testear era
`.github/workflows/ci.yml` (config de CI, no runtime), así que no hubo consecuencia; se resolvió
al desplegarse el push de ese mismo trabajo.

> **Esas 14 horas NO son la prueba de que `watchPatterns` deje a prod atrás**, aunque acá decía
> eso ("los tres commits siguientes fueron de docs"). La línea de tiempo real, reconstruida el
> 07-ago con `git log` y la API de Railway, dice otra cosa:
>
> | commit | qué tocó | por qué no reemplazó a `096593a` |
> |---|---|---|
> | `cf6029b` 17:57Z | `CLAUDE.md` | `watchPatterns` |
> | — | *13h 15m sin un solo push* | — |
> | `a213794` 07:12Z | `tests/codigos-seguros.test.js` | **el gate**, haciendo su trabajo (aserción rota a propósito) |
> | `352356f` 07:15Z | el revert | `watchPatterns` |
> | `112734f` 07:24Z | `tests/` | ninguno: **este sí desplegó** |
>
> O sea: fueron cuatro commits y **uno solo** era docs; dos tocaron rutas observadas, y a uno
> lo frenó el gate, que es lo contrario del punto que la frase quería hacer. Y 13 de las 14
> horas no hubo actividad. La propiedad de fondo sigue siendo cierta —**sin un push que toque
> algo observado, prod se queda en el commit sin gatear indefinidamente**— pero no se demuestra
> con este episodio. Un número real pegado a una causa inventada es la misma trampa que el "30
> horas" que esta sección tuvo antes.

**Salida de emergencia, si hace falta un hotfix del backend con Actions caído.** El gate falla
cerrado, así que un outage de GitHub (o un job que no consigue runner) deja el deployment en
`WAITING` para siempre. Pasó el 06-ago-2026, con Actions en outage mayor: `railway-gate` nunca
consiguió runner y se canceló a los 15 min, y `test` terminó todos sus pasos bien pero quedó
sin marcarse completo. Si eso ocurre y hay que desplegar igual: **apagar "Wait for CI" en
Railway, desplegar, y volver a prenderlo.** El guard se pone rojo mientras está apagado, que
es exactamente el ruido que se quiere — no lo silencies, es el recordatorio de volver a
prenderlo. No inventes un tercer camino (`railway up` desde local salta `watchPatterns`).

```bash
# el motivo real de un SKIPPED (requiere RAILWAY_API_TOKEN)
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"query{deployments(first:3,input:{projectId:\"e2aac0f3-c2ee-4347-892c-b36d8c76929e\",serviceId:\"1085b433-8f29-4487-9ce7-3a66b64ef244\",environmentId:\"1600a753-bc8c-492c-aca7-27fdac946747\"}){edges{node{status meta}}}}"}'
```
- Tests: vitest, backend en la raiz (`npm test`) + webapp (`npm --prefix webapp run test`). El
  numero exacto NO va escrito: decia 292 cuando ya eran cientos mas, y un conteo desactualizado
  en un CLAUDE.md es peor que ninguno — la siguiente sesion lo lee como verdad
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
15. Lectura de Gmail: UNA cuenta por usuario (ver abajo — cada cuenta cuesta un cupo)
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

### Conectar Gmail es la unica capability que exige Pro PAGADO

El trial entrega todo Pro menos una cosa: conectar Gmail. No es comercial, es de
inventario — cada conexion consume uno de los **100 cupos** de Google que tenemos
hasta la certificacion CASA, y un trial de 14 dias quemaba un cupo permanente.

Dos reglas, y las dos se pagaron:

- **El cupo se gasta al CANJEAR, no al generar el enlace.** `STATE_TTL_MS` son 7 dias
  (a proposito: el link post-pago se abre horas despues en el chat), asi que gatear
  la emision no gatea el canje. El gate que de verdad protege el cupo esta en
  `routes/public.js`, antes de `guardarTokens`, y revalida contra la fila fresca.
- **Ya no hay emisores exentos.** `activarPro` lo era: armaba el link DESPUES del
  UPDATE que lo hace pagado, con la fila en memoria todavia vieja, asi que un
  `esProPagado()` ahi le negaba el Gmail justo a quien acababa de pagar (por eso el
  gate tampoco vive dentro de `generarUrlAutorizacion`). Hoy manda el atajo al panel
  en vez de la URL de OAuth, y la excepcion murio con el flujo.

**El cupo NO se recupera.** Verificado en la consola de Google (03-ago-2026, proyecto
**En produccion**, no en modo prueba): el limite de usuarios de OAuth se cuenta sobre
*todo el ciclo de vida del proyecto* y "no se puede restablecer ni cambiar". Cuenta a
quien **alguna vez** otorgo permiso, no a quien lo tiene ahora. Marcador al cerrar
este trabajo: **5 de 100**.

### Conectar es WEB-ONLY: una sola puerta, y esa puerta es la webapp

Habia **seis** puertas repartidas en dos canales (`/conectar`, `/bancos`, los intents
`agregar_gmail` y `cambiar_gmail`, el paso 30 del onboarding y el mensaje post-pago de
`activarPro`). Cinco eran de WhatsApp. Se consolidaron en una: `routes/pro.js`, detras
de la sesion de la webapp.

Por que, y el dato que lo cerro: de 93 usuarios, **0 llegaron a fijar
`bancos_seleccionados`**. Los pasos 30 y 31 —menu numerado, parser de indices, dos
gates duplicados, dos rescates a paso 0— existian para producir un valor que en
produccion siempre fue `null`. El multiselect de la webapp produce el mismo `null`
mostrando los bancos ANTES de autorizar.

Y el motivo estructural: los pasos 30/31 guardaban el estado de una capability de pago
**en la DB entre dos mensajes**. El gate del comando quedaba atras cuando llegaba la
respuesta, asi que cada paso necesitaba su propio gate duplicado. Menos puertas es menos
sitios donde acordarse del gate, y con un cupo irrecuperable eso importa mas que el gate.

### Y UNA sola cuenta de Gmail por usuario

Misma economia: cada cuenta de Google **distinta** consume OTRO cupo de por vida. Permitir
varias dejaba a un usuario quemando N cupos permanentes por un solo pago de S/10, y cobrar
por cuenta conectada se descarto por no complicar el modelo (decision de Favio, 2026-08-03).

**El limite vive en `guardarTokens` (gmail.js) y NO mira el `modo`.** Antes dependia de que el
state dijera `'reemplazar'`; con `'inicial'` —el modo por defecto, el que manda la webapp— el
upsert dejaba viva la cuenta anterior. O sea que el limite no estaba en el servidor sino en que
la UI escondiera el boton, y bastaba con volver a llamar la API teniendo ya una cuenta para
acumular. Ahora toda conexion desactiva **y revoca en Google** las cuentas con otro email,
venga del modo que venga (incluido un enlace viejo, que vive 7 dias).

Dos sutilezas que cuestan caro re-descubrir:
- **Se salta la cuenta con el MISMO email.** Revocar ahi tumbaria el grant que Google acaba
  de emitir (es el mismo), rompiendo justo el caso de reconectar tras un `invalid_grant`. Y no
  hay cupo nuevo: ese usuario de Google ya estaba contado.
- **La revocacion va ANTES de escribir los tokens nuevos.** `revocarAccesoGmail` limpia los
  campos legacy de `usuarios` cuando revoca la ultima cuenta activa; correrla despues borraria
  la conexion recien hecha.

No existe modo `'agregar'` en ninguna lista blanca. Guard: `tests/gmail-una-cuenta.test.js`.

**Es una cuenta PARA SIEMPRE, no "una a la vez".** Reemplazar con un correo distinto tambien
gasta un cupo nuevo y permanente, asi que alguien podria reconectar con N correos y quemar N
cupos pagando uno. Decision de Favio (2026-08-03): un usuario, un correo, punto. Cambiar de
correo se resuelve por soporte, a mano. Ojo que esto es OTRA cosa que cambiar el correo con el
que entra a la app (Supabase Auth), que sigue libre.

**Las dos defensas, y por que hacen falta las dos:**

| Donde | Que hace | Que NO hace |
|---|---|---|
| `login_hint` en la emision (`routes/pro.js` → `generarUrlAutorizacion`) | Google preselecciona la cuenta ya vinculada | no la fuerza: el usuario puede cambiarla en la pantalla de Google |
| Rechazo en el canje (`routes/public.js`, antes de `guardarTokens`) | garantiza que nadie tenga dos, y revoca el grant sobrante en el acto | **no recupera el cupo** |

El orden importa entenderlo: **el cupo se gasta cuando el usuario aprueba en la pantalla de
Google**, o sea ANTES de que nuestro callback exista. Cuando podemos mirar que correo eligio,
ya se gasto. Por eso el `login_hint` es la unica defensa que evita la perdida y el rechazo del
canje es solo el que sostiene el invariante. Y por eso la UI no ofrece "cambiar de cuenta":
mandarlo a Google con otra cuenta ya cuesta el cupo, diga lo que diga el callback despues.

`emailGmailVinculado()` mira el **historial** (`gmail_cuentas` sin filtrar por `activa`): una
cuenta revocada ya gasto su cupo, asi que para "¿esto seria una cuenta nueva?" manda el pasado.

### "Conectada" y "sana" son DOS preguntas (migracion 058)

`activa = true` no significa que Neto este leyendo. Cuando Google revoca el refresh token la
fila queda activa igual, asi que la app afirmaba **"Gmail conectado ✓" mientras no leia un solo
correo** — y por eso el enlace de reconexion tenia que estar siempre visible, contradiciendo el
✓ que tenia encima. El unico rastro del estado roto vivia en `authErrorNotifiedAt`, un `Map` en
memoria que un redeploy borra.

| Columna | Significa |
|---|---|
| `activa = false` | desconexion **deliberada** (no-pagador, reemplazo, wipe). Revocada en Google. |
| `auth_error_at` set | sigue conectada en nuestros libros, pero Google dejo de aceptar el token. |

**No se colapsan en una sola.** Poner `activa = false` en el auth caido sacaria al usuario del
barrido y le haria perder el hilo a `emailGmailVinculado` / `login_hint`, que es lo unico que
protege el cupo al reconectar.

**El sello vive en `configurarClienteParaCuenta` (`gmail.js`), no en el barrido.** Es el unico
punto que sabe QUE fila fallo: mas arriba `leerCorreosBancarios` colapsa N cuentas en un flag y
`escanearGmailYRegistrar` devuelve `{authError:true}` pelado. Y asi marcan los **tres**
productores del error, no solo el barrido automatico — `/escanear` por WhatsApp y el barrido
historico del callback lo descartaban en silencio. El write es condicional a `is null`: la marca
es *cuando se rompio*, no el ultimo reintento. La limpia `guardarTokens`, en el mismo upsert.

Pendiente conocido, no cerrado: el throttle de la NOTIFICACION sigue en memoria y se sella
**antes** de enviar (`gmail-scanner.js:48` antes de `:57`), asi que un envio fallido quema la
ventana de 24h. Es cadencia de aviso, no estado; el estado ya no depende de eso.

| Que | Donde |
|---|---|
| Los cuatro estados de la UI | `webapp/src/lib/gmail-estado.ts` (`bloqueado\|sin-conectar\|sano\|caido`) — el estado **sano no lleva ninguna accion** |
| El banner de todo el dashboard | `components/dashboard/gmail-desconectado-banner.tsx`, alimentado por `/api/dashboard` (no por un fetch propio: eso resucita el fan-out) |
| E2E | `qa-e2e/qa-gmail-estado-reconexion.mjs` (siembra, verifica las dos superficies y limpia sin gastar cupo) |

| Que | Donde |
|---|---|
| La unica puerta | `routes/pro.js` → `GET /pro/gmail-auth-url?modo=` (`inicial\|reemplazar`) |
| La UI | `webapp/src/app/dashboard/pro/page.tsx` (`GmailConnect` + `BancosManager`) |
| A donde manda WhatsApp | `linkPanelPro()` en `lib/trial.js` |
| Los invariantes | `tests/gmail-oauth-gates.test.js` (**cero `generarUrlAutorizacion` en `handlers/`**) y `tests/gmail-una-cuenta.test.js` (una cuenta por usuario) |

**`linkPanelPro(usuario)` es la pieza que evita la regresion.** 43 de 93 usuarios son
WhatsApp-only (4 Pro pagados): mandarlos a `/dashboard/pro` los deposita en `/login`,
donde un "Continuar con Google" les crea una cuenta HUERFANA en vez de vincularse a su
numero. Por eso bifurca: panel si tiene `supabase_auth_id`, link de activacion firmado
(`lib/activacion.js`) si no. Lo usan `activarPro`, `/conectar`, `/bancos`, los intents y
el aviso de auth expirada.

Lo que **sigue** en WhatsApp: `/escanear` y el intent `escanear_gmail`. Leer no consume
cupo (opera sobre una conexion que ya existe) y no tiene superficie web. Su gate si es un
gate de verdad. En cambio el gate de `/conectar` y `/bancos` **cambio de rol**: ya no
protege nada (ahi no hay nada que emitir), **elige el copy** — a quien no paga se le debe
el pitch de Pro, no un link a una pantalla bloqueada.

Consecuencias, y son las que mandan al priorizar:
- El **gate de entrada es lo unico** que protege el inventario. Cada conexion es
  permanente: ~95 usuarios mas, para siempre, y despues CASA es obligatorio.
- **Revocar es higiene, no recuperacion.** Sirve para no seguir teniendo permiso de
  lectura sobre la bandeja de alguien que dejo de pagar, y para que el estado local
  no mienta. No devuelve cupos.
- La capability tiene **tres caras y las tres cobran igual**: conectar, elegir bancos
  (sin Gmail no lee nada) y **leer** — `services/gmail-scanner.js`, que es la mitad
  silenciosa: no tiene pantalla, y estaba gateada por plan.

| Pieza | Donde |
|---|---|
| Las puertas + el guard | `tests/gmail-oauth-gates.test.js` (conteo fijado por archivo) |
| El deeplink por identidad | `tests/lib/trial-link-panel-pro.test.js` |
| Revocacion | `revocarAccesoGmail()` en `gmail.js` + `checkGmailHuerfanos` |
| E2E | `qa-e2e/qa-gmail-pro-pagado.mjs` (muro/trial/pagado contra prod) · `qa-e2e/probe-bancos.mjs` (WhatsApp no emite) · `qa-e2e/qa-gmail-segundo-correo.mjs` (la rama 409, sin gastar cupo) |

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

## El número de teléfono dejó de ser la identidad (BSUID, ago-2026)

Meta arrancó el rollout de **WhatsApp Usernames**. El usuario que activa uno oculta su número:
`from` y `wa_id` dejan de venir en el webhook, y llega `from_user_id` — el **BSUID**, opaco y
distinto por cada negocio (`PE.1049206861029395`). Empezó el 01-ago con 4 mensajes, y el 08-ago
ya eran 6 de una sola persona en 13 minutos, escribiendo sin recibir nada.

**No se le puede responder, y no es config nuestra.** Medido contra la API el 08-ago: `recipient`
+ `recipient_type` (el payload exacto de la doc) da `#100` en v19.0, v23.0, v24.0 **y v25.0**, y
`to` con un BSUID lo rechaza por formato de teléfono. El dato que lo vuelve concluyente: un
parámetro inventado junto a un `to` válido devuelve **200 e ignorado**, o sea que Meta descarta lo
que no conoce — el `#100` no es "BSUID inválido" sino "no existe ese campo". El envío por BSUID no
está habilitado en nuestra WABA. El webhook (suscrito a `messages` v25.0) está sano.

**Lo que sí se pudo hacer, y la ventana se cierra sola.** Hoy el BSUID llega **junto** al número
(`contacts[0]` trae `wa_id` Y `user_id`). Mientras dure esa superposición se le aprende el BSUID a
cada usuario que escribe (migración **065**, `persistirBsuid` en `helpers/db-helpers.js`), y cuando
active un username será lo único que lo reconecte con su cuenta. **A quien no vuelva a escribir
antes de activarlo, lo perdemos.**

| Pieza | Dónde |
|---|---|
| Aprender el BSUID | `persistirBsuid()` — nunca borra (los call-sites fuera del webhook pasan `null`) y nunca rompe el flujo |
| Reconocer sin número | `buscarUsuarioPorBsuid()` + el bloque `if (!from)` de `handlers/webhook.js` |
| Registrar sin poder responder | `services/registro-silencioso.js` |
| E2E | `qa-e2e/qa-bsuid-username.mjs` (con control negativo) |

**No metas lógica de dinero en `registro-silencioso.js`.** Delega en `parsearRegistroManual` y
`guardarTransaccion` a propósito: es el único camino donde una divergencia de montos **no tendría
quien la delate**, porque al usuario no le llega ninguna respuesta que comparar.

Un mensaje que no es texto (imagen de Yape, audio) sigue cayendo al descarte: procesarlo exige
responder. Y un usuario **nuevo** que llegue ya con username es inalcanzable — sin número no hay
a quién responder ni historial al que asociarlo. Esa mitad depende de Meta.

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

## Antes de pushear algo que toque plata, plan o gates

Un subagente **sin memoria de mi intencion** revisa el diff antes del push. No es ceremonia:
cuando audito e implemento el mismo cambio, el punto ciego es compartido, y el historial lo
demuestra (los defectos de `docs/DEFECTOS.md` del 03 y 04 de agosto los encontro Favio o un
barrido posterior, nunca mi propia verificacion, que estaba verde).

Aplica a: `lib/trial.js` y sus consumidores, `services/referrals.js`, `lib/pro-payment.js`,
los gates (`intents-acceso.js`, chokepoint, `requireLectura`), los crons que empujan, `gmail.js`
y toda migracion. NO aplica a copy, docs ni cambios de UI sin logica de plan.

**El ARREGLO al hallazgo tambien se revisa.** El ciclo no es auditar → arreglar → verificar
→ push: es auditar → arreglar → verificar → **revisar el arreglo** → push. El 2026-08-04 se
pago caro: el revisor encontro que `registrarPagoAprobado` pisaba el monto acordado, escribi
el fix, verifique verde y pushee sin que nadie lo mirara. Una segunda revision sobre el codigo
YA DESPLEGADO encontro que ese fix era una version PEOR del mismo bug (preservaba el monto sin
mirar el `tipo_plan`, y el periodo lo elige el admin al aprobar: 12 meses concedidos, S/10
registrados — S/89 de sub-registro contra los S/5 de sobre-registro que venia a arreglar).
El diff de un fix escrito bajo la presion de un hallazgo es el que tiene menos ojos encima de
todo el trabajo, y toca justo la parte delicada. Si la primera revision encontro algo real en
las areas de arriba, el arreglo entra en una segunda vuelta.

El prompt del revisor, corto y adversarial: *"Aca esta el diff. Encontra las rutas que NO se
ejercitaron: la rama de error de cada await (¿el cliente lanza o devuelve el error?), el usuario
en el muro, el que no tiene WhatsApp, el proceso que muere sin cleanup. Si se movio o unifico
codigo, decime que EFECTOS LATERALES viajaron con el. No valides lo que ya esta probado."*

Todo defecto que aparezca —lo encuentre quien lo encuentre— se registra en `docs/DEFECTOS.md`
el mismo dia. La lista de verificacion completa vive en la memoria
`feedback_disciplina_de_verificacion`.

## Principios
- **Simplicidad:** Impacto minimo en el codigo
- **Causas raiz:** No soluciones temporales
- **Verificar:** Nunca marcar tarea como completa sin demostrar que funciona. Un test no vale
  hasta verlo fallar contra el commit anterior
