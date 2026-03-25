# CLAUDE.md — NETO

## Contexto del Proyecto

NETO es un asistente financiero personal por WhatsApp para el mercado peruano.
- Stack: Node.js + Express + Supabase + OpenAI GPT-4o-mini + Meta Cloud API + Railway
- Repo: github.com/FavioML/FinBot
- Directorio: C:\Neto.pe
- Producción backend: api.neto.pe (Railway)
- Producción landing: neto.pe (Cloudflare Pages)
- Webapp (próximo): app.neto.pe
- Supabase project: zvorjqlubmfrjtkbhqcx
- Número WhatsApp producción: +51 933 014 505
- Admin WhatsApp: +51970398192

## Estado actual (24 Mar 2026)

### Arquitectura de código (modularizado)
- `index.js` — core (~2245 líneas: webhook, NLP 23 intenciones, router)
- `gmail.js` — OAuth2 + parsers de correos bancarios (11 bancos)
- `reporte_html.js` — reportes HTML/PDF con Chart.js
- `lib/` — 11 módulos: config, constants, validators, formatters, dates, db, ai, logger, whatsapp, admin-notify, error-monitor
- `services/` — 3 módulos: transactions, budget, parsers
- `scripts/backup.js` — backup semanal a GitHub Gist
- `public/` — vacío (landing eliminada del repo en commit 669af0f)

### Infraestructura
- Railway: online, 22+ variables configuradas, health endpoint /health
- Supabase: RLS activo en todas las tablas, 11 tablas
- CI/CD: GitHub Actions (test en push/PR, Node 20)
- Dependabot: npm semanal + github-actions mensual
- Logging: Pino con redacción de secrets (0 console.log en prod)
- Tests: 56 tests automatizados (vitest)
- Backup: script backup.js para pg_dump semanal

### Funcionalidades completas (19)
1. Registro por WhatsApp (onboarding 4 pasos + sin Gmail)
2. Lectura automática de correos bancarios (11 bancos: BCP, BBVA, Interbank, Scotiabank, Yape, Plin, Falabella, Ripley, BanBif, Mibanco, CMAC)
3. Clasificación de gastos con IA (GPT-4o-mini, 23 intenciones NLP)
4. Categorías/subcategorías personalizables (árbol canónico 10 raíces)
5. Presupuestos por categoría con alertas
6. Multimoneda USD/PEN (tipo de cambio dolar.pe)
7. Lectura de imágenes Yape/Plin (GPT-4o Vision)
8. Carga masiva por Excel/CSV
9. Dashboard web interactivo (Chart.js, multi-mes)
10. Reportes HTML con gráficos (3 páginas, descarga PDF)
11. Sistema freemium/premium (S/10/mes, pagos Yape)
12. Sistema de referidos (3 activos = 1 mes Pro)
13. Resumen diario (timezone Perú UTC-5)
14. Resumen semanal con IA (comparativa e insights)
15. Resumen mensual automático (1ro de cada mes)
16. Aprendizaje por comercio (reglas fuzzy match)
17. Múltiples cuentas Gmail por usuario
18. Recordatorios diarios (8pm Lima, /silenciar, /recordar)
19. Métricas admin (/admin/stats)

### Seguridad
- RLS en todas las tablas Supabase
- Rate limiting: 300 req/min global, 10/min admin
- Validación de montos (NaN, Infinity, negativos, >999999.99)
- Dedup hash (MD5) para transacciones duplicadas
- ADMIN_KEY sin fallback hardcodeado
- Error handling centralizado (middleware Express)
- Notificaciones admin por WhatsApp en errores críticos

## Pendientes actuales

### Webapp (app.neto.pe) — LIVE en producción
- [x] **Fase 1 — Setup + Login + Dashboard Overview**
  - [x] Next.js 16 + TypeScript + Tailwind + shadcn/ui + Magic UI + Recharts
  - [x] Theme "Nocturnal Precision" (dark only, glassmorphism)
  - [x] Login page con Google OAuth (Supabase Auth) + diseño "Bienvenido"
  - [x] Middleware de auth (protege /dashboard)
  - [x] Dashboard layout: sidebar + topbar + WhatsApp button
  - [x] Dashboard overview: KPI cards, donut categorías, trend chart, transacciones recientes
  - [x] Supabase Auth Google provider configurado + anon key
  - [x] Deploy a Vercel (app.neto.pe + neto-app.vercel.app)
  - [x] DNS CNAME en Cloudflare + redirect URIs en Google Cloud Console
- [x] **Fase 2 — Transacciones + Presupuestos**
  - [x] Transacciones: filtros en español, búsqueda, tabla/cards, CRUD completo, paginación con números
  - [x] Presupuestos: cards agrupadas por categoría, sub-presupuestos, CRUD completo, barras de progreso
  - [x] Categorías/subcategorías del usuario dinámicas (desde transacciones + presupuestos)
  - [x] Vista mensual + anual con selector de año dinámico
- [x] **Fase 3 — Reportes + Configuración**
  - [x] Reportes: score financiero SVG clickeable con desglose, KPIs, charts, top merchants, gasto diario
  - [x] PDF descargable con nombre "Neto - Reporte - dd-mm-yyyy.pdf"
  - [x] Configuración: perfil, plan free/premium, referidos, cuentas conectadas, cerrar sesión
