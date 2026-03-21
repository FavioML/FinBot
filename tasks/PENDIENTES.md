# PENDIENTES NETO — Auditoria Senior 21 Mar 2026

---

## CRITICO (seguridad / estabilidad)

- [ ] **Rate limiting en webhook**: Sin limite de mensajes por usuario. Riesgo de DDoS o abuso de API OpenAI (costo). Implementar con express-rate-limit (ej: 30 msg/min por numero).
- [ ] **Validacion de input en montos**: No se valida NaN, negativos, overflow ni montos extremos. Un usuario puede registrar S/. -999999 o "abc" como monto.
- [ ] **Deteccion de transacciones duplicadas**: Si un correo se procesa dos veces, se registran gastos duplicados. Implementar hash de deduplicacion (monto+comercio+fecha en ventana de 5 min).
- [ ] **Structured logging**: Solo usa console.log/console.error. Sin niveles, sin filtrado de secrets, sin trazabilidad. Migrar a winston o pino.
- [ ] **Verificacion de negocio en Meta**: Sin verificar, el limite es 250 conversaciones/dia. Para escalar necesita Business Verification.
- [ ] **Tabla `reportes` inexistente**: El codigo referencia `supabase.from('reportes').delete()` en las lineas 1234, 1251, 1264 (flujo de desconexion), pero la tabla no existe en Supabase. No genera error critico porque Supabase ignora deletes en tablas inexistentes, pero es codigo muerto.
- [ ] **Tabla `categorias` legacy**: Existe en Supabase (0 rows) pero el codigo usa `categorias_usuario`. Eliminar para evitar confusion.

---

## IMPORTANTE (calidad de codigo)

- [ ] **Tests unitarios — parsers de email**: Los parsers de BCP, BBVA, Interbank, Scotiabank, Yape y Plin no tienen tests. Un cambio en el formato del email bancario rompe silenciosamente la lectura.
- [ ] **Tests unitarios — clasificador NLP**: Las 23 intenciones del clasificador no se testean. Regresiones posibles al modificar el system prompt.
- [ ] **Tests unitarios — parser de montos y fechas**: El parsing de "S/. 45.50" vs "$45.50" vs "45,50" no tiene tests.
- [ ] **Date handling consistente**: Mezcla de `new Date()` (UTC) y `fechaHoyPeru()` (UTC-5). Auditar TODOS los usos y unificar a timezone Peru.
- [ ] **Modularizar index.js**: 2614 lineas en un solo archivo. Separar en modulos:
  - `routes/webhook.js` — handler de mensajes WhatsApp
  - `services/nlp.js` — clasificador de intenciones
  - `services/parsers.js` — parsers bancarios (BCP, BBVA, etc.)
  - `services/transactions.js` — CRUD de transacciones
  - `services/reports.js` — generacion de reportes
  - `services/budget.js` — presupuestos y alertas
  - `services/onboarding.js` — flujo de registro
- [ ] **Error handling centralizado**: Varios handlers carecen de try-catch completo. Implementar middleware de error de Express.

---

## MEJORAS DE PRODUCTO

- [ ] **Soporte para mas bancos**: Falabella, Ripley, BanBif, Mibanco, CMAC (cajas municipales).
- [ ] **Metricas de uso**: Cuantos mensajes/dia, usuarios activos, top categorias. Dashboard interno para admin.
- [ ] **Resumen mensual automatico**: Trigger al inicio de cada mes con comparativa mes anterior.
- [ ] **Backup automatico de datos Supabase**: Programar pg_dump semanal o usar Supabase backups.
- [ ] **Notificacion al admin**: Cuando hay errores criticos o un usuario reporta un problema.
- [ ] **Excel mejorado**: Soporte para formatos bancarios de estado de cuenta (BCP, BBVA descarga CSV/XLS).
- [ ] **Onboarding sin Gmail**: Permitir registro manual sin conectar Gmail (solo gastos manuales + imagenes).
- [ ] **Recordatorios**: "No has registrado gastos hoy" o "Tu presupuesto de Comida esta al 80%".

---

## DEUDA TECNICA

- [ ] **CI/CD**: GitHub Actions para lint + tests en cada push. Actualmente no hay CI.
- [ ] **Separar landing del backend**: La landing (Next.js) vive dentro del mismo repo y se sirve como archivos estaticos por Express. Separar en repo/servicio independiente.
- [ ] **Documentar API endpoints**: Los endpoints existentes no estan documentados:
  - `GET /` — health check
  - `GET /health` — health check detallado
  - `POST /webhook` — WhatsApp webhook
  - `GET /webhook` — verificacion Meta
  - `GET /dashboard/:id` — dashboard interactivo
  - `GET /r/:code` — referido redirect
  - `GET /api/reporte/:id` — API de datos del reporte
  - `GET /oauth/callback` — callback OAuth Gmail
  - `POST /admin/activar` — activar usuario premium
  - `GET /admin/pagos` — listar pagos pendientes
- [ ] **Dependabot/Renovate**: Dependencias sin actualizacion automatica. Express 5.2.1, OpenAI 6.27.0, etc.
- [ ] **Environment separation**: No hay ambiente de staging/dev. Todo va directo a produccion.
- [ ] **Eliminar branches remotas huerfanas**: `origin/chore/add-project-docs` y `origin/claude/crazy-bhaskara` siguen en GitHub.

---

## NOTAS DE LA AUDITORIA

### Hallazgos positivos
- RLS activo en TODAS las tablas de Supabase
- 0 transacciones huerfanas (sin usuario_id)
- 0 transacciones sin categoria
- Deploy exitoso y variables completas en Railway
- Codigo sin errores de sintaxis en los 3 archivos core
- Integridad referencial correcta (FKs configuradas)

### Hallazgos de riesgo
- index.js tiene 2614 lineas — dificil de mantener y testear
- Sin tests automatizados — cualquier cambio puede romper funcionalidad silenciosamente
- Sin rate limiting — vulnerable a abuso de APIs costosas (OpenAI)
- Logging primitivo — dificil diagnosticar problemas en produccion
- Sin CI/CD — deployments manuales sin validacion automatica
