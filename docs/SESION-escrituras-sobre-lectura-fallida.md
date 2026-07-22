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
| ~~`services/referrals.js`~~ | ~~Otorga meses de Pro gratis~~ | **HECHO 22-jul-2026, ver abajo.** |
| ~~`lib/pro-payment.js`~~ | ~~Aprobación de pagos~~ | **HECHO 22-jul-2026, ver abajo.** |
| `services/shared-spaces.js` | Balances entre personas reales | 16 sitios sin leer `error`, es el archivo con más densidad después del cron |
| `services/neto-score.js` | Número que el usuario ve y en el que confía | 5 sitios. Un factor que sale 0 por query fallida baja el score sin explicación |

Nota: `referidos` está en **0 filas** hoy, así que el riesgo ahí es latente, no realizado. Verificar
antes de dimensionarlo como urgente.

## `services/referrals.js` — cerrado 22-jul-2026

Los 9 sitios se probaron uno por uno forzando el fallo de cada query con un Supabase inyectado por
`require.cache` (mismo patrón que `tests/services/summaries.test.js`).

**La hipótesis de la tabla era falsa.** La línea 8 sí escribía con la lectura rota, pero
`referidos` tiene `UNIQUE (referrer_id, referido_id)`: Postgres rechazaba el insert. No había
duplicado posible, solo un `23505` que nadie logueaba. Los sitios 10, 18, 22, 27 y 31 fallan
**cerrado** (una lectura rota hace `return` sin escribir): son silenciosos, no peligrosos.

**El bug caro no era de lectura fallida sino de idempotencia.** Con todas las lecturas sanas,
`verificarProReferidos` sumaba `floor(activos/3)` meses a `premium_vence` en cada invocación,
tomando como base el propio `premium_vence`. Tras el primer otorgamiento la base ya era futura, así
que el guard `venceStr !== venceActual` era código muerto. Medido: 5 llamadas con los mismos 3
referidos activos → 5 meses de Pro y 5 mensajes de WhatsApp. Y se invoca **por cada correo bancario
procesado de un referido** (`gmail-scanner.js:107`, dentro de un `setTimeout` de 5s) más cada
`hola neto ref:CODE` (`webhook.js:436`): la inflación era proporcional al uso del referido.
Exposición real hoy: 0, porque `referidos` está vacía y solo 1 de 78 usuarios tiene `ref_code`.

Fix (migración `036`, columna `usuarios.referidos_meses_otorgados`):
- El otorgamiento es un **delta** (`mesesGanados - yaOtorgados`), no un recálculo.
- El `UPDATE` lleva **claim atómico** `.eq('referidos_meses_otorgados', yaOtorgados).select('id')`:
  dos ejecuciones concurrentes del scanner no pueden otorgar dos veces sin depender de instancia
  única. Mismo patrón que `pagos.estado` e `historico_importado`.
- El WhatsApp sale **solo si la escritura aterrizó**. Antes se mandaba "te dimos 1 mes gratis"
  aunque el `UPDATE` fallara.
- Las 9 queries capturan `error` con tag `REFERIDO`. El insert ignora `23505` (caso legítimo
  "ya existía") y loguea cualquier otro código.
- `webhook.js:435-436` ahora usa `await`: sin él, el verify podía leer los referidos antes de que
  el insert aterrizara.

Cubierto por `tests/services/referrals.test.js` (14 tests). Mutación verificada: quitar el delta
reproduce los 5 meses; quitar el claim rompe el test de concurrencia; quitar el guard de lectura
hace que vuelva a insertar a ciegas. Nota: el `return` tras `errUpd` es redundante (con error,
`data` es `null` y lo atrapa el guard de `aplicado`); se dejó por claridad y porque loguea a nivel
`error` mientras el otro loguea `warn`.

Queda latente, sin tocar: `vence.setMonth(base.getMonth() + nuevos)` desborda si `premium_vence`
cae en día 29-31 (31-ene + 1 mes → 3-mar). Regala días, no meses.

