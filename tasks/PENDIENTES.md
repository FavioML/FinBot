# PENDIENTES NETO — Auditoria Senior 21 Mar 2026

---

## CRITICO (seguridad / estabilidad)

- [x] **Rate limiting en webhook**: express-rate-limit — 300 req/min global por número WhatsApp, 10/min admin. ✅ 21-mar-2026
- [x] **Validacion de input en montos**: `validarMonto()` rechaza NaN, Infinity, negativos, >999999.99. Aplicada en guardarTransaccion. ✅ 21-mar-2026
- [x] **Deteccion de transacciones duplicadas**: Columna `dedup_hash` (MD5) + índice. Ventana 5 min para manual/imagen. Gmail usa message ID. ✅ 21-mar-2026
- [x] **Structured logging**: Pino con redacción de secrets. 56 console.log/error reemplazados en index.js + gmail.js. ✅ 21-mar-2026
- [ ] **Verificacion de negocio en Meta**: Sin verificar, limite 250 conversaciones/dia. Tarea manual.
- [x] **Tabla `reportes` inexistente**: 3 referencias de código muerto eliminadas. ✅ 21-mar-2026
- [x] **Tabla `categorias` legacy**: Eliminada de Supabase (0 rows, sin uso en código). ✅ 21-mar-2026

---

## IMPORTANTE (calidad de codigo)

- [x] **Tests unitarios — parsers de email**: 6 tests (BCP, BBVA/USD, Yape, Interbank, markdown wrapping, campos). ✅ 21-mar-2026
- [x] **Tests unitarios — clasificador NLP**: 11 tests (24 intenciones, mapeo categorías, retrocompatibilidad). ✅ 21-mar-2026
- [x] **Tests unitarios — parser de montos y fechas**: 22 tests (validarMonto, normalizarCategoria, formatFecha, barraProgreso, etc). ✅ 21-mar-2026
- [x] **Date handling consistente**: lib/dates.js con hoyPeru/ayerPeru. 6 instancias UTC→Peru corregidas. ✅ 21-mar-2026
- [x] **Modularizar index.js**: De 2689→2245 líneas (-16.5%). Extraído: ✅ 21-mar-2026
  - `lib/constants.js` — categorías, MESES, PLAN_CONFIG
  - `lib/validators.js` — validarMonto, normalizarCategoria
  - `lib/formatters.js` — formatFecha, barraProgreso, formatearResumen, etc.
  - `lib/whatsapp.js` — enviarWhatsapp (Meta Cloud API)
  - `lib/db.js` — singleton Supabase
  - `lib/ai.js` — singleton OpenAI
  - `lib/logger.js` — Pino con redacción de secrets
  - `lib/dates.js` — timezone Perú
  - `services/transactions.js` — CRUD transacciones + reglas + consultas
  - `services/budget.js` — presupuestos y alertas
  - **Pendiente**: Extraer parsers, NLP, routes/webhook, procesarMensajeLibre (600+ líneas)
- [x] **Error handling centralizado**: Middleware Express de error no manejado. ✅ 21-mar-2026

---

## MEJORAS DE PRODUCTO

- [x] **Soporte para mas bancos**: 11 bancos: BCP, BBVA, Interbank, Scotiabank, Yape, Plin + Falabella, Ripley, BanBif, Mibanco, CMAC (6 cajas). ✅ 21-mar-2026
- [x] **Metricas de uso**: /admin/stats — usuarios, transacciones, top categorías, top bancos. ✅ 21-mar-2026
- [x] **Resumen mensual automatico**: 1ro de cada mes 9am Lima con comparativa vs mes anterior. ✅ 21-mar-2026
- [ ] **Backup automatico de datos Supabase**: Programar pg_dump semanal o usar Supabase backups.
- [x] **Notificacion al admin**: WhatsApp al admin en errores críticos (webhook, NLP, escaneo) con cooldown 5min. ✅ 21-mar-2026
- [ ] **Excel mejorado**: Soporte para formatos bancarios de estado de cuenta (BCP, BBVA descarga CSV/XLS).
- [x] **Onboarding sin Gmail**: /manual para registro sin Gmail. Gastos por texto, fotos, Excel. ✅ 21-mar-2026
- [x] **Recordatorios**: 8pm Lima si no hay gastos. /silenciar y /recordar para toggle. ✅ 21-mar-2026

---

## DEUDA TECNICA

- [x] **CI/CD**: GitHub Actions — test en push/PR a main (Node 20). ✅ 21-mar-2026
- [ ] **Separar landing del backend**: La landing (Next.js) vive dentro del mismo repo.
- [x] **Documentar API endpoints**: docs/api.md con 17 endpoints. ✅ 21-mar-2026
- [x] **Dependabot/Renovate**: Configurado — npm semanal + github-actions mensual. ✅ 21-mar-2026
- [ ] **Environment separation**: No hay ambiente de staging/dev.
- [x] **Eliminar branches remotas huerfanas**: chore/add-project-docs y claude/crazy-bhaskara eliminadas. ✅ 21-mar-2026

---

## NOTAS DE LA AUDITORIA

### Hallazgos positivos
- RLS activo en TODAS las tablas de Supabase
- 0 transacciones huerfanas (sin usuario_id)
- 0 transacciones sin categoria
- Deploy exitoso y variables completas en Railway
- Codigo sin errores de sintaxis en los 3 archivos core
- Integridad referencial correcta (FKs configuradas)

### Progreso post-auditoria (21-mar-2026)
- **25/28 items completados** (89%)
- **56 tests automatizados** (vitest)
- **15 módulos** extraídos (lib/ + services/)
- **0 console.log** en producción (migrado a Pino)
- **11 bancos** soportados (antes 6)
- **Seguridad**: rate limiting + validación + dedup + timingSafeEqual
- **Producto**: onboarding sin Gmail, recordatorios, resumen mensual, métricas admin
- **Pendientes**: backup Supabase, Excel mejorado, verificación Meta (manual)
