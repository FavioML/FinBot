# Log de defectos introducidos

Una fila por defecto que **yo introduje** (no por bug heredado ni por hallazgo de auditoría
sobre código viejo). Existe para que "¿estamos mejorando?" deje de ser una sensación.

Nació el 2026-08-04, cuando Favio observó que seguían apareciendo errores pese al cambio de
modelo, y quedó claro que el problema no era el modelo: había **siete memorias** de feedback
diciendo variantes de "verificar mejor" y una de ellas se violó al día siguiente de escribirla.
Una memoria no es un control. Un control es algo que corre y falla.

## Cómo se usa

- **Una fila por defecto**, el día que se descubre. Incluye los que se encuentran y arreglan en
  la misma sesión: esos son justamente los que enseñan barato.
- **La columna que importa es "clase"**, no la severidad. Si una clase se repite, falta un
  control mecánico, no disciplina.
- **"Lo encontró"** distingue lo que se atrapó solo de lo que se atrapó de casualidad. Si la
  mayoría dice "Favio" o "revisión posterior", la verificación previa no está funcionando.
- El retro semanal (`/retro`) lo lee. Sin esto, cada sesión empieza creyendo que la anterior
  fue limpia.

## Clases vistas hasta ahora

| Clase | Qué la produce |
|---|---|
| `camino-feliz-unico` | verifiqué lo que construí, no la rama de error / el usuario del muro / el kill duro |
| `efecto-lateral-al-deduplicar` | unifiqué dos caminos que *decían* lo mismo sin mirar qué *hacían* además |
| `consumidor-no-actualizado` | agregué estado nuevo y no actualicé a todos los que lo leen o lo copian |
| `error-no-leido` | supabase-js no lanza; sin leer `{error}` un fallo se lee como "no había nada" |

## Registro

| Fecha | Defecto | Clase | Lo encontró | ¿Había un control que debió atraparlo? | Control que quedó |
|---|---|---|---|---|---|
| 2026-08-03 | `try/catch` tragándose errores de PostgREST en el barrido de la webapp | `error-no-leido` | barrido posterior de Favio | No | `auth-callsites.test.ts` ya existía para el mapeo; el patrón quedó en la memoria de verificación |
| 2026-08-03 | Fetch extra para 42 de 48 usuarios (el del muro recibe 402 y el fallback era el camino normal) | `camino-feliz-unico` | barrido posterior de Favio | No | doble gate `useBootstrapGate` + `enabled: proPagado` |
| 2026-08-03 | Copy que prometía un botón que no renderiza en 1 de 4 estados | `camino-feliz-unico` | barrido posterior de Favio | No | — |
| 2026-08-03 | Harness que dejaba filas en prod si el proceso muere sin `finally` | `camino-feliz-unico` | barrido posterior de Favio | No | preclean por marcador al inicio |
| 2026-08-04 | `/premium` delegado al intent arrastró `solicitarComprobante`: 48h en que la foto de un gasto se rechaza sin registrarlo, justo al usuario del muro | `efecto-lateral-al-deduplicar` | **pregunta de Favio**, no mi verificación (685 tests + E2E del muro 35/35 + 3 curls estaban verdes) | No | `tests/handlers/premium-comando-sin-comprobante.test.js` (10 casos, guard probado fallando) |
| 2026-08-04 | Los tres fixes de la Ola 1 declarados "listos" con la rama de error / el camino real sin ejercitar (B1, B5, M8) | `camino-feliz-unico` | **pregunta de Favio** | No | `gmail-guardar-tokens-errores.test.js`, `qa-referido-premio-trial.mjs` (al canary), `plan-limites-paridad.test.js` |

## Defectos ajenos que enseñan lo mismo (no cuentan como míos, pero la clase sí)

| Fecha | Defecto | Clase | Nota |
|---|---|---|---|
| 2026-08-04 | `merge_and_link` fusionaba `plan` pero descartaba `trial_estado/inicio/vence`: el camino feliz del funnel creaba Pro indefinidos invisibles a todos los crons | `consumidor-no-actualizado` | migración 059. **Sin control mecánico todavía**: nada obliga a que un `usuarios` con columna nueva de estado actualice el merge. Candidato a guard. |
| 2026-08-04 | `qa-guard` no reconocía las columnas de dueño de `referidos`, así que bloqueaba la tabla entera y los referidos quedaban intestables | `consumidor-no-actualizado` | La barrera se leía como "esto no se puede testear". Arreglado agregando `referrer_id`/`referido_id`. |
