# Matriz de capacidades por canal — Neto (App vs WhatsApp)

Fuente de verdad para saber qué se puede hacer en cada canal y cómo debe hablar el
copy. Neto opera sobre **una sola cuenta** con dos canales (registro dual + merge,
ver memoria `project_user_identity_model`).

> **Cómo mantener esto:** esta matriz es un *snapshot verificado contra código*
> (auditoría 2026-07-31). El código sigue siendo la autoridad. Si tocas intents
> (`handlers/intents/*`, `neto-tools.js`, `message-processor.js`, `webhook.js`) o
> páginas/APIs de la webapp (`webapp/src/app/**`), re-verifica la fila afectada aquí.
> No copiar esta tabla a otros sitios: enlazar a este doc.

## Principio de canal: "úsalo donde rinde mejor"

Hay paridad casi total entre canales. La regla NO es "solo se puede en X", es
recomendar el canal por el *momento de uso*, sin negar el otro:

- **WhatsApp** = fricción cero, en movimiento: captura de gasto/ingreso (texto, voz,
  foto de voucher), consultas rápidas, abonar deuda/meta al vuelo, resúmenes en chat.
  Es su superpoder real y su palanca de retención.
- **App** = analítico y edición fina: dashboard/gráficos, score y desglose, reporte
  PDF, export/import, edición en lote, gestión de suscripciones, editar categorías y
  % de split, configuración.
- **Neutro (ambos):** crear presupuestos/metas/deudas/espacios. El copy sugiere el
  canal por contexto ("créalo rápido por WhatsApp" vs "gestiónalo en la app").

Reglas de copy que no se negocian:
- Nunca decir que algo NO se puede en el otro canal si sí se puede.
- Sincronización: **"conéctalos = una sola cuenta"**, nunca "auto-sync".
- CASA (lectura de correos/Gmail/bancos): feature live, pero el copy **público** de la
  landing no la menciona hasta certificación. No tocar en este barrido.
- **Conectar Gmail es la excepción a "úsalo donde rinde mejor": es solo-app, a propósito.**
  No es que WhatsApp no pueda, es que no debe. Cada conexión quema uno de los 100 cupos de
  Google sobre todo el ciclo de vida del proyecto (no se restablece), así que el inventario
  se protege teniendo UNA puerta y no seis. Además el OAuth termina en un navegador igual, y
  en la app el usuario ve los bancos con checkboxes ANTES de autorizar — por WhatsApp era un
  menú numerado en dos mensajes con el estado guardado en la base entre uno y otro.
  WhatsApp responde con el deeplink correcto según identidad (`linkPanelPro` en `lib/trial.js`):
  panel si ya tiene cuenta web, link de activación firmado si es WhatsApp-only.

## Auditoría parcial del 2026-09-05: las 8 celdas que PROMETÍAN una derivación

**Esto NO es un re-snapshot completo.** El snapshot sigue siendo del 31-jul-2026 y las ~30 filas
restantes están sin cruzar. Lo que se auditó fue un subconjunto elegido por su forma: las 12 filas
con ❌, y de ellas las **8 que prometían un redirect, un link o un deeplink**. El motivo es que una
promesa de derivación incumplida no es un error de documentación: es el usuario pidiendo algo y no
recibiendo ni la función ni el camino a la función. Es la misma clase del ítem 28 del backlog.

| celda | prometía | veredicto |
|---|---|---|
| Editar/borrar en lote | "bulk redirige a app" | ✅ existe, cae a `/dashboard/transacciones` en las 2 ramas de fallo de `corregir_multiple` |
| Dashboard / gráficos | "manda link" | ✅ `/dashboard`, `/app` y el intent `ver_dashboard` |
| Reporte PDF | "manda link" | ✅ `ver_reporte` manda `/dashboard/reportes` |
| Export CSV · JSON | "manda link" | ✅ `exportar_datos` manda `/dashboard/transacciones` |
| Conectar Gmail · bancos | "responde con deeplink" | ✅ `mensajeConectarEnLaApp` + `linkPanelPro`, con fallback si falta el secreto de firma |
| **Espacios: editar % split** | "redirige" | ❌ **no hay intent de editar el reparto** (los 7 de `espacios.js` no lo cubren). El link a `/dashboard/espacios` sale al unirse y al listar, no al pedirlo |
| **Categorías: editar/borrar** | "redirige a app" | ❌ **no hay redirect.** `/categorias` lista o abre el menú de agregar; cero referencias a una página de categorías en `handlers/` |
| **Eliminar cuenta (App)** | "deriva a soporte / ninguno self-serve" | ❌ **la fila estaba vieja**: `DELETE /api/cuenta` + Configuración existen desde la migración 073 (18-ago), posterior al snapshot |

