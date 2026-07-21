# Sesión: decidir en qué intents Neto WhatsApp redacta con IA y en cuáles usa texto fijo

Prompt de arranque autocontenido. Trabajar desde `C:\Vortik.dev\products\neto\app`.

---

## Objetivo

Neto de WhatsApp sirve para registrar bien gastos e ingresos y ejecutar sus funciones
(presupuestos, metas, deudas, reportes, correcciones), sincronizado con la webapp. NO debe volver
a ser lo que era al inicio: un bot que abruma al usuario con preguntas y mensajes innecesarios.

Ese criterio manda sobre cualquier decisión de esta sesión.

## Lo primero que hay que tener claro: Neto usa IA en dos lugares distintos

```
Usuario: "gasté 40 en el mercado"
      ↓
 [IA #1: clasificación NLP]  elige entre 83 intents. NUNCA falló. No se toca en esta sesión.
      ↓
 handler ejecuta (guarda en Supabase)
      ↓
 [respuesta]  67 de 83 intents la arman con código (texto fijo)
              16 de 83 la mandan a redactar a la IA #2 (redactarConNETO)
```

Registrar gastos e ingresos, deudas, metas, reportes, score y espacios NO pasan por la IA #2.
Esta sesión toca únicamente los 16 caminos que sí.

## Qué pasó (línea de tiempo verificada en git)

- **17-mar** se escribe el código que carga el system prompt. El .txt estaba en la raíz. Funcionaba.
- **26-mar** (`ece5096`) Favio hace el audit de chattiness: elimina coletillas ("¿Algo está mal?",
  "¿Hay otro?") y cambia la instrucción de la IA de "Termina con pregunta o accion concreta" a
  "Sé directo y breve. NO hagas preguntas al final". **Funcionó: esa es la decisión vigente.**
- **31-mar** (`7941cb0`) un cleanup de repo mueve el .txt a `docs/`. El código lo seguía buscando en
  la raíz. Se rompe la carga del system prompt (ENOENT tragado por un catch que solo logueaba).
- **03-abr** (`82c90ec`) una auditoría CTO agrega `timeout: 30000` al body de la llamada a OpenAI.
  Ese parámetro no existe en el API: 400. **`redactarConNETO` devuelve null SIEMPRE** y cada
  respuesta cae al texto fijo del handler. Así estuvo 3 meses y medio.
- **21-jul** se arreglan los tres (`1a5da6e`, `6b677cf`) y se alinea el prompt a la decisión de
  no-conversar (`ccdf713`). La IA #2 revive de golpe en los 16 caminos, sin curaduría.

Consecuencia importante: **el texto fijo que los usuarios vinieron leyendo estos meses es la versión
que Favio depuró el 26-mar**. No es texto malo, es texto curado.

## Estado medido (no estimado)

`node qa-e2e/qa-ia-vs-fijo.mjs 3`, cada respuesta generada contra el texto fijo exacto de antes:

- **Largo: 2.3x las palabras del texto fijo** (rango 1.3x–4.1x). Peor caso: "gracias crack" pasó de
  8 palabras a 33.
- **Latencia: +1.2s de media, 1.9s peor caso.**
- **Precisión: 0 montos inventados en 33 generaciones.** La fidelidad numérica no es el problema.
- Tono: 12/13 limpio en `qa-tono-neto.mjs`, sin preguntas de relleno. El fallo restante es una
  muletilla de despedida ("aquí estoy") en la respuesta a mensajes fuera de ámbito.

## La decisión: 16 caminos, uno por uno

Recomendación de partida, a validar con Favio caso por caso mostrándole IA y texto fijo lado a lado:

**Dejar con IA (9)** — hay un número que interpretar o una proyección que hacer:

| Archivo | Intent |
|---|---|
| `handlers/intents/gastos.js` | listar_gastos_mes, listar_gastos_semana, listar_gastos_dia, ver_total_gastado |
| `handlers/intents/presupuestos.js` | ver_presupuesto, ver_balance |
| `handlers/intents/utilidades.js` | comparar_meses, consulta_financiera |
| `handlers/intents/analytics.js` | ver_ingresos |

**Volver a texto fijo (6)** — solo hay que responder y seguir; la IA cuesta 1.2s y triplica el largo:

| Archivo | Intent |
|---|---|
| `handlers/intents/social.js` | saludo, ayuda, agradecimiento, queja, chiste_finanzas, como_empezar |

**A decidir con el texto delante (2)**: `corregir_categoria` (transacciones.js) y el fallback de
intent desconocido (`message-processor.js`).

## Trabajo

1. Para cada uno de los 16, mostrar a Favio la respuesta de IA y el texto fijo lado a lado, y que
   decida. `qa-ia-vs-fijo.mjs` ya imprime ambos. No decidir por él donde haya criterio de producto.
2. Implementar la decisión. Donde se apague la IA, el handler ya tiene su texto fijo escrito
   (es el `|| '...'` después del `await redactarConNETO(...)`), así que suele ser borrar la llamada.
3. Cerrar la muletilla residual del caso fuera de ámbito.
4. Colgar `qa-tono-neto.mjs` del canary diario (10am Lima, ver `.claude/deploy-config.json`).

**NO es bloqueante** pulir los textos fijos que se queden. Varios violan reglas cosméticas del
prompt ("Entendido. Déjame revisar", "Aquí andamos cuidando tu bolsillo"), pero son los que Favio
depuró y llevan meses funcionando bien. Se pueden pulir después, con calma, o dejarlos.

## Cómo verificar

```bash
npx vitest run                        # 336 tests
node qa-e2e/probe-system-prompt.mjs   # 16 checks contra el pipeline real
node qa-e2e/qa-tono-neto.mjs          # linter de reglas duras de tono
node qa-e2e/qa-ia-vs-fijo.mjs 3       # largo vs texto fijo, latencia, cifras inventadas
```

Regla de la casa: nada se da por cerrado sin correr una de estas contra el pipeline real.

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
- El system prompt vive SOLO en `docs/NETO_system_prompt.txt`, cargado por `lib/neto-prompt.js`
  (falla al arranque si no está). No duplicarlo.
