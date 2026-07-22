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
| ~~`services/shared-spaces.js`~~ | ~~Balances entre personas reales~~ | **HECHO 22-jul-2026, ver abajo.** |
| ~~`services/neto-score.js`~~ | ~~Número que el usuario ve y en el que confía~~ | **HECHO 22-jul-2026, ver abajo.** |

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

~~Queda latente, sin tocar: `vence.setMonth(...)` desborda si `premium_vence` cae en día 29-31.~~
**Corregido el 22-jul-2026** (commit `d728725`), y resultó no ser solo de referrals: ver la sección
`setMonth` al final del doc.

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

**Resuelto el 22-jul-2026** con confirmación de Favio y respaldo en
`docs/backups/2026-07-22-pagos-limpieza.json`:
- La fila fantasma de Jose Luis se borró. Se pudo demostrar que no era un pago: `comprobante_url`
  y `monto_detectado` en NULL y `created_at == aprobado_at` (la creó el comando `/pago` a las 14:04,
  ocho horas después de que su pago real ya estuviera aprobado a las 05:49). Junio pasó de S/40 a
  S/30, que es la caja real.
- La pendiente de Juan Lengua se cerró como `rechazado` con nota: es el reenvío de la captura
  aprobada en `bdb5c83f` (mismo día, mismo monto, las dos con comprobante). No se borró porque sí
  tiene un comprobante real del usuario. `pagos` quedó sin ninguna fila pendiente.

## `services/shared-spaces.js` — cerrado 22-jul-2026

El archivo de mayor daño potencial de la tabla, y el que más rindió. Acá **ninguna** lectura
fallida producía una excepción: producían un número creíble y falso entre dos personas reales.

Escenario medido (Ana y Beto, gasto de S/100 pagado por Ana congelado 70/30, Beto ya liquidó sus
S/30, saldo real cero para ambos):

| Lectura que falla | Lo que Neto respondía |
|---|---|
| `space_settlements` | "Beto debe S/30 a Ana" — plata que Beto **ya pagó** |
| `space_expenses` | "Ana debe S/30 a Beto" — la deuda **cambia de dueño** |
| `space_members` | "✅ ¡Están al día!" — idéntico a un espacio sano en cero |

Las tres salían del mismo `|| []` en `obtenerBalanceEspacio`. El balance es una resta entre las tres
tablas y a cada una le falta el signo contrario, así que degradar cualquiera a vacío no da un error:
da un saldo con la dirección equivocada. Ahora las tres cortan; el intent
(`handlers/intents/espacios.js:159`) ya tenía el `catch` que responde "No pude obtener el balance".

Segundo hallazgo, y este congela: `obtenerContextoSplit` leía el espacio y el plan del owner sin
mirar `error`. Con cualquiera de las dos caída, `effectiveRules` quedaba en `[]` y un gasto con
regla 70/30 **se guardaba 50/50 para siempre** (el snapshot es inmutable por diseño), y al otro se
le avisaba "Tu parte: S/50" en vez de S/30. Ahora corta antes de insertar. Matiz: si el espacio no
tiene reglas configuradas, el plan del owner da igual y no se bloquea el registro — solo se loguea.

Tercero: `unirseEspacio` calculaba el peso del que entra con `previos || []`, y
`joinSplitWeight([])` devuelve `DEFAULT_SPLIT_WEIGHT` (50). En un espacio 90/10 el recién llegado
entraba con 50 inventado en vez del promedio real. Entrar es reintentable; un split equivocado no
se nota.

Los que fallan cerrado pero mentían: `obtenerEspaciosUsuario` decía "No tienes espacios
compartidos" y `obtenerResumenEspacio` decía "No tienes acceso a ese espacio" sobre lecturas
caídas. Ahora lanzan; `null` quedó reservado para `PGRST116` (no hay fila de verdad).

Los de aviso (`registrarGastoCompartido` tras el insert, `liquidarCuentas`, `notificarNuevoMiembro`)
siguen siendo best-effort a propósito: el dinero ya se movió, solo se loguea con tag propio.

La DB ayuda menos de lo que parece: `space_members` sí tiene `UNIQUE (space_id, user_id)` y
`space_expenses` tiene el CHECK `space_shares_conserve`, pero ninguna de las dos toca el problema —
acá no se insertaban duplicados, se calculaban números equivocados con datos incompletos.