## `lib/pro-payment.js` — cerrado 22-jul-2026

Nueve sitios probados con el mismo método. Acá la pista de la tabla **sí era correcta**, y había
dos más que no estaban listadas. A diferencia de `referidos`, `pagos` no tiene ningún unique:
solo `pkey(id)` y `CHECK` sobre `estado`/`origen`. La DB no frena nada.

Los tres que costaban plata:

1. **`reclamarPagoPendiente` (~216)**: con el SELECT roto devolvía `null`, y `routes/admin.js:76`
   traduce `null` a `{ ok: true, already: true, 'El pago ya estaba procesado' }`. El usuario pagaba,
   el admin veía éxito y Pro no se activaba nunca. Lo mismo con el UPDATE del claim (~223): un fallo
   de red era indistinguible de "otro tap ganó la fila". Ahora ambos lanzan; los dos callers
   (`routes/admin.js:85`, `admin-commands.js:119`) ya tenían `try/catch` que muestran error real.
   `null` sigue reservado para el caso legítimo, así que el doble-tap sigue siendo no-op.
2. **`registrarPagoAprobado` (~252)**: si no podía leer el pendiente, **insertaba una fila aprobada
   nueva**. Revenue inflado en `/api/admin/economics` (suma `pagos` aprobados del mes) + pendiente
   huérfano. Ahora no inserta: loguea y avisa al admin para registro manual.
3. **`activarPro` (~329)**: el UPDATE que ES la activación no leía `error`. Si fallaba, el usuario
   igual recibía "✅ ¡Pago confirmado!" + notificación in-app, y la fila de `pagos` quedaba aprobada
   aguas arriba. Pagó, el sistema dice que sí, sigue en Free. Ahora corta antes del aviso **y
   devuelve el pago a `pendiente`**: sin ese rollback el reintento del admin encontraba "ya
   procesado" y el usuario quedaba en Free para siempre.

Los otros: `solicitarComprobante` (si el flag no setea, la siguiente captura del usuario se procesa
como GASTO en vez de comprobante), el `update` de `pago_pendiente`, los dos de
`rechazarSolicitudPro` y el `update` con `pagoId` — todos capturan `error` y loguean con tag
`PRO_PAGO`. Y si el insert en `pagos` falla, `notificarSolicitudAdminPro` ya no manda botones de
Telegram con `callback_data: 'pro:approve:mensual:null'`: cae al aviso de texto con el `/pago` manual.

Cubierto por `tests/lib/pro-payment-fallos.test.js` (15 tests). Mutación verificada sobre los tres
guards que importan: cada uno hace fallar exactamente su test.

### Datos de producción: 10 filas en `pagos`, dos grupos raros, ninguno atribuible

- Usuario `e4332f63`: una fila **`pendiente` del 6-jun que sigue pendiente**, con una `aprobado` del
  mismo día. Es la firma de "la aprobación no tocó el pendiente".
- Usuario `ef9be664`: **dos filas aprobadas el 30-jun**, S/10 cada una (`admin:/pago` y
  `admin:webapp`), pero `premium_vence` avanzó un solo mes.

**No son atribuibles al bug de lectura fallida**: el claim atómico entró el 18-jul (commit `87764d3`)
y las dos son de antes, así que el camino legacy de doble aprobación las explica igual de bien. El
piso demostrable es: 1 pendiente huérfano y S/10 que aparecen dos veces en el revenue de junio. Sin
tocar. Para cerrarlo hace falta que Favio confirme contra su historial de Yape si ese usuario pagó
una vez o dos. Si pagó una, sobra una fila; si pagó dos, le falta un mes de Pro.

Efecto vivo del huérfano: el próximo `/pago` manual sobre ese usuario marcaría como aprobación esa
fila de hace seis semanas, no una nueva.

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
