# NETO — Task Board

## Estado del proyecto (20 Mar 2026)
Railway: ✅ online | Supabase: ✅ RLS activo | GitHub: ✅ sincronizado

---

## 🔴 BLOQUEANTE — Hacer primero

- [x] **Git sync limpio** — main local = origin/main = 22fe861 ✅

---

## 🟠 Issues técnicos pendientes (del diagnóstico)

- [x] **Fusión usuarios duplicados Supabase** — migradas 6 txs, 1 perfil eliminado → 26 txs en usuario canónico ✅

- [x] **Soporte de ingresos** — intent registrar_manual + parsearRegistroManual() + saludo muestra balance ✅

- [x] **Dashboard web neto.pe** — ruta `/dashboard/:id` + comando `/dashboard` + `generarDashboardHTML()` con Chart.js (gastos 3 meses, por categoría, top comercios). Token en reporte_cache, válido 24h ✅

- [x] **Sistema de referidos** — `/referir` genera link único `neto.pe/r/:code`. Tabla `referidos` + columna `ref_code` en usuarios. 3 referidos activos (>=3 txs) = 1 mes Pro automático ✅

- [ ] **Verificación negocio Meta**
  - Sin verificar: límite 250 conversaciones/día
  - Requiere: RUC, documento comercial, URL neto.pe
  - Hacerlo en Meta Business Manager (manual, no código)

---

## 🟡 Mejoras de producto

- [x] **Ingresos en reporte HTML** — `totalI` calcula desde `tipo=ingreso`; desbloqueado por soporte de ingresos ✅

- [x] **Categorías_usuario legacy** — tabla limpiada y reinsertada con árbol canónico: 10 categorías raíz, sin duplicados, nombres correctos (Alimentación, Vivienda, Educación, Entretenimiento...) ✅

- [x] **Alerta de gasto inusual** — ya implementada en `enviarAlertaTransaccion()` (factor >=2.5x, >S/30) ✅

- [x] **Precio en mensajes premium** — todos actualizados a S/10/mes ✅

---

## 🟢 Preparación para escala (cuando haya usuarios reales)

- [ ] Google OAuth aprobación — verificar estado en Google Cloud Console
- [x] node.js actualizar de v18 a v20 en package.json ✅
- [ ] Tests unitarios de parsers con emails bancarios fixtures
- [ ] Landing page neto.pe (actualmente sirve index.html estático)

---

## ✅ Completado (sesión 20 Mar 2026)

- [x] RLS activado en 7 tablas de Supabase (service_role key en Railway)
- [x] ADMIN_KEY sin fallback hardcodeado
- [x] Normalización número WhatsApp en obtenerOCrearUsuario()
- [x] Health endpoint /health + configurado en Railway
- [x] Historial conversación: 10000 chars (sin límite práctico)
- [x] Reportes migrados de global.reportesTemp → Supabase tabla reporte_cache
- [x] Función generarResumenSemanal duplicada eliminada
- [x] Árbol canónico de 10 categorías implementado (parser + CATEGORIAS_SUGERIDAS + system prompt)
- [x] Datos existentes en Supabase migrados al árbol canónico
- [x] Twilio variables eliminadas de Railway
- [x] SCAN_INTERVAL: 4h → 0.25h (cada 15 min) en Railway
- [x] reporte_html.js: "FinBot Peru" → "NETO"
- [x] reporte_html.js: 'Streaming'/'Hogar' → 'Entretenimiento'/'Vivienda' (categorías canónicas)
- [x] node.js >=18 → >=20 en package.json
- [x] categorias_usuario: limpieza completa + árbol canónico reinsertado (10 raíces, sin duplicados)
- [x] Sistema de referidos: tabla referidos, columna ref_code, /referir, /r/:code, auto-Pro con 3 activos
- [x] Dashboard web: /dashboard comando, /dashboard/:id ruta, Chart.js con últimos 3 meses