Cubierto por `tests/services/spaces-lecturas-fallidas.test.js` (16 tests). Mutación verificada
sobre los tres guards principales.

**Nota de método:** el primer probe usó el shape equivocado para `split_rules`
(`{categoria, pct}` en vez de `{category, splits}`), así que su control "esperado 70/30" nunca
aplicó la regla. No cambió ninguna conclusión, pero es el recordatorio de siempre: el control tiene
que verificarse tan en serio como el caso roto. El test sí afirma el 70/30 con lecturas sanas.

## El espejo en la webapp — cerrado el mismo día

`webapp/src/lib/spaces-server.ts` tenía los mismos dos bugs, y uno peor que en el backend.

`getSpaceBalances` leía las tres tablas con `?? []`, igual que `obtenerBalanceEspacio`. Pero acá
ese número además **es la guarda que impide sacar a un miembro con deuda**
(`DELETE /api/spaces/[id]/members`): con las tres lecturas caídas todos los saldos dan cero, la
guarda pasa y alguien sale del espacio debiendo. Por el propio comentario de esa ruta, un saldo así
ya no se puede liquidar desde la app.

`getSpaceSplitContext` descartaba el error del espacio, de los miembros y del plan del owner: mismo
congelamiento 50/50 sobre una regla 70/30, con el agravante de que los dos runtimes tienen que
decidir igual o el mismo gasto vale distinto según por dónde se registró.

`getSpaceMemberIds` devolvía un Set vacío, con lo que todo destinatario y todo split legítimo se
rechazaba como si el usuario hubiera mandado basura. Falla cerrado, pero mintiendo sobre la causa.

Los tres lanzan ahora. Verificado con `tsc --noEmit` y `npm run build`; los 57 hallazgos de
`npm run lint` son idénticos antes y después (preexistentes, ninguno en este archivo).

**Queda sin tocar y es del mismo patrón:** `getSessionUser` hace `if (!data) return null` sobre la
lectura de `usuarios`, así que un fallo de lectura se presenta como "no hay sesión" y la ruta
responde 401. Falla cerrado, pero un 401 espurio puede empujar al cliente a un logout. No se cambió
en esta sesión porque toca el camino de auth de toda la webapp y merece verificarse con el cliente
en la mano, no a ciegas.

## `services/neto-score.js` — cerrado 22-jul-2026

El score es una media ponderada de 6 factores. Un factor que no puede leer sus datos no falla:
devuelve su default y el score **se mueve**. Y el cron de las 6am persiste ese número en
`neto_scores` todos los días como si fuera cierto.

Medido sobre un usuario modelo (registra casi a diario, dentro de presupuesto, ahorra >20%, metas
en ritmo, **una deuda vencida sin pagar un sol**, usa todas las herramientas). Score sano: **90**.

| Lectura que falla | Score | Delta |
|---|---|---|
| `transacciones` (consistencia) | 70 | **-20** |
| `deudas` | 98 | **+8** |
| `presupuestos` (count) | 87 | -3 |
| `metas_ahorro` (count) | 88 | -2 |
| `usuarios` (visibilidad) | 88 | -2 |
| todas menos deudas | 62 | -28 |

Dos cosas que no se ven en la tabla:

- El -20 de consistencia además cambia el consejo: `factorMasDebil` pasa a decir "tu punto más
  débil: Consistencia de registro" a alguien que registra todos los días, y le ofrece tips para
  arreglar lo que no está roto. El label también cruza (90 = "Excelente", 70 = "En camino").
- **`deudas` es el único que falla hacia arriba.** Su default es 80 ("no tiene deudas = bien"), así
  que una lectura caída le sube el score justo a quien el factor debería castigar. Un fallo que
  premia es peor que uno que castiga: nadie reporta que su score subió.

Los cinco cortan ahora. `upsertScore` ya tenía el `try/catch` que devuelve `null`, y los dos
callers ya lo manejaban bien: el intent responde "No pude calcular tu score" y el cron salta a ese
usuario. O sea que no se persiste nada y el usuario sigue viendo el score de ayer, que es verdad.

`obtenerHistorialScore` decía "no tienes historial" sobre una lectura caída (ahora corta);
`obtenerScoreActual` distingue `PGRST116` (usuario nuevo, legítimo) de un fallo real;
`obtenerTendenciaScore` sigue devolviendo `null` a propósito — los dos callers omiten la tendencia
y no se muestra ningún número falso — pero ahora loguea, porque si no el aviso semanal deja de
salir sin dejar rastro. También se quitó un import muerto de `obtenerScoreActual` en el intent.

