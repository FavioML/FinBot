# Sesión: auditar los fallos silenciosos que quedan en el backend de Neto

Prompt de arranque autocontenido. Trabajar desde `C:\Vortik.dev\products\neto\app`.

---

## Por qué existe esta sesión

El 21-jul-2026 se encontraron dos bugs que llevaban **3 meses y medio en producción sin que nadie
los notara**, y los dos se escondieron por el mismo motivo: un `catch` que solo logueaba (o ni eso)
con un fallback aguas arriba que hacía que todo pareciera normal.

1. `handlers/message-processor.js` leía el system prompt de una ruta inexistente. El ENOENT caía en
   `catch(e) { log.error(...) }` y seguía con un fallback de una línea. Commit `1a5da6e`.
2. `services/neto-gpt.js` mandaba `timeout` dentro del body de OpenAI → 400 en el 100% de las
   llamadas. `redactarConNETO` devolvía `null` y cada handler caía a su texto fijo. Commit `6b677cf`.

Ninguno de los dos disparó una alerta. El bot respondía, los tests pasaban, el health estaba en 200.

**Esta sesión busca los demás.** El patrón ya está identificado; falta barrer el resto del backend.

## Lo que ya está verificado (no repetir)

- `timeout` dentro del body: barrido completo hecho. Hay 12 llamadas a OpenAI en el repo
  (`webhook.js` x3, `message-processor.js`, `score.js`, `summaries.js`, `spending-alerts.js`,
  `recommendations.js`, `parsers.js` x3, `tests/nlp/agent.js`). **Ninguna otra tenía el problema.**
- `redactarConNETO` tiene 17 call sites y ahora está cubierto por `tests/services/neto-gpt.test.js`,
  que falla si `timeout` vuelve al body.
- **`services/summaries.js`, los 3 `catch` silenciosos (21-jul-2026): los tres estaban SANOS.**
  Verificado corriendo `generarResumenSemanal` real contra usuarios de producción y ejecutando
  los cuerpos de los bloques con las condiciones forzadas (deuda dentro de la ventana `[-3,+7]`,
  semana a la baja). Los tres renderizan.
  El hallazgo fue otro: **esos `catch` son inalcanzables**. `supabase-js` no lanza nunca — ni con
  columna inexistente ni con fallo de red total devuelve otra cosa que `{ data: null, error }` — y
  `calcularRitmoAhorro` es aritmética pura (probado con 4 entradas degeneradas). El fallo silencioso
  real vivía un nivel más abajo: el `error` descartado en el destructuring. Si esa query fallaba,
  la sección desaparecía del mensaje sin catch y sin log. Corregido: todas las queries de
  `generarResumenSemanal` capturan `error` y loguean con tag `RESUMEN_SEM`, y `obtenerDeudas`
  (que se comía su propio error en 10+ call sites) loguea con tag `DEUDAS`.
  **Moraleja para el resto del barrido: un `catch` vacío sobre una query de Supabase no es el bug;
  el bug es el `error` que nadie lee. Buscar `const { data } = await supabase`, no solo `catch`.**

## Fallo silencioso mayor encontrado de paso (ya corregido)

Los dos crons de resumen (`cron/checks.js`) filtraban
`plan = 'premium' AND gmail_access_token IS NOT NULL`. El resumen se arma con transacciones,
presupuestos, metas y deudas: no toca Gmail. Ese filtro dejaba en **3 de 77 usuarios** (4 de los 7
Pro quedaban fuera solo por no tener Gmail conectado) y era invisible: el cron corría, no fallaba,
simplemente no encontraba a nadie. Ninguno de esos 3 tenía metas activas, así que los bloques de
metas nunca habían renderizado por la ruta cron en producción — solo por `/semana` y `/resumen`.
Cubierto por `tests/cron/resumen-destinatarios.test.js`.

Relacionado y **sin resolver**: `manos_libres = true` da **0 usuarios**, o sea que
`generarResumenDiario` no se ejecuta para nadie. Eso es producto, no robustez; va a la sesión de
`SESION-ia-vs-texto-fijo.md`.

## Bug vivo encontrado con el método corregido (22-jul-2026, commit 8843f8b)

