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

## Candidatos concretos a revisar

Salieron del grep de catch en los servicios que llaman a OpenAI. Están sin verificar: pueden estar
sanos o pueden estar fallando en silencio desde hace meses, igual que los dos anteriores.

| Archivo | Qué hay |
|---|---|
| ~~`services/summaries.js`~~ | ~~3 x `catch (e) { /* silent */ }`~~ **HECHO 21-jul-2026, ver arriba.** |
| `services/recommendations.js` | `catch → return null` en ~318, ~374; otros catch en ~246, ~488 |
| `services/parsers.js` | `catch → return []` en ~375; `catch → return { es_presupuesto: false }` en ~384 |
| `handlers/intents/score.js` | catch en ~101 alrededor de la generación de tips con IA |
| `services/spending-alerts.js` | catch en ~177 |

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
