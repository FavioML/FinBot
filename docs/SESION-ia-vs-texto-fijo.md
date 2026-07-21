# Sesión: decidir dónde Neto WhatsApp usa IA y dónde texto fijo

Prompt de arranque autocontenido. Pegar en una sesión nueva desde `C:\Vortik.dev\products\neto\app`.

---

## Objetivo

Neto de WhatsApp sirve para registrar bien gastos e ingresos y ejecutar las funciones que tiene
(presupuestos, metas, deudas, reportes, correcciones), sincronizado con la webapp. NO debe volver
a ser lo que era al inicio: un bot que abruma al usuario con preguntas y mensajes innecesarios.

Ese es el criterio que manda cualquier decisión de esta sesión.

## Contexto: qué pasó el 2026-07-21 y por qué hace falta esta sesión

Durante meses la redacción con IA de Neto estuvo **muerta al 100%** y nadie lo notó. Tres bugs
encadenados, ya arreglados y desplegados:

1. `handlers/message-processor.js` leía el system prompt desde `handlers/` (ruta inexistente, el
   archivo vive en `docs/NETO_system_prompt.txt`). El ENOENT caía en un catch que solo logueaba y
   seguía con un fallback de una línea. Commit `1a5da6e`.
2. `services/neto-gpt.js` mandaba `timeout: 30000` DENTRO del body de `chat.completions.create`.
   El SDK v6 lo reenvía y el endpoint responde 400. `redactarConNETO` devolvía `null` siempre, así
   que **cada respuesta que veía el usuario era el texto fijo hardcodeado de su handler**. Commit `6b677cf`.
3. El prompt afirmaba sin condición "Lees automáticamente los correos de BCP, Interbank..." cuando
   68 de 74 usuarios reales no tienen correo conectado. Ahora es condicional al Gmail real. Commit `6b677cf`.
4. El pilar 2 del prompt pedía cerrar cada respuesta con una pregunta, contradiciendo al wrapper.
   Alineado a la decisión vigente (Neto confirma, no conversa). Commit `ccdf713`.

**Consecuencia:** desde el 21-jul la IA redacta de verdad, en los 17 puntos donde se la llama, de
golpe. Eso trajo una regresión de UX medida.

## Estado actual, medido (no estimado)

Con `node qa-e2e/qa-ia-vs-fijo.mjs 3`, comparando cada respuesta generada contra el texto fijo
exacto que producción servía antes:

- **Largo: 2.3x las palabras del texto fijo** (rango 1.3x–4.1x). El peor caso es "gracias crack",
  que pasó de 8 palabras a 33.
- **Latencia: +1.2s de media, 1.9s peor caso.** Antes el 400 caía al texto fijo casi al instante.
- **Precisión: 0 montos inventados en 33 generaciones.** La fidelidad numérica NO es el problema.
- Tono: 12/13 limpio en `qa-tono-neto.mjs`. Ya no hay preguntas de relleno. El fallo restante es una
  muletilla de despedida ("aquí estoy") en la respuesta a mensajes fuera de ámbito.

## La decisión a tomar

17 puntos llaman a `redactarConNETO`. Hay que decidir **uno por uno** si van con IA o con texto fijo.
Hipótesis de trabajo, a validar, no a asumir: la IA aporta donde hay análisis y explicación; en
confirmaciones y sociales el texto fijo era más corto, instantáneo y suficiente.

| Archivo | Intents |
|---|---|
| `handlers/intents/social.js` (6) | saludo, ayuda, agradecimiento, queja, chiste_finanzas, como_empezar |
| `handlers/intents/gastos.js` (4) | listar_gastos_mes, listar_gastos_semana, listar_gastos_dia, ver_total_gastado |
| `handlers/intents/presupuestos.js` (2) | ver_presupuesto, ver_balance |
| `handlers/intents/utilidades.js` (2) | comparar_meses, consulta_financiera |
| `handlers/intents/analytics.js` (1) | ver_ingresos |
| `handlers/intents/transacciones.js` (1) | corregir_categoria |
| `handlers/message-processor.js` (1) | fallback de intent desconocido |

## Trabajo

1. **Decidir IA vs texto fijo por intent**, con Favio, presentándole para cada uno la respuesta de
   IA y el texto fijo lado a lado (el harness ya los imprime). No decidir por él en los casos donde
   haya criterio de producto en juego.
2. **Reescribir los textos fijos que se queden.** Varios violan el propio prompt y llevan meses en
   producción: `"Entendido. Déjame revisar."` (queja), `"¡De nada! Aquí andamos cuidando tu bolsillo."`
   (agradecimiento), `"No entendi bien, pero estoy aqui."` (fallback). Desactivar la IA sin tocarlos
   deja el problema, solo que en texto fijo.
3. **Cerrar la muletilla residual** del caso fuera de ámbito.
4. **Colgar `qa-tono-neto.mjs` del canary diario** (ya corre 10am Lima, ver `.claude/deploy-config.json`)
   para que una degradación de tono no vuelva a pasar meses sin que nadie la vea.

## Cómo verificar (herramientas que ya existen)

```bash
npx vitest run                        # 336 tests
node qa-e2e/probe-system-prompt.mjs   # 16 checks: el prompt real llega al modelo, gate de Gmail
node qa-e2e/qa-tono-neto.mjs          # linter de reglas duras de tono sobre respuestas generadas
node qa-e2e/qa-tono-neto.mjs --reales # + muestreo de lo que producción respondió a usuarios reales
node qa-e2e/qa-ia-vs-fijo.mjs 3       # largo vs texto fijo, latencia, cifras inventadas
```

Regla de la casa: nada se da por cerrado sin correr una de estas contra el pipeline real. El probe
monta el `app` de `index.js` completo con Supabase y OpenAI reales, stubeando solo el envío de WhatsApp.

## Datos útiles para dimensionar

- 74 usuarios reales, 68 sin correo conectado (92%).
- Volumen: ~23 mensajes de Neto por semana, 6 usuarios activos. Esperar tráfico orgánico para validar
  NO funciona: hay que generar la muestra con los harness.
- `conversaciones` se auto-purga a los últimos 10 turnos por usuario, no es archivo histórico.
- Usuario QA: `ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172` (`qa-test-dashboard`, `is_test_user=true`, sin Gmail).
- Deploy: push a main → Railway auto. Verificar con `curl -s https://api.neto.pe/health` y buscar
  `System prompt maestro cargado` en los logs del deployment.

## Convenciones que aplican

- Backend CommonJS, editar con Edit tool (archivos grandes), UTF-8 sin BOM.
- Commit + push directo, mensajes en inglés con prefijo.
- El system prompt vive SOLO en `docs/NETO_system_prompt.txt`, cargado por `lib/neto-prompt.js`
  (falla al arranque si no está). No duplicarlo.