Cambiando el grep de `catch` a `const { data } = await supabase` salieron **186 sitios en backend**.
Barriendo la clase peligrosa (lectura falla → el código cree que no existe → escribe igual) apareció
un duplicado real de transacciones, aunque por otra causa: `services/transactions.js` saltaba el
dedup por hash para todo lo que entra por Gmail (`if (!datos.esGmail)`), confiando solo en el índice
único de `gmail_msg_id`. Cuando el banco manda **dos correos distintos para el mismo cargo**, cada
uno trae su id, el índice no los ve como duplicados y entran los dos. Pasó el 20-jul: Smart Fit
S/119.90 dos veces, correos a 1 segundo.

Un SELECT-antes-de-INSERT no arregla esto: el sweep parsea 5 correos en paralelo (`CONCURRENCIA_SWEEP`),
así que los dos duplicados consultan antes de que cualquiera inserte. El guard es un Map en memoria
(check y marca sin `await` en medio = atómico en Node, y el backend es instancia única), y discrimina
por **hora de llegada del correo** (`internalDate`, ahora propagado como `recibidoEnMs`), no por hora
de proceso. Solo en escaneo incremental: en el barrido histórico dos compras legítimas del mismo día
se procesan juntas y colapsarían mal.

**Lección sobre medir antes de borrar.** El primer conteo dio "24 filas duplicadas, S/1386 inflados".
Era el techo, no el dato: asumía que todo choque de `dedup_hash` es un duplicado. Al mirar fila por
fila, varias eran reales (dos viajes de bus de S/2 con 3.7h de diferencia; varios cargos de ITF de
S/0.20 el mismo día). El piso demostrable resultó ser **4 filas, S/48**: el único caso donde el mismo
correo de Gmail entró más de una vez. Las otras 16 quedaron intactas.
- **`descripcion_original` NO es un ID único salvo cuando el origen es Gmail.** En entrada manual
  guarda el texto del mensaje ("Bus 2 soles") y en Yape el asunto ("¡Yapeaste!"), que se repite en
  todos los correos de Yape. Agrupar por esa columna sin filtrar por formato de msg id (hex de 16)
  mezcla duplicados con compras reales.
- **Editar el monto no recalcula `dedup_hash`.** Por eso hay filas con el mismo hash y montos
  distintos (Bar Refugio: S/15 corregido a mano + 4 copias de S/12 sin tocar).

## Continuación (22-jul-2026)

Este doc queda como registro de lo verificado. El trabajo restante se partió en dos sesiones
independientes, en orden de valor esperado:

1. `docs/SESION-escrituras-sobre-lectura-fallida.md` — la clase que sí rinde: lecturas fallidas que
   producen escrituras (referrals, pagos Pro, balances de espacios, score).
2. ~~`docs/SESION-barrido-candidatos-restantes.md`~~ — **CERRADA el 22-jul-2026** (commit `e183494`).
   Rindió más de lo esperado: 3 archivos sanos y 1 bug vivo de 4 meses. Detalle abajo.

## Candidatos concretos a revisar

Salieron del grep de catch en los servicios que llaman a OpenAI. Están sin verificar: pueden estar
sanos o pueden estar fallando en silencio desde hace meses, igual que los dos anteriores.

**Lista cerrada el 22-jul-2026** (commit `e183494`). Resultado: 1 bug vivo de 4 archivos.

| Archivo | Qué hay | Veredicto |
|---|---|---|
| ~~`services/summaries.js`~~ | ~~3 x `catch (e) { /* silent */ }`~~ | **SANO** 21-jul, ver arriba |
| `services/recommendations.js` | `catch → return null` en ~318, ~374; otros catch en ~246, ~488 | **BUG VIVO**, ver abajo |
| `services/parsers.js` | `catch → return []` en ~375; `catch → return { es_presupuesto: false }` en ~384 | **SANO** |
| `handlers/intents/score.js` | catch en ~101 alrededor de la generación de tips con IA | **SANO** |
| `services/spending-alerts.js` | catch en ~177 | **SANO** |

### Segundo bug de prompt movido: `generarRecomendaciones` (22-jul-2026, commit `e183494`)

`services/recommendations.js` leía el prompt desde `prompts/`, directorio que dejó de existir en
`7941cb0` (31-mar-2026: el archivo se movió a `docs/` y la ruta del código no se actualizó). El
ENOENT caía en `catch → return null`, y los dos call sites tenían fallback: `ver_recomendaciones`
servía la mini-recomendación heurística y el resumen mensual simplemente omitía el bloque.
**`generarRecomendaciones` devolvió `null` en el 100% de las llamadas durante ~4 meses.**

Es el tercer caso de la misma familia (`1a5da6e` system prompt, `6b677cf` timeout en el body): una
dependencia que falla siempre, tapada por un fallback que se ve razonable.