### El espejo de la webapp, que era el que persistía de verdad

`api/score/route.ts` recalcula el score on-demand para un usuario nuevo o con `?refresh=true`, con
las mismas cinco lecturas degradadas a `[]`, **y lo persiste en `neto_scores`**. Ahí el número
falso no se muestra y se olvida: queda asentado como el score vigente hasta que el cron lo pise.
Ya cortaba con un 500 controlado si algo lanzaba, así que el guard entra limpio.

`api/score/backfill/route.ts` era el peor de los dos. Entre sus cinco lecturas está la de los
scores ya existentes, que es lo único que impide recalcular un mes ya asentado
(`if (existingYearMonths.has(...)) continue`). Con esa lectura caída el set queda vacío, el
`continue` no dispara y el backfill **reescribe por upsert meses de historia** con números
calculados sobre data incompleta.

Cubierto por `tests/services/neto-score-lecturas.test.js` (14 tests, incluidos los controles de que
un usuario sin transacciones sigue dando 0 y uno sin deudas sigue dando 80 sin lanzar). Mutación
verificada. Webapp: `tsc --noEmit` limpio, `next build` OK, los 57 hallazgos de lint idénticos
antes y después y ninguno en estas rutas.

---

## Estado del doc

Los 4 archivos de la tabla están cerrados. Lo que quedó anotado y sin tocar, por orden de valor:

1. `getSessionUser` en la webapp (arriba): mismo patrón sobre el camino de auth. **Lo único
   abierto.** Difiere del resto: es Next.js/TypeScript, el loop de verificación es browser con
   sesión real (no vitest), y toca el auth de toda la webapp. Merece sesión propia y limpia.
2. ~~`vence.setMonth(...)` en `services/referrals.js`~~ — **HECHO 22-jul-2026, commit `d728725`.**
3. ~~`docs/SESION-barrido-candidatos-restantes.md`~~ — **CERRADA 22-jul-2026, commit `e183494`.**

### `setMonth` — cerrado 22-jul-2026

Resultó no ser solo de referrals. `setMonth` desborda al mes siguiente cuando el día no existe en
el destino (31-ene + 1 mes = 3-mar). Helper nuevo `sumarMeses` en `lib/dates.js`: aritmética de
calendario sobre enteros, recorta al último día, y al no usar `Date` tampoco puede correrse un día
por `toISOString()`.

Tres call sites donde el día del mes significa algo:

| Sitio | Daño |
|---|---|
| `services/referrals.js` | ~3 días de Pro de yapa por cada mes otorgado. Además mezclaba un `Date` local con `toISOString()`: después de las 19:00 Lima el vencimiento salía un día más adelante. |
| `cron/checks.js` (suscripciones) | **El peor.** El comentario promete "mismo día del último pago" pero el avance es iterativo: un cobro del 31 saltaba al 3 y se quedaba en el 3 para siempre. Y como el aviso solo sale si faltan exactamente `SUB_LEAD_DIAS`, no daba un recordatorio equivocado: **dejaba de darlo, en silencio.** |
| `handlers/intents/deudas.js` | "vence en 1 mes" devolvía una fecha del mes equivocado. |

Sin tocar a propósito: los `setMonth` de `neto-score.js` (ventana de historial) y
`subscriptions/detector.js` (ventana de 3 meses). Ahí el desborde mueve el borde de una ventana 2-3
días sin efecto visible, y cambiarlo correría los umbrales de detección sin ganar nada.

**Encontrado de paso y sin tocar:** el bloque de fechas de `handlers/intents/deudas.js` usa
`new Date()` (hora del server, UTC en Railway) + `toISOString()` para "en N días", "mañana",
"pasado mañana" y "en N semanas". Entre las 19:00 y medianoche de Lima, UTC ya está en el día
siguiente, así que "mañana" devuelve pasado mañana. Es un bug de zona horaria distinto del de meses
y merece decidirse aparte.

Cubierto por `tests/lib/sumar-meses.test.js` (9 tests, incluido un barrido exhaustivo del año que
afirma que el resultado nunca se sale del mes destino) y 2 tests nuevos en
`tests/services/referrals.test.js` sobre el call site real. Mutación verificada en ambos niveles:
revertir a `setMonth` produce el `2026-03-03` documentado.

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
npx vitest run                        # 437 tests
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
