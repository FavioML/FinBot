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
| Espacios: editar % split · split-rules (Pro) | ✅ | ❌ (redirige) | **App** |
| Categorías: crear (auto) | ✅ CRUD | ⚠️ auto-crea + `/categorias` | App para CRUD |
| Categorías: editar/borrar | ✅ | ❌ (redirige a app) | **App** |
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
| Conectar Gmail / elegir bancos (Pro) | ✅ OAuth | ✅ link | Ambos · **copy público = CASA, no tocar** |
| Eliminar cuenta | ❌ (deriva a soporte) | ⚠️ menú confirmación | Ninguno self-serve |

## Exclusivos por canal (resumen)

- **Solo WhatsApp:** captura por foto de voucher (OCR) y por nota de voz.
- **Solo App:** dashboard/gráficos/calendario, reporte PDF, export CSV/JSON, edición
  en lote, gestión de suscripciones (renombrar/ocultar/marcar/dividir cargo), editar
  categorías, editar % de split, logros.
- **Sorpresa:** importar histórico Excel también funciona por WhatsApp (subir `.xlsx`
  al chat).

## Deuda técnica detectada en la auditoría (no es copy)

- `webapp .../configuracion` Referidos: contador **"0 / 3" hardcodeado**
  (`page.tsx:1041`) y `referralCode = user.id.slice(0,8)`; no refleja referidos
  reales. El tracking real de referidos vive en el backend (`intents/premium.js:ver_referidos`).
  → Cablear la webapp al dato real o quitar el contador falso.

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
