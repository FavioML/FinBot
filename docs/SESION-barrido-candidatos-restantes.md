# Sesión: cerrar el barrido de fallos silenciosos (candidatos restantes)

Prompt de arranque autocontenido. Trabajar desde `C:\Vortik.dev\products\neto\app`.

---

## Qué queda y con qué expectativa

Son los cuatro archivos que quedaron sin auditar del barrido original de `docs/SESION-fallos-silenciosos.md`.

**Expectativa honesta: rendimiento bajo.** El único archivo de esta lista que ya se auditó
(`services/summaries.js`) salió **sano**: sus tres `catch (e) { /* silent */ }` no solo no fallaban,
sino que eran inalcanzables, porque `supabase-js` no lanza nunca (ni con columna inexistente ni con
fallo de red total: devuelve `{ data: null, error }`). Es probable que varios de estos también estén
sanos. Vale hacerlo igual para cerrar la lista, pero sin asumir que hay bugs esperando.

Si el tiempo es escaso, `docs/SESION-escrituras-sobre-lectura-fallida.md` tiene mayor valor esperado.

| Archivo | Qué hay |
|---|---|
| `services/recommendations.js` | `catch → return null` en ~318, ~374; otros catch en ~246, ~488 |
| `services/parsers.js` | `catch → return []` en ~375; `catch → return { es_presupuesto: false }` en ~384 |
| `handlers/intents/score.js` | catch en ~101, alrededor de la generación de tips con IA |
| `services/spending-alerts.js` | catch en ~177 |

## Método

Para cada uno: **"¿qué pasa si esto falla SIEMPRE? ¿se notaría?"** Si la respuesta es "no", probarlo.

1. Llamar la función directo con datos reales (`node -e "require('dotenv/config'); ..."`), no a
   través del flujo, para ver si devuelve el valor bueno o el fallback. Un fallback aguas arriba
   puede estar tapando un 100% de fallo: fue exactamente el caso de `redactarConNETO`, que devolvía
   `null` en todas las llamadas durante meses.
2. **Mirar también el `error` descartado, no solo el catch.** Es la lección del 21-22 de julio:
   `const { data } = await supabase` sin leer `error` es donde vive el fallo silencioso real. Un
   catch vacío sobre una query de Supabase es ruido.
3. Donde el fallback sea legítimo, subir el log a nivel error con tag propio.
4. Donde la dependencia sea obligatoria, fallar ruidosamente (ver `lib/neto-prompt.js`).
5. Test de regresión por cada fallo encontrado, validado con mutación: revertir el fix a mano, ver
   fallar el test correcto, restaurar.

**Registrar también lo sano.** Si un candidato resulta correcto, anotarlo en
`docs/SESION-fallos-silenciosos.md` con cómo se demostró. Un archivo verificado sano es un resultado,
no un no-resultado, y evita que alguien lo vuelva a auditar en tres meses.

## Ya verificado, no repetir

- `timeout` dentro del body de OpenAI: barrido completo hecho sobre las 12 llamadas del repo.
  Solo `services/neto-gpt.js` lo tenía. Cubierto por `tests/services/neto-gpt.test.js`.
- `services/summaries.js`: los 3 catch sanos e inalcanzables. Queries ahora leen `error` con tag
  `RESUMEN_SEM`; `obtenerDeudas` con tag `DEUDAS`. Commit `62e52bf`.
- Crons de resumen: filtraban `gmail_access_token IS NOT NULL` sin razón funcional y dejaban la
  audiencia en 3 de 77 usuarios. Corregido y cubierto por `tests/cron/resumen-destinatarios.test.js`.
- Ingesta Gmail: dos avisos del banco para el mismo cargo entraban como dos transacciones. Guard en
  memoria por hora de llegada del correo. Commit `8843f8b`.

## Cómo verificar

```bash
npx vitest run                        # 356 tests
node qa-e2e/probe-system-prompt.mjs   # 16 checks contra el pipeline real
```

Patrón de test con Supabase mockeado por `require.cache`: `tests/services/summaries.test.js`.

## Convenciones

- Backend CommonJS, editar con Edit tool, UTF-8 sin BOM.
- Commit + push directo, mensajes en inglés con prefijo.
- Nunca correr tests contra la DB real: mockear Supabase (ver `tests/setup.js`).