- [x] **Conectado con datos reales**
  - [x] Supabase Auth vinculado a tabla usuarios (email + supabase_auth_id)
  - [x] RLS policies para webapp (SELECT, INSERT, UPDATE, DELETE)
  - [x] API routes: /api/transactions, /api/budgets, /api/user
  - [x] Avatar Google (user_metadata.avatar_url) + dropdown con logout
  - [x] Selector de mes inline (no en topbar)
  - [x] Suscripciones detectadas por catálogo (50+ servicios digitales)
  - [x] Score financiero fórmula unificada (base 75, penalties)
  - [x] Nombre real del usuario (no email)

### Pendientes webapp
- [ ] Metas de ahorro (F38) — CRUD + tabla Supabase + barra progreso
- [ ] Onboarding tour interactivo (F39) — tooltips guiados para nuevos usuarios
- [ ] PWA install prompt (F40) — manifest.json + meta tags + standalone mode

### Pendientes menores
- [ ] Verificación de negocio en Meta (manual, límite 250 conv/día)
- [ ] Modularizar más index.js (parsers, NLP, webhook — 600+ líneas pendientes)

### Completados (sesiones 20-24 Mar)
- [x] Separación landing/backend: neto.pe → Cloudflare Pages, api.neto.pe → Railway
- [x] Separación de entornos: .env.example + config validation + NODE_ENV guards
- [x] Backup automático: semanal a GitHub Gist (245KB, 9 tablas)
- [x] Validación de env vars al arrancar (lib/config.js)
- [x] .env.example documentado
- [x] Reconocimiento de ingresos en correos e imágenes + soporte Plin
- [x] Subcategorías personalizables + referidos escalable
- [x] Google Analytics 4 en landing
- [x] Blog SEO (5 artículos)
- [x] Posts fundacionales Instagram/Facebook
- [x] Sistema de monitoreo inteligente de errores
- [x] Soporte CSV bancario
- [x] Rate limiting + validación + dedup + logging Pino
- [x] CI/CD + Dependabot
- [x] 56 tests unitarios
- [x] Webapp live en app.neto.pe (Vercel) con datos reales de Supabase
- [x] Login Google OAuth + avatar + dropdown logout
- [x] Dashboard: KPIs, charts, transacciones recientes, suscripciones por catálogo
- [x] Transacciones: CRUD completo, filtros español, paginación, vista anual
- [x] Presupuestos: agrupados por categoría, sub-presupuestos, CRUD completo
- [x] Reportes: score clickeable, PDF descargable, charts interactivos
- [x] Score financiero unificado (fórmula base 75 con penalties)
- [x] Categorías/subcategorías dinámicas del usuario
- [x] Favicon NETO (reemplaza el de Vercel)
- [x] UI/UX Rounds 1-13 (38+ mejoras): animaciones, glassmorphism, toast notifications
- [x] FAB button (quick add gasto/ingreso), budget warnings, annual KPI projection
- [x] CSV export, report comparisons vs mes anterior, daily average reference line
- [x] Bulk delete transacciones, donut interactivity (click → detalle categoría)
- [x] Budget suggestions (promedio histórico), subscription inactive alerts
- [x] Score trend chart (4 meses), global search Ctrl+K (pages + transactions)
- [x] Notification preferences + appearance section en configuración
- [x] Consejo IA via /api/advice (GPT-4o-mini) con fallback rule-based
- [x] Spending heatmap (12 semanas, estilo GitHub contributions)
- [x] Métodos de pago unificados (VISA BCP → BCP Crédito, etc.)

## Convenciones críticas
- Archivos grandes (>10KB): editar con Edit tool, nunca reescribir completo
- Encoding: siempre UTF-8 sin BOM al guardar index.js
- Git push: siempre desde terminal del usuario, nunca via API de GitHub (rompe por tamaño)
- Tests: crear en tasks/tests/ con emails bancarios reales anonimizados
- Variables de entorno: gestionar en Railway, nunca hardcodear fallbacks inseguros
- Verificar duplicados (grep) antes de aplicar cualquier patch
- Patches secuenciales, nunca paralelos al mismo archivo

## Orquestación del Flujo de Trabajo

### 1. Modo Planificación por Defecto
- Entrar en modo planificación para CUALQUIER tarea no trivial (3+ pasos o decisiones arquitectónicas)
- Si algo sale mal, DETENER y replanificar de inmediato

### 2. Estrategia de Subagentes
- Usar subagentes para investigación, exploración y análisis paralelo
- Una tarea por subagente para ejecución enfocada

### 3. Bucle de Automejora
- Después de CUALQUIER corrección del usuario: actualizar tasks/lessons.md
- Revisar las lecciones al inicio de cada sesión

### 4. Verificación Antes de Finalizar
- Nunca marcar una tarea como completa sin demostrar que funciona
- Ejecutar pruebas, revisar logs, demostrar que es correcto

### 5. Corrección Autónoma de Bugs
- Cuando se reporte un bug: arreglarlo directamente
- Cero cambios de contexto requeridos del usuario

## Principios Fundamentales
- **Simplicidad Primero**: Impacto mínimo en el código
- **Sin Pereza**: Causas raíz, no soluciones temporales
- **Impacto Mínimo**: Tocar solo lo necesario
