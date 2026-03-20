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

- [ ] **Dashboard web neto.pe**
  - Página simple con gráfico de gastos últimos 3 meses
  - Acceso via token temporal enviado por WhatsApp (ya existe el patrón en /reporte/:id)
  - No requiere login nuevo

- [ ] **Sistema de referidos**
  - Comando /referir genera link único con ref_code del usuario
  - Tabla referidos en Supabase: ref_code, usuario_id, usos, creado_at
  - Incentivo: 3 invitados activos = 1 mes Pro gratis (activación automática)

- [ ] **Verificación negocio Meta**
  - Sin verificar: límite 250 conversaciones/día
  - Requiere: RUC, documento comercial, URL neto.pe
  - Hacerlo en Meta Business Manager (manual, no código)

---

## 🟡 Mejoras de producto

- [ ] **Ingresos en reporte HTML**
  - El `totalI` del reporte siempre es 0 porque no hay datos de ingresos
  - Bloqueado por: soporte de ingresos (arriba)

- [ ] **Categorías_usuario legacy**
  - La tabla categorias_usuario tiene 174 filas con el árbol viejo (Comida, Auto, Streaming...)
  - Migrar al árbol canónico nuevo (Alimentación, Transporte, Vivienda...)
  - SQL de migración preparado, ejecutar después de validar árbol canónico

- [ ] **Alerta de gasto inusual**
  - Detectar cuando un comercio tiene un gasto >2x su promedio histórico
  - Agregar al mensaje de alerta inmediata: "Es el más alto que registras ahí"

- [x] **Precio en mensajes premium** — todos actualizados a S/10/mes ✅

---

## 🟢 Preparación para escala (cuando haya usuarios reales)

- [ ] Google OAuth aprobación — verificar estado en Google Cloud Console
- [ ] node.js actualizar de v18 a v20 en package.json (warnings de Supabase SDK)
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
