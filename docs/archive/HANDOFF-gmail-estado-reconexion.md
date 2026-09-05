# Handoff — Gmail: estado de reconexión y limpieza

Pendientes que quedaron abiertos tras el trabajo del 2026-08-03 (commits `538bd64`, `f4c979c`,
`4649ffc`, `41b3aca`, `feb109e`, `cbf267c`), en orden de valor. El prompt para retomarlos está
al final.

Contexto que hay que leer primero: la sección **"Conectar Gmail es la unica capability que
exige Pro PAGADO"** de `app/CLAUDE.md`. Resume las tres decisiones que ya están tomadas y NO se
reabren: conectar es web-only, exige Pro pagado, y es UNA cuenta de Gmail por usuario para
siempre.

---

## P1 — La app no distingue "conectado" de "conectado pero muerto" ✅ CERRADO 2026-08-03

Cerrado en el commit `1ee3464`. Lo que quedó, y las dos desviaciones del plan de abajo:

- **Migración 058** agrega `gmail_cuentas.auth_error_at`, que NO reemplaza a `activa`. Ver la
  sección "Conectada y sana son DOS preguntas" de `app/CLAUDE.md`.
- **El sello NO va en `gmail-scanner.js`** como decía el paso 2 de acá, sino en
  `configurarClienteParaCuenta` (`gmail.js`), donde nace el `AUTH_EXPIRED`. Es el único punto
  que sabe qué fila falló, y así marcan los tres productores del error en vez de solo el
  barrido automático — los otros dos (el callback de OAuth y `/escanear`) lo tiraban en
  silencio, cosa que este handoff no había detectado.
- **El banner del dashboard sí se hizo** (el paso 5 lo dejaba a evaluar), colgado del bootstrap
  consolidado `/api/dashboard`. Un `useQuery` propio en el shell resucitaba el fan-out de
  requests que ese endpoint existe para matar.
- Guards: `tests/gmail-estado-auth.test.js`, `webapp/src/app/api/pro/status/route.test.ts` (esa
  ruta no tenía ninguno) y `webapp/src/lib/gmail-estado.test.ts`. Los tres vistos en rojo contra
  `d89b3b5`. La decisión de los 4 estados se extrajo a `webapp/src/lib/gmail-estado.ts` para que
  el guard fuera un test y no un regex sobre el JSX.
- E2E: `qa-e2e/qa-gmail-estado-reconexion.mjs`, 12/12 contra producción. `gmail_cuentas` sigue
  en 5 filas / 5 correos.

**Lo que quedó abierto a propósito:** el throttle de la notificación sigue en memoria, y se
sella ANTES de enviar (`gmail-scanner.js:48` antes de `:57`), así que un envío fallido quema la
ventana de 24h. Es cadencia de aviso, no estado — y el estado, que era el problema de P1, ya no
depende de él.

<details><summary>El diagnóstico original (para contexto)</summary>

**El bug.** Cuando el token de Gmail expira, `services/gmail-scanner.js` (~línea 197) detecta
`authError`, avisa al usuario y **deja la fila en `gmail_cuentas.activa = true`**. Como
`webapp/src/app/api/pro/status/route.ts` calcula `gmailConectado` desde esa columna, la tarjeta
de `/dashboard/pro` sigue diciendo **"Gmail conectado ✓"** mientras no se lee un solo correo.

**Por qué importa.** El único aviso vive en `notificarAuthExpirada`, que además tiene un
throttle **en memoria** (`authErrorNotifiedAt`, una de las piezas que asumen instancia única —
ver la sección de replicas=1 en `app/CLAUDE.md`): un redeploy lo borra. Si el usuario no vio ese
aviso, no tiene forma de enterarse: la app le afirma que está todo bien.

**Consecuencia visible hoy:** como no podemos distinguir los dos estados, el enlace "Reconecta
esta cuenta" está SIEMPRE visible en la tarjeta (`webapp/src/app/dashboard/pro/page.tsx`,
`GmailConnect`). Favio lo reportó el 2026-08-03: un llamado a la acción debajo de un "conectado ✓"
hace dudar de lo que la tarjeta acaba de afirmar. Se bajó de botón a enlace como parche; el
arreglo real es que aparezca **solo** en el estado roto.