**El hallazgo más caro no fue de la matriz sino del código, y la matriz tenía razón.** La fila
*"Reporte PDF | WhatsApp ❌ (manda link)"* era correcta, pero `compartir_resumen`
(`handlers/intents/reportes.js`) le daba al usuario una receta de 3 pasos cuyo paso 2 era *"Neto te
envía el PDF por WhatsApp"*, y su pitch le vendía esa capacidad a quien todavía no paga. Es
imposible por construcción: `enviarWhatsapp` solo arma mensajes de texto y de plantilla, y no hay
un solo envío de documento en el runtime. Corregido el mismo día; el detalle vive en el docblock de
ese case. **Mandar documentos por WhatsApp queda como decisión de producto**, no como bug.

Al cruzar, mira la GLOSA y la columna "Recomendado", no solo el ✅/❌: de los 3 fallos, 2 fueron de
glosa con el veredicto correcto. Y ojo con filas vecinas que suenan parecido (recategorizar una
transacción no es editar el árbol de categorías).

## Matriz

Leyenda: ✅ disponible · ⚠️ parcial/con matiz · ❌ no (o redirige al otro canal).

| Acción | App | WhatsApp | Recomendado |
|---|---|---|---|
| Registrar gasto / ingreso | ✅ manual | ✅ texto/voz/foto | **WhatsApp** (captura rápida) |
| Foto Yape/Plin (OCR) · nota de voz | ❌ | ✅ | **WhatsApp** (exclusivo) |
| Editar tx (monto/fecha/comercio/categoría) | ✅ | ✅ | Ambos |
| Borrar tx · deshacer · restaurar | ✅ | ✅ | Ambos |
| Editar/borrar en lote | ✅ | ❌ (bulk redirige a app) | **App** |
| Listar / filtrar transacciones | ✅ filtros ricos | ✅ consulta simple | App explorar · WA consulta |
| Recategorizar + regla de comercio | ✅ | ✅ ("cambia Rappi a delivery") | Ambos |
| Presupuestos: crear/consultar/borrar | ✅ | ✅ | App gestión · WA crear al vuelo |
| Presupuestos: editar | ✅ | ⚠️ re-configura (upsert), no "editar" | **App** |
| Metas (Planes): crear/aportar/editar/borrar/ver | ✅ | ✅ | WA aportar · App ver progreso |
| Meta colaborativa: invitar | ✅ | ✅ | Ambos |
| Deudas: registrar/abonar/saldar/listar/invitar | ✅ | ✅ | **WhatsApp** ("debo 200 a Juan") · App gestionar |
| Dividir gasto grupal (crea deudas) | ✅ (tab Compartidos) | ⚠️ crea, pero marcar pagos/editar en app | WA crear · App gestionar |
| Espacios: crear/invitar/unirse/gasto/liquidar | ✅ | ✅ | Ambos |
| Espacios: editar % split · split-rules (Pro) | ✅ | ❌ **sin redirect al pedirlo** | **App** |
| Categorías: crear (auto) | ✅ CRUD | ⚠️ auto-crea + `/categorias` | App para CRUD |
| Categorías: editar/borrar | ✅ | ❌ **sin redirect: no hay ninguno** | **App** |
| Suscripciones: ver | ✅ | ✅ consulta | App |
| Suscripciones: renombrar/ocultar/marcar plan/dividir cargo | ⚠️ vía overrides | ❌ | **App** (exclusivo) |
| Dashboard / gráficos / calendario | ✅ | ❌ (manda link) | **App** (exclusivo) |
| Neto Score: ver | ✅ | ✅ | App (visual) |
| Neto Score: desglose/tips/historial | ✅ (Pro) | ✅ (Pro; historial 1m free) | App |
| Reporte PDF | ✅ (Pro) | ❌ (manda link) | **App** |
| Export CSV (Pro) · JSON (free) | ✅ | ❌ (manda link) | **App** |
| Import Excel/CSV | ✅ (Pro) | ✅ (subes .xlsx al chat) | Ambos |
| Resúmenes texto (día/semana/mes) | ✅ dashboard | ✅ en chat | **WhatsApp** (rápido) |
| Consejos IA / recomendaciones (Pro) | ✅ | ✅ | Ambos |
| Alertas / detector de fugas: ver | ✅ | ✅ | Ambos |
| Poner límite de gasto | ✅ (enlaza presupuestos) | ✅ (Pro) | Ambos |
| Notificaciones: preferencias · inbox | ✅ | ✅ (toggles por comando) | App |
| Logros | ✅ (solo lectura) | ❌ | App |
| Referidos | ⚠️ muestra código, **"0/3" hardcodeado (bug)** | ✅ funcional (progreso real) | WA hoy · arreglar app |
| Vincular WhatsApp ↔ web (OTP) | ✅ genera código | ✅ pega `NETO-XXXXXX` | Ambos (flujo cruzado) |
| Editar perfil (nombre) | ✅ | ✅ | App |
| Comprar/activar Pro | ✅ sube comprobante | ✅ envía captura | App · WA (aprueba humano) |
| Conectar Gmail / elegir bancos (Pro) | ✅ OAuth + multiselect | ❌ responde con deeplink | **Solo app** · copy público = CASA, no tocar |
| Escanear correos ahora (Pro) | ❌ | ✅ `/escanear` | WhatsApp |
| Eliminar cuenta | ✅ Configuración (`DELETE /api/cuenta`) | ✅ menú confirmación | **Ambos self-serve** (migr. 073, 18-ago) |