Lo que costó: "Consejos IA personalizados" se vende como feature Pro y está detrás del paywall
(`consejoPerWeek === 0` → mensaje de upsell). Los usuarios Pro pagaban por una ruta de código que
nunca corrió.

**Cómo se demostró:** `generarRecomendaciones(uid, 'Favio', 'on_demand_general')` llamada directo
contra un usuario de producción con 98 transacciones de julio. Antes: `null` + log
`ENOENT ... app\prompts\NETO_recomendaciones_prompt.md`. Después: recomendación redactada real.
Fix con la doctrina de `lib/neto-prompt.js` (leer una vez al require, lanzar si falta o si perdió
un placeholder). Cubierto por `tests/services/recommendations-prompt.test.js`, que valida la
**clase**: todo prompt que el backend lee tiene que existir donde el código lo busca.

### El agujero que `eea8d1c` dejó abierto: `construirDatosUsuario`

Las 5 queries paralelas de `construirDatosUsuario` descartaban su `error`. Ese objeto alimenta el
**45% del Neto Score** (`calcFactorBudget` 0.25 + `calcFactorSavings` 0.20), la viabilidad de metas
(`analizarViabilidad`) y las alertas de fugas. `eea8d1c` blindó los factores que hacen su propia
query, pero budget y savings leen de acá.

Magnitud medida sobre un usuario sano (dentro de presupuesto, ahorrando >20%):

| Lectura que cae | Efecto |
|---|---|
| `presupuestos` | factor budget 100 → 50 (el "neutral" de *no tiene presupuestos*) = **-12.5 pts** |
| `ingresos` | factor savings 100 → 50 = **-12.5 pts** |
| `gastos` | factor savings **sube a 100** y `analizarViabilidad` declara "alcanzable 💪" una cuota que no lo es |

El tercero es el peligroso: **falla hacia arriba**. Nadie reporta que su score subió. Corregido con
la misma doctrina (log con tag `RECOM_DATOS` + throw; `upsertScore` ya devuelve `null` y no persiste).

**Moraleja acumulada del barrido:** los 4 candidatos elegidos por su `catch` salieron sanos salvo
uno, y el `catch` no era el problema en ninguno. Los dos hallazgos reales fueron una **ruta de
archivo** y un **`error` descartado**. Grepear `catch` sigue siendo el peor filtro disponible.

## Método sugerido

Para cada candidato, la pregunta que destapó los dos bugs anteriores:
**"¿qué pasa si esto falla SIEMPRE? ¿se notaría?"** Si la respuesta es "no", hay que probarlo.

1. Llamar la función directamente con datos reales (patrón: `node -e "require('dotenv/config'); ..."`),
   no a través del flujo, para ver si devuelve el valor bueno o el fallback.
2. Donde el fallback sea legítimo, subir el log a nivel error con tag propio para que sea visible.
3. Donde el asset o la dependencia sea obligatoria, fallar ruidosamente (ver `lib/neto-prompt.js`
   como referencia: lanza al require y el proceso no arranca).
4. Test de regresión por cada fallo encontrado.

## Cómo verificar

```bash
npx vitest run                        # 336 tests
node qa-e2e/probe-system-prompt.mjs   # 16 checks contra el pipeline real
```

Los probes de `qa-e2e/` montan el `app` de `index.js` completo con Supabase y OpenAI reales,
stubeando solo el envío de WhatsApp. Ver `probe-ratelimit-ipv6.mjs` como patrón.

También sirve revisar los logs de producción por tags de error en Railway (proyecto
`peaceful-stillness`, servicio `Neto.pe`): un tag que nunca aparece puede significar que todo va
bien, o que el código que lo emite nunca se ejecuta.

## Relación con la otra sesión pendiente

`docs/SESION-ia-vs-texto-fijo.md` decide en qué intents Neto redacta con IA. **Son independientes**:
esa es de producto y UX, esta es de robustez. No comparten archivos salvo `services/neto-gpt.js`,
que en esta sesión ya no se toca. Se pueden hacer en cualquier orden.

## Convenciones

- Backend CommonJS, editar con Edit tool, UTF-8 sin BOM.
- Commit + push directo, mensajes en inglés con prefijo.
- Nunca correr tests contra la DB real: mockear Supabase (ver `tests/setup.js`, que ya expone
  `globalThis.__mockOpenAICreate` sobre la instancia compartida de `lib/ai.js`).
