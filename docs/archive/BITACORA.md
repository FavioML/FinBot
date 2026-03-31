# BITACORA DE DESARROLLO — NETO

**Proyecto**: NETO — Asistente financiero personal por WhatsApp
**Periodo**: 13–21 de marzo de 2026 (9 dias)
**Total commits**: 173 | **Features**: 48 | **Fixes**: 106
**Stack**: Node.js + Express + Supabase + OpenAI GPT-4o-mini + Meta Cloud API + Railway

---

## Dia 1 — 13 de marzo 2026 (7 commits): GENESIS

**Primer commit**: 16:11 — Initial commit: FinBot Peru MVP Fase 1+2

- Estructura base del proyecto Node.js/Express
- Integracion con Supabase (PostgreSQL) para persistencia
- Integracion con OpenAI GPT-4o-mini para clasificacion de gastos
- Integracion con Meta Cloud API para WhatsApp
- OAuth2 con Gmail para lectura automatica de correos bancarios
- Deploy inicial en Railway (neto.pe)
- Configuracion de RAILWAY_URL para OAuth callbacks
- Onboarding automatizado con consultas pendientes persistentes

**Funcionalidades entregadas**: Registro de usuario, lectura de correos bancarios, clasificacion basica de gastos.

---

## Dia 2 — 14 de marzo 2026 (2 commits): CATEGORIAS

- Sistema de categorias y subcategorias personalizadas por usuario
- Refactor significativo del clasificador de gastos (+203/-101 lineas en index.js)
- Optimizacion del arbol de categorias (+154/-227 lineas)

**Funcionalidades entregadas**: Categorias personalizadas por usuario con subcategorias.

---

## Dia 3 — 16 de marzo 2026 (26 commits): EXPLOSION DE FEATURES

Dia mas productivo del proyecto. Trabajo continuo de 15:05 a 23:10.

### Features principales
- **Meta Cloud API + Freemium**: modelo de negocio con plan gratuito y premium
- **NLP v2**: 15 intenciones reconocidas (transfer_money, ask_balance, set_budget, etc.)
- **Router NLP**: entiende lenguaje natural sin comandos rigidos
- **Onboarding 4 pasos**: flujo guiado de registro
- **FinBot v5**: version consolidada con NLP mejorado
- **Parsers bancarios**: BBVA, Interbank, Scotiabank, Plin, Yape
- **Sistema de pagos Yape**: activacion de premium via Yape
- **Multimoneda**: soporte USD con tipo de cambio automatico (dolar.pe)
- **Alertas inmediatas**: notificacion por transaccion + deteccion de gasto inusual
- **Resumen semanal enriquecido**: comparativa con IA e insights
- **Reporte PDF 3 paginas**: diseno aprobado con Chart.js

### Fixes criticos
- Encoding de emojis Unicode (problema recurrente en WhatsApp)
- Estructura de try-catch en webhook
- Scope de variable `from` en webhook handler
- Sintaxis de guardarTransaccion multimoneda
- Eliminacion de soporte de correos reenviados (fuente de bugs)

---

## Dia 4 — 17 de marzo 2026 (19 commits): IDENTIDAD NETO

### Rebranding completo
- Renombrado de FinBot Peru a **NETO** en todos los mensajes
- Identidad migrada: emojis, tono de voz, prompts especializados
- NETO responde con GPT en TODOS los mensajes (tono consistente)
- Historial de conversacion: NETO recuerda contexto entre mensajes
- Prompts especializados para consejos financieros y continuidad

### Infraestructura web
- Landing page publica con paginas de privacidad y terminos
- Verificacion Google Search Console
- Parser BCP debito/credito mejorado

### Fixes
- Clasificador usa historial para detectar continuacion de conversacion
- Insert transacciones con usuario_id y tipo corregido
- Filtrar correos reenviados en gmail.js
- Categorias libres con contexto automatico y recategorizar corregido

---

## Dia 5 — 18 de marzo 2026 (9 commits): SEGURIDAD Y CONSOLIDACION

### Seguridad
- **RLS (Row Level Security)** activado en todas las tablas de Supabase
- Health endpoint `/health` para monitoreo
- `ADMIN_KEY` sin fallback hardcodeado (antes tenia valor por defecto)
- Normalizacion de numeros WhatsApp (prevencion de duplicados)

### Consolidacion
- **Arbol canonico definitivo**: 10 categorias, sin duplicados
- Parser + UI + systemPrompt unificados bajo el mismo arbol
- Migracion de reportes de memoria (global.reportesTemp) a Supabase `reporte_cache`
- System prompt v3 con categorias canonicas
- Historial ilimitado (10k caracteres)
- Sitio NETO completo: landing, FAQ, privacidad, terminos

---

## Dia 6 — 19 de marzo 2026

Sin commits registrados. Dia de descanso o trabajo no commiteado.

---

## Dia 7 — 20 de marzo 2026 (32 commits): PRODUCTO COMPLETO

Dia con mas commits del proyecto. Trabajo continuo de 13:08 a 00:25.

### Documentacion
- CLAUDE.md con convenciones del proyecto
- Task board (todo.md) y lecciones aprendidas (lessons.md)