**Qué hay que hacer:**

1. Migración `058_gmail_auth_error.sql`: `alter table gmail_cuentas add column auth_error_at
   timestamptz` (nullable).
2. `services/gmail-scanner.js`: donde hoy llama `notificarAuthExpirada`, sellar también
   `auth_error_at = now()` en la cuenta. Ojo que `escanearHistoricoInicial` (~línea 160) tiene
   su propia rama de `authError` que resetea `historico_importado`.
3. `gmail.js` → `guardarTokens`: limpiar `auth_error_at` en toda conexión exitosa. Va en el
   mismo upsert.
4. `webapp/src/app/api/pro/status/route.ts`: exponer `gmailNecesitaReconexion`.
5. `webapp/src/app/dashboard/pro/page.tsx` (`GmailConnect`): tres estados en vez de dos —
   *conectado y sano* (sin ninguna acción), *conectado pero caído* (aviso + "Reconectar"
   prominente + qué pasó), *sin conectar*. Evaluar además un banner en el dashboard: es el
   canal que llega siempre, a diferencia del WhatsApp fuera de la ventana de 24h.
6. Guards: que el sweep persista el estado y que `guardarTokens` lo limpie. Probarlos en rojo
   contra el commit anterior (`git worktree`).

**Gotcha del test:** `gmail.js` NO usa `lib/db`, arma su propio cliente con `createClient` desde
env. Mockear `lib/db` lo deja hablando con Supabase de **producción**. Hay que interceptar
`@supabase/supabase-js` — ver `tests/gmail-una-cuenta.test.js`.

</details>

---

## P2 — La rama 409 (segundo correo) no tiene cobertura E2E ✅ CERRADO 2026-08-03

`qa-e2e/qa-gmail-segundo-correo.mjs`, 11/11. Monta el callback REAL en un Express real contra
la Supabase real, con el state firmado real; lo único falso es lo que hablaría con Google.
`emailGmailVinculado` corre de verdad contra `gmail_cuentas`.

Dos cosas que el plan de acá no preveía y valen para el próximo harness:

- **El control anti-vacuidad es la mitad del valor.** Sin el segundo caso (el MISMO correo pasa
  y sí vincula), un callback que respondiera 409 a todo pasaba el harness entero.
- **Se probó por mutación**: con la condición del 409 forzada a `false`, el harness cae a 6/11.
  Un guard nuevo que no se vio fallar no vale.

Siembra una fila throwaway en `gmail_cuentas` para el usuario QA y la borra en un `finally`,
con un check final de que el conteo total volvió a su baseline. **No gasta cupo**: el cupo se
consume cuando alguien aprueba en la pantalla de Google, no al escribir una fila nuestra.

---

## P3 — Código muerto de multi-cuenta ⛔ NO SE BORRA (decidido 2026-08-03)

Con una cuenta por usuario esto quedó inalcanzable, y la propuesta era borrarlo. **Se revisó y
se decidió no hacerlo**, por un dato que este handoff no tenía:

> El índice único de `gmail_cuentas` es sobre **`(usuario_id, email)`**, no sobre `usuario_id`.

O sea que la regla de "una sola cuenta" vive enteramente en `guardarTokens` y en **nada** de la
base: dos filas por usuario siguen siendo insertables, y nunca se corrió un backfill ni se
agregó una constraint que garantice que no existan. "0 usuarios con más de una cuenta hoy" es
una observación sobre los datos de hoy, no un invariante.

Qué pasa si se borra igual: un usuario en ese estado escribe "desconectar", el handler no
matchea `numCuentas > 1` ni `=== 1`, y cae al `Cancelado. Tu cuenta sigue igual` del final —
**se queda sin forma de soltar un Gmail que quiere soltar**. Borrar ~20 líneas inalcanzables no
vale dejar a alguien sin la puerta de salida de sus propios datos. Y el precio de admisión era
además **bajar** el `>= 4` de `revocarAccesoGmail` en `tests/gmail-oauth-gates.test.js`, que es
justo el guard puesto para vigilar ese flujo destructivo.

