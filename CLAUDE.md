# CLAUDE.md — NETO Webapp

## Contexto del Proyecto

NETO es un asistente financiero personal por WhatsApp para el mercado peruano.
- Stack: Next.js 16 + TypeScript + Tailwind + shadcn/ui + Recharts + Supabase
- Repo: github.com/FavioML/FinBot
- Backend: C:\Neto.pe (NO esta en esta carpeta)
- Produccion webapp: app.neto.pe (Vercel)
- Supabase project: zvorjqlubmfrjtkbhqcx
- Numero WhatsApp produccion: +51 933 014 505

## Arquitectura del backend (referencia)
- `index.js` — core (~2245 lineas: webhook, NLP 23 intenciones, router)
- `gmail.js` — OAuth2 + parsers de correos bancarios (11 bancos)
- `reporte_html.js` — reportes HTML/PDF con Chart.js
- `lib/` — 11 modulos: config, constants, validators, formatters, dates, db, ai, logger, whatsapp, admin-notify, error-monitor
- `services/` — 3 modulos: transactions, budget, parsers

## Infraestructura
- Railway: backend online, 22+ variables configuradas, health endpoint /health
- Supabase: RLS activo en todas las tablas, 11 tablas
- Vercel: webapp app.neto.pe con Google OAuth
- CI/CD: GitHub Actions (test en push/PR, Node 20)
- Tests: 56 tests automatizados (vitest)
- Logging: Pino con redaccion de secrets

## Funcionalidades principales (19)
1. Registro WhatsApp (onboarding 4 pasos)
2. Lectura automatica correos bancarios (11 bancos)
3. Clasificacion gastos con IA (GPT-4o-mini, 23 intenciones NLP)
4. Categorias/subcategorias personalizables
5. Presupuestos por categoria con alertas
6. Multimoneda USD/PEN (tipo de cambio dolar.pe)
7. Lectura imagenes Yape/Plin (GPT-4o Vision)
8. Carga masiva Excel/CSV
9. Dashboard web interactivo (Recharts)
10. Reportes HTML con graficos + PDF descargable
11. Freemium/premium (S/10/mes, pagos Yape)
12. Referidos (3 activos = 1 mes Pro)
13. Resumen diario/semanal/mensual con IA
14. Aprendizaje por comercio (fuzzy match)
15. Multiples cuentas Gmail
16. Recordatorios diarios (8pm Lima)
17. Metas de ahorro con CRUD
18. Calendario financiero interactivo
19. PWA + onboarding tour

## Seguridad
- RLS en todas las tablas Supabase
- Rate limiting: 300 req/min global, 10/min admin
- Validacion de montos (NaN, Infinity, negativos, >999999.99)
- Dedup hash (MD5), ADMIN_KEY sin fallback hardcodeado
- Error handling centralizado + notificaciones admin WhatsApp

## Pendientes activos
- [ ] Sync notificaciones webapp <> WhatsApp
- [ ] Diferenciacion Plan Pro (features exclusivas reales vs Free)
- [ ] Testimonios reales
- [ ] Video demo 30-60s
- [ ] Exit-intent popup con lead magnet
- [ ] Blog posts comparativos SEO
- [ ] Activar social media (3x/semana IG + 2x/semana TikTok)
- [ ] Verificacion de negocio en Meta (manual)
- [ ] Modularizar mas index.js (600+ lineas pendientes)

## Convenciones criticas
- Archivos grandes (>10KB): editar con Edit tool, nunca reescribir completo
- Encoding: siempre UTF-8 sin BOM
- Git push: siempre desde terminal del usuario
- Verificar duplicados (grep) antes de aplicar cualquier patch
- Patches secuenciales, nunca paralelos al mismo archivo
- Variables de entorno: gestionar en Railway, nunca hardcodear

## Principios
- **Simplicidad:** Impacto minimo en el codigo
- **Causas raiz:** No soluciones temporales
- **Verificar:** Nunca marcar tarea como completa sin demostrar que funciona