## Exclusivos por canal (resumen)

- **Solo WhatsApp:** captura por foto de voucher (OCR) y por nota de voz.
- **Solo App:** dashboard/gráficos/calendario, reporte PDF, export CSV/JSON, edición
  en lote, gestión de suscripciones (renombrar/ocultar/marcar/dividir cargo), editar
  categorías, editar % de split, logros.
- **Sorpresa:** importar histórico Excel también funciona por WhatsApp (subir `.xlsx`
  al chat).

## Deuda técnica detectada en la auditoría (no es copy)

- ~~`webapp .../configuracion` Referidos: contador **"0 / 3" hardcodeado**
  (`page.tsx:1041`) y `referralCode = user.id.slice(0,8)`~~ **RESUELTO (2026-07-31,
  rediseño dos-lados)**: la webapp lee `GET /api/user/referrals` (ref_code real +
  invitados/referidos Pro/meses). El programa pasó a modelo DOS LADOS: 1 referido que
  se hace Pro pagado = 1 mes gratis al referrer, y el referido estrena Pro a 50% off su
  primer mes (S/5). Disparo por conversión Pro pagada en `lib/pro-payment:activarPro`
  (no por uso). Mini-landing `neto.pe/r/CODE`.

## Historial de alineación de copy (2026-07-31)

Barrido de copy por canal contra esta matriz. Corregido:
- `transacciones/page.tsx`: botón "Agregar manual" estaba muerto (`href:'#'`) →
  `onClick: openCreate('gasto')`; descripción reencuadrada a "por WhatsApp o a mano".
- `welcome-modal.tsx` (slide 1 onboarding): de WhatsApp-only a "por WhatsApp o desde
  la app".
- `reportes/page.tsx`: empty state "registra por WhatsApp" → "por WhatsApp o desde la app".
- `login/page.tsx`: "una sola cuenta, sincronizada" → "una sola cuenta con tus datos
  en los dos lados" (evita implicar auto-sync).

Correctos (no se tocaron): empty states de `presupuestos`, `suscripciones`, `score`,
`planes`, `espacios`, `deudas`; banner de conexión WhatsApp; `pro-gate`;
`onboarding-tour`; checklist del dashboard; copy de sync en `configuracion` y FAQ landing.