La queja real del handoff era "contradice el modelo para quien lea". Eso se resolvió donde
correspondía: la rama quedó **documentada como camino legacy** en `handlers/onboarding.js`, con
el porqué. El menú de `handlers/intents/moderacion.js` ramifica en espejo y se queda igual.

**Si algún día se quiere borrar de verdad**, el orden es: primero una migración que agregue el
índice único sobre `usuario_id` (que es la garantía que hoy falta), y recién después el código.
Nunca al revés.

Lo demás de este bloque sigue abierto y sigue siendo limpieza opcional, no un bug:

- Intent `preferencia_reporte_gmail` + columna `usuarios.reporte_gmail_modo` + acción
  `report_preference` del tool: unificado/separado solo tiene sentido con 2+ cuentas. Hoy
  degrada bien ("tienes una sola cuenta..."), su probe pasa 6/6.
- `gmail.js`: los paths que escanean todas las cuentas activas en paralelo. Ojo que
  `leerCorreosBancarios` **colapsa** el error de N cuentas en un solo flag (`gmail.js:638`), y
  esa pérdida de información es la que obligó a sellar `auth_error_at` en el origen (ver P1).
- `handlers/neto-tools.js`: la descripción del tool dice "agregar/cambiar su Gmail". Tocarla
  mueve comportamiento del NLP, así que hay que medir antes con `tests/nlp/` — y ojo que el
  NLP agent de CI está en **STANDBY** desde 2026-07-14, así que esa medición hoy no corre sola.

---

## Prompt para retomar

```
Contexto: Neto (C:\Vortik.dev\products\neto\app). Lee primero
docs/archive/HANDOFF-gmail-estado-reconexion.md y la sección "Conectar Gmail es la unica
capability que exige Pro PAGADO" de app/CLAUDE.md.

NO reabras estas decisiones: conectar Gmail es web-only, exige Pro PAGADO, y es UNA
cuenta de Gmail por usuario para siempre (cada cuenta de Google distinta quema uno de
los 100 cupos de por vida, que no se restablecen; van 5 de 100).

Quiero cerrar P1 del handoff: hoy la app dice "Gmail conectado ✓" aunque el token esté
muerto, porque el sweep avisa pero deja gmail_cuentas.activa en true. Eso hace que el
enlace de reconexión tenga que estar siempre visible, y que un usuario cuyo Gmail se
cayó no se entere si se perdió el aviso.

Trabaja en plan mode primero. Antes de proponer, mide contra producción:
- cuántas cuentas activas hay y de qué usuarios
- si alguna está en estado de auth caído hoy (cruza la tabla `errores` por tag AUTH
  y los logs de GMAIL_REVOKE)

Restricciones:
- Español, código en inglés. Commits en inglés con prefijo.
- No reimplementes esProPagado() ni linkPanelPro(): existen en lib/trial.js.
- Todo cambio en un camino de Gmail deja verde tests/gmail-oauth-gates.test.js y
  tests/gmail-una-cuenta.test.js, que tienen conteos e invariantes fijados a propósito
  (entre ellos: CERO generarUrlAutorizacion en handlers/). Actualízalos con criterio,
  no para que pasen.
- Gotcha: gmail.js NO usa lib/db, arma su propio cliente con createClient desde env.
  Mockear lib/db en un test lo deja hablando con Supabase de PRODUCCIÓN. Intercepta
  @supabase/supabase-js (ver tests/gmail-una-cuenta.test.js).
- Todo guard nuevo tiene que verse ROJO contra el commit anterior (git worktree) antes
  de darlo por bueno, y sin pasar por vacuidad.
- Verificación: npm test en app/ y app/webapp/, qa-e2e/qa-gmail-pro-pagado.mjs,
  qa-e2e/probe-bancos.mjs, y los 3 curls (neto.pe, app.neto.pe, api.neto.pe/health).
- Confirma al terminar que el contador de gmail_cuentas sigue en 5: la verificación no
  puede quemar un cupo.

Si sobra tiempo, sigue con P2 (cobertura de la rama 409 sin gastar cupo) y P3
(limpieza del código muerto de multi-cuenta).
```
