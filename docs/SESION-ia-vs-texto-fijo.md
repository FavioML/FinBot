# En qué intents Neto WhatsApp redacta con IA y en cuáles usa texto fijo

Decidido y aplicado el 2026-07-22. Este documento es el registro de la decisión, no una sesión
pendiente. Trabajar desde `C:\Vortik.dev\products\neto\app`.

---

## Regla vigente

**De los 17 caminos que pasaban por `redactarConNETO`, quedan 2.**

| Sigue con IA | Por qué |
|---|---|
| `chiste_finanzas` (social.js) | No hay dato que formatear y un chiste fijo se quema al segundo uso |
| `consulta_financiera` (utilidades.js) | Pregunta abierta, el handler no tiene nada precalculado |

Los otros 15 responden con texto armado en código. El criterio que decidió cada caso:

> La IA se justifica cuando la respuesta NO es derivable del dato que el handler ya calculó.

En 15 de 17 sí era derivable. El contexto que se le mandaba al modelo ya traía el total, el
desglose, la diferencia y el porcentaje: el modelo solo reformateaba datos exactos, y en ese
trabajo perdía formato, perdía orden y a veces inventaba. 1.4s y tokens por reformatear peor.

**Si agregas un intent nuevo, el default es texto fijo.** Meterlo por IA hay que justificarlo
contra esa regla.

## Contexto: Neto usa IA en dos lugares distintos

```
Usuario: "gasté 40 en el mercado"
      ↓
 [IA #1: clasificación NLP]  elige entre 83 intents. Fuera del alcance de esta decisión.
      ↓
 handler ejecuta (guarda en Supabase)
      ↓
 [respuesta]  81 de 83 intents la arman con código
              2 de 83 la mandan a redactar (redactarConNETO)
```

Registrar gastos e ingresos, deudas, metas, reportes, score y espacios nunca pasaron por IA #2.

## Qué se cambió, caso por caso

**Texto fijo tal cual estaba (6):** `ayuda`, `agradecimiento`, `como_empezar`,
`listar_gastos_mes`, `ver_presupuesto`, `ver_ingresos`.

