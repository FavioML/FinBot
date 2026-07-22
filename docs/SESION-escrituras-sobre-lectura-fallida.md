# Sesión: escrituras que dependen de una lectura que puede fallar

Prompt de arranque autocontenido. Trabajar desde `C:\Vortik.dev\products\neto\app`.

---

## La clase de bug que se busca

Un `SELECT` falla, `supabase-js` devuelve `{ data: null, error }` sin lanzar, el código descarta el
`error`, interpreta `data == null` como **"no existe"** y **escribe igual**. El resultado es un
otorgamiento duplicado, un cobro repetido o un balance movido, sin excepción, sin log y sin síntoma.

Esta es la clase que sí rindió el 21-22 de julio de 2026. La hipótesis original (los `catch` vacíos)
resultó mayormente falsa: en `services/summaries.js` los tres catch estaban sanos y además eran
inalcanzables. **El bug no es el catch, es el `error` que nadie lee.** Grepear
`const { data } = await supabase`, no `catch`.

Hay 186 sitios con ese patrón en el backend. NO son 186 bugs: en la mayoría el fallback vacío es
visible (una lista que sale vacía se nota). Solo importa donde una lectura fallida produce una
escritura o un número que el usuario cree cierto.

## Archivos objetivo, en orden de daño

| Archivo | Por qué | Pista concreta |
|---|---|---|
| `services/referrals.js` | Otorga meses de Pro gratis | `~línea 8`: `.single()` sobre `referidos` y, si no encuentra, hace `insert`. Si esa lectura falla se inserta un referido duplicado. `~31-43` lee el plan y luego escribe `premium_vence` |
| `lib/pro-payment.js` | Aprobación de pagos | `~216`: `const { data: pend }` y `if (!pend) return null` — una lectura fallida hace que una aprobación se pierda en silencio. `~252-273`: lee pendiente y luego inserta |
| `services/shared-spaces.js` | Balances entre personas reales | 16 sitios sin leer `error`, es el archivo con más densidad después del cron |
| `services/neto-score.js` | Número que el usuario ve y en el que confía | 5 sitios. Un factor que sale 0 por query fallida baja el score sin explicación |

Nota: `referidos` está en **0 filas** hoy, así que el riesgo ahí es latente, no realizado. Verificar
antes de dimensionarlo como urgente.

## Método

Para cada sitio, la pregunta que destapó todo lo anterior: **"¿qué pasa si esta lectura falla
SIEMPRE?"** Si la respuesta es "se escribe igual" o "el usuario ve un número creíble pero falso",
es un bug aunque hoy no se haya manifestado.

1. **Demostrar antes de proponer.** Llamar la función directo con datos reales
   (`node -e "require('dotenv/config'); ..."`), no a través del flujo. Mirar si devuelve el valor
   bueno o el fallback.
2. **Cuidado con las carreras.** Un `SELECT`-antes-de-`INSERT` no protege nada si hay concurrencia.
   `services/gmail-scanner.js` procesa 5 correos en paralelo (`CONCURRENCIA_SWEEP`) y por eso el fix
   del 22-jul tuvo que ser un guard en memoria, no una consulta. Antes de proponer un check por
   query, verificar si el llamador puede correr en paralelo.
3. **Capturar `error` y loguear con tag propio** donde el fallback sea legítimo.
4. **Fallar ruidoso** donde la dependencia sea obligatoria (ver `lib/neto-prompt.js`: lanza al
   require y el proceso no arranca).
5. **Test de regresión + mutación.** Un test que no falla al revertir el fix no prueba nada.
   Revertir a mano, ver fallar el test correcto, restaurar.

## Guardrail sobre datos de producción

Si aparecen filas sospechosas, **no borrar sobre la base de un agregado**. El 22-jul un conteo por
`dedup_hash` daba "24 filas duplicadas, S/1386"; mirando fila por fila lo demostrable eran 4 filas y
S/48, y varias de las otras eran gastos reales (dos viajes de bus de S/2, cargos de ITF de S/0.20).
Dar siempre el piso demostrable y el techo por separado, exigir una prueba de identidad de origen
por fila, respaldar a JSON antes de tocar nada y pedir confirmación.

## Cómo verificar

```bash
npx vitest run                        # 356 tests
node qa-e2e/probe-system-prompt.mjs   # 16 checks contra el pipeline real
curl -s https://api.neto.pe/health    # tras el push, esperar que uptime reinicie
```

Los probes de `qa-e2e/` montan el `app` de `index.js` completo con Supabase y OpenAI reales,
stubeando solo el envío de WhatsApp. Ver `probe-ratelimit-ipv6.mjs` como patrón. Para tests con
Supabase mockeado, el patrón de inyección por `require.cache` está en
`tests/services/summaries.test.js` y `tests/cron/resumen-destinatarios.test.js`.

## Convenciones

- Backend CommonJS, editar con Edit tool, UTF-8 sin BOM.
- Commit + push directo, mensajes en inglés con prefijo.
- Nunca correr tests contra la DB real: mockear Supabase (ver `tests/setup.js`).
- Actualizar `docs/SESION-fallos-silenciosos.md` con lo que se verifique, sano o roto, para que la
  siguiente sesión no repita el trabajo.
