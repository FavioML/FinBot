# NETO — Task Board

## Estado del proyecto (20 Mar 2026)
Railway: ✅ online | Supabase: ✅ RLS activo | GitHub: pendiente git push limpio

---

## 🔴 BLOQUEANTE — Hacer primero

- [ ] **Git sync limpio**: `git rebase --abort && git fetch origin && git reset --hard HEAD && git push --force origin main`
  - El index.js local (1423 líneas, árbol canónico) es la fuente de verdad
  - GitHub tiene commits huérfanos del 18/3 que deben quedar atrás

---

## 🟠 Issues técnicos pendientes (del diagnóstico)

- [ ] **Fusión usuarios duplicados Supabase**
  - Existe "51970398192" (16 tx) y "whatsapp:+51970398192" (6 tx) — mismo número, dos perfiles
  - SQL: migrar txs/presupuestos/categorías del viejo al nuevo, eliminar viejo
  - El normalizador ya está en el código, solo falta la migración de datos

- [ ] **Soporte de ingresos**
  - Manual: "mi sueldo fue S/4500" → registrar como tipo=ingreso
  - Automático: parsear correos de "abono", "depósito recibido", "transferencia entrante"
  - El reporte ya tiene el campo totalI pero siempre da 0 sin esto

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

- [ ] **Precio en mensajes premium**
  - Varios mensajes dicen "S/ 9.90/mes" — el precio correcto es S/10/mes o S/99/año
  - Buscar y reemplazar en index.js

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