**Texto fijo con el bug corregido (4):**
- `saludo`: se le quitó el "¿Que revisamos?" del final (contradecía la regla de no preguntar).
- `ver_total_gastado`: decía "esta mes"; ahora "este mes" / "esta semana" según el periodo.
- `corregir_categoria`: decía "Díme"; además ahora nombra el gasto ("¿A qué categoría muevo
  *Rappi* (S/ 48.90)?"). Con IA respondía "Listo" sin haber hecho nada y afirmaba que el gasto
  no estaba categorizado, dato que nunca estuvo en el contexto.
- `queja`: decía "Déjame revisar" y con IA prometía "voy a verificar los registros de ayer".
  Nadie revisa nada. Ahora da el canal real de soporte sin prometer una acción que no ocurre.

**Texto fijo enriquecido (4)** — el handler ya calculaba estos datos y solo llegaban a la IA:
- `listar_gastos_semana`: + comparativa contra la semana pasada, + cuál fue el mayor gasto.
- `listar_gastos_dia`: + la lista movimiento a movimiento (antes solo el agregado por categoría).
- `ver_balance`: + "Llevas gastado el N% de tus ingresos".
- `comparar_meses`: + desglose por categoría (antes obligaba a restar de memoria los dos totales).

**Fallback de intent desconocido (message-processor.js):** ya no dice "no entendí" cuando sí
entendió. Acota el alcance y da ejemplos copiables. Cierra de paso la muletilla "aquí estoy".

## `consulta_financiera` corre en gpt-4o, no en el mini

El único intent donde una respuesta equivocada es información financiera falsa para el usuario.
Con `gpt-4o-mini` (medido 2026-07-22, 4 preguntas):

- "la CTS se paga en julio y diciembre" → es mayo y noviembre
- "verifica con tu AFP o la ONP para conocer más sobre tu CTS" → la CTS está en un banco
- "con la AFP acumulas CTS y gratificaciones" → no tienen relación
- "la gratificación aporta a tu CTS y AFP" → la gratificación no aporta a AFP

Con `gpt-4o` las cuatro salen correctas, y encima responde más rápido (1.5-2s vs hasta 9s del
mini). El volumen del intent es bajo, así que el costo extra es marginal. `redactarConNETO`
acepta `opciones.model` para esto; el default sigue siendo `gpt-4o-mini`.

El contexto del intent además prohíbe cálculos y montos: lo que falla no es la definición del
concepto sino derivar cifras ("si tu sueldo es S/1000, recibirías S/1000 al año"). Los
porcentajes fijados por ley (el 95.5% de retiro AFP) sí se permiten porque son correctos.

## Cómo verificar

```bash
npx vitest run                        # 356 tests
node qa-e2e/probe-system-prompt.mjs   # 16 checks contra el pipeline real
node qa-e2e/qa-tono-neto.mjs          # linter de tono de los 2 intents con IA (colgado del canary)
node qa-e2e/qa-handler-directo.mjs    # despacha cada intent y muestra la respuesta exacta
node qa-e2e/qa-lado-a-lado.mjs        # IA vs texto fijo, para re-decidir un caso
```

Regla de la casa: nada se da por cerrado sin correr una de estas contra el pipeline real.

**`qa-handler-directo.mjs` es el que conviene usar para verificar un cambio de texto.** Salta la
clasificación NLP: con frases cortas el NLP manda "cuanto gaste este mes" a `ver_total_gastado`
o "como va mi presupuesto" a `ver_balance`, y eso hace imposible verificar el texto de un
handler concreto. Si necesitas el pipeline completo, `qa-respuestas-finales.mjs` lo corre, pero
sus resultados dependen de cómo clasifique el NLP ese día.

## Gotchas encontrados verificando esto

- **`guardarMensaje(..., 'neto', respuesta)` vive en `webhook.js`, no en `procesarMensajeLibre`.**
  Un harness que llame a `procesarMensajeLibre` directo y no lo replique deja el historial con N
  turnos seguidos del usuario, y el NLP empieza a clasificar el mensaje anterior en vez del
  actual. Parece un bug de producción y no lo es.
- **El snapshot de `deshacer_ultimo` no se está guardando.** El handler inserta en
  `transacciones_eliminadas` con `.then().catch()` y sigue de largo, luego promete "escribe
  restaura y lo devuelvo". Al probarlo la fila no quedó guardada: la promesa es falsa. Pendiente.
- Los `\b` en la regla `miente-correos` del linter de tono no son decorativos: sin ellos
  "empleo" matchea "leo" y cualquier respuesta que diga "si pierdes tu empleo" se reporta como
  que NETO afirma leer los correos del usuario.

## Datos para dimensionar

- 74 usuarios reales, 68 sin correo conectado (92%).
- ~23 mensajes de Neto por semana, 6 usuarios activos. Esperar tráfico orgánico para validar NO
  funciona: hay que generar la muestra con los harness.
- `conversaciones` se auto-purga a los últimos 10 turnos por usuario.
- Usuario QA: `ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172` (`qa-test-dashboard`, `is_test_user=true`, sin Gmail).
- Deploy: push a main → Railway auto. Verificar con `curl -s https://api.neto.pe/health` y buscar
  `System prompt maestro cargado` en los logs del deployment.

## Convenciones

- Backend CommonJS, editar con Edit tool, UTF-8 sin BOM.
- Commit + push directo, mensajes en inglés con prefijo.
- El system prompt vive SOLO en `prompts/NETO_system_prompt.txt`, cargado por `lib/neto-prompt.js`
  (estaba en `docs/` cuando se escribió esto; se movió el 04-sep-2026 porque `railway.json`
  excluye `docs/**` y editarlo no redesplegaba)
  (falla al arranque si no está). No duplicarlo.

## Historia (por qué esto existía)

- **26-mar** (`ece5096`) audit de chattiness: se eliminan coletillas y se cambia la instrucción
  de la IA a "Sé directo y breve. NO hagas preguntas al final". Esa decisión sigue vigente.
- **31-mar** (`7941cb0`) un cleanup mueve el .txt a `docs/`; el código lo seguía buscando en la
  raíz. Se rompe la carga del system prompt (ENOENT tragado por un catch que solo logueaba).
- **03-abr** (`82c90ec`) una auditoría agrega `timeout: 30000` al body de la llamada a OpenAI.
  Ese parámetro no existe en el API: 400. `redactarConNETO` devuelve null SIEMPRE y cada
  respuesta cae al texto fijo del handler. Así estuvo 3 meses y medio.
- **21-jul** se arreglan los tres (`1a5da6e`, `6b677cf`, `ccdf713`). La IA revive de golpe en
  los 17 caminos, sin curaduría.
- **22-jul** se decide caso por caso con IA y texto fijo lado a lado. Resultado: este documento.

Consecuencia útil de ese accidente: el texto fijo que los usuarios vinieron leyendo esos meses
es la versión que Favio depuró el 26-mar. No es texto malo, es texto curado, y por eso volver a
él no fue una regresión.