### Features de producto
- **Dashboard interactivo**: Chart.js, selector de meses, dona de categorias
- **Sistema de referidos**: /referir, auto-upgrade a Pro con 3 referidos activos
- **Soporte de ingresos manuales**: precio correcto premium
- **Lectura de imagenes**: Yape/Plin via Vision API (GPT-4o)
- **Multiples cuentas Gmail**: soporte multi-banco por usuario
- **Carga masiva por Excel**: gastos + ingresos + subcategoria
- **Sistema freemium completo**: limites de reportes, upgrade por pago o referidos
- **Aprendizaje por comercio**: reglas_comercio con emojis personalizados

### Landing page premium
- Rediseno radical: Next.js + Tailwind CSS
- Bento grid dark theme fintech
- Paginas: contacto, FAQ, mi-reporte
- Fix PDF download (html2canvas → html-to-image)

### Integraciones
- Merge PR #1 y #2 (docs del proyecto)
- Auditorias de codigo: eliminar Twilio, fix UTF-8, subcategoria sin_categoria

### Fixes criticos
- USD automatico con tipo de cambio dolar.pe
- Intent eliminar_transaccion + override regex
- Phone_number_id en request de media a Meta API
- META_ACCESS_TOKEN (no WHATSAPP_TOKEN) para descargar media
- Corregir_categoria tras registro por imagen
- Fecha invalida en meses con menos de 31 dias

---

## Dia 8-9 — 21 de marzo 2026 (12 commits): PULIDO Y AUDITORIA

### Features
- **Suscripciones por subcategoria**: deteccion mejorada
- **Resumen diario**: listar_gastos_dia con timezone Peru (UTC-5)
- **Busqueda fuzzy de comercio**: matching inteligente en reglas_comercio
- **Flujo de desconexion**: desconectar cuenta Gmail individual o todas

### Fixes
- Logo oficial de Neto en dashboard
- Historial incluye ingresos para grafico Flujo de Dinero
- Tildes en todo el dashboard (acentos faltantes)
- Fix email al agregar nueva cuenta Gmail
- Logo PNG para firma de email
- Recategorizacion con subcategoria + formato fecha/montos

### Auditoria (sesion actual)
- Verificacion de Supabase: 11 tablas, RLS en todas, 0 huerfanos
- Verificacion de Railway: deploy exitoso, 22 variables configuradas
- Verificacion de codigo: 3 archivos core sin errores de sintaxis
- Limpieza: ~40 archivos temporales eliminados, 4 carpetas, 5 branches

---

## RESUMEN POR FASES

| Fase | Dias | Tema | Commits |
|------|------|------|---------|
| 1 | 13 Mar | Genesis — MVP inicial | 7 |
| 2 | 14 Mar | Categorias personalizadas | 2 |
| 3 | 16 Mar | Explosion de features — NLP, parsers, multimoneda | 26 |
| 4 | 17 Mar | Identidad NETO — rebranding, historial, web | 19 |
| 5 | 18 Mar | Seguridad — RLS, consolidacion, canonico | 9 |
| 6 | 20 Mar | Producto completo — dashboard, referidos, imagenes | 32 |
| 7 | 21 Mar | Pulido — resumen diario, fuzzy, auditoria | 12 |

---

## ESTADO ACTUAL DE FUNCIONALIDADES

| Funcionalidad | Estado | Notas |
|---|---|---|
| Registro por WhatsApp | OK | Onboarding 4 pasos |
| Lectura automatica de correos bancarios | OK | BCP, BBVA, Interbank, Scotiabank |
| Clasificacion de gastos con IA | OK | GPT-4o-mini, 23 intenciones |
| Categorias/subcategorias personalizadas | OK | Arbol canonico 10 categorias |
| Presupuestos por categoria | OK | Set/check/reset con alertas |
| Multimoneda USD/PEN | OK | Tipo de cambio dolar.pe |
| Lectura de imagenes (Yape/Plin) | OK | GPT-4o Vision |
| Carga masiva por Excel | OK | Gastos + ingresos + subcategoria |
| Dashboard web interactivo | OK | Chart.js, multi-mes |
| Reportes HTML con graficos | OK | 3 paginas, descarga PDF |
| Sistema freemium/premium | OK | Limites + pagos Yape |
| Sistema de referidos | OK | Auto-Pro con 3 referidos activos |
| Resumen diario | OK | Con timezone Peru |
| Resumen semanal con IA | OK | Comparativa e insights |
| Aprendizaje por comercio | OK | Reglas fuzzy match |
| Multiples cuentas Gmail | OK | Hasta N cuentas por usuario |
| Flujo de desconexion | OK | Individual o total |
| Historial de conversacion | OK | NETO recuerda contexto |
| Landing page (neto.pe) | OK | Next.js + Tailwind, dark theme |
| RLS Supabase | OK | Todas las tablas protegidas |

---

## DATOS EN PRODUCCION (21 Mar 2026)

| Tabla | Registros |
|---|---|
| usuarios | 5 |
| transacciones | 261 |
| categorias_usuario | 55 |
| conversaciones | 18 |
| reporte_cache | 16 |
| presupuestos | 4 |
| reglas_comercio | 4 |
| gmail_cuentas | 1 |
| referidos | 0 |
| consultas_pendientes | 0 |
