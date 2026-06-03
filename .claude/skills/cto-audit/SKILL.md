# CTO Audit — Neto

Auditoría exhaustiva de nivel CTO senior para verificar que el producto está listo para producción, demos a empresas o lanzamientos. Cubre backend, webapp, landing, base de datos y consistencia de planes.

## Cuándo usar
- Antes de presentaciones a empresas o inversores
- Después de implementar múltiples features nuevas
- Auditorías periódicas de calidad (mensual recomendado)
- Antes de un launch o anuncio público

## Ejecución

### Fase 1: Checks automatizados (paralelo)
Ejecutar en paralelo:
1. **Tests backend**: `cd C:\Vortik.dev\products\neto\app && npm test` (vitest, 56+ tests)
2. **Supabase check**: Usar skill `/supabase-check` o verificar manualmente:
   - Proyecto activo (ID: zvorjqlubmfrjtkbhqcx)
   - Todas las tablas con RLS activo
   - Conteos de registros clave
3. **Build webapp**: `cd webapp && npx next build` (debe compilar sin errores)

### Fase 2: Auditoría de seguridad
Lanzar agentes en paralelo para verificar:

**Backend (C:\Vortik.dev\products\neto\app):**
- Middleware auth: verificar que NO hay early return en `webapp/middleware.ts`
- OpenAI calls: verificar timeout en `services/neto-gpt.js`
- Gmail tokens: verificar cifrado en `services/gmail.js`
- Input validation: verificar longitud en handlers de intents
- Rate limiting: verificar en `index.js`
- ADMIN_NUMBER: verificar que viene de env var

**Webapp (webapp/):**
- `force-dynamic` en todas las páginas dashboard
- Error boundaries (`error.tsx`) en secciones del dashboard
- Null safety en accesos a `user.plan`
- QueryClient singleton (no recreado por render)
- Loading/empty states en listas

**Landing (C:\Vortik.dev\products\neto\landing):**
- sitemap.xml incluye todas las páginas y blog posts
- robots.txt existe y es correcto
- Links funcionales (WhatsApp, app.neto.pe, FAQ, legal)
- Meta tags y JSON-LD en blog posts

### Fase 3: Consistencia Free vs Pro
Verificar alineación entre 4 fuentes:
1. `webapp/PRICING-PLAN.md` — Fuente de verdad
2. `webapp/src/lib/plan.ts` — PRO_ONLY_FEATURES array
3. `landing/src/components/landing/Pricing.tsx` — Lo que el usuario ve
4. Backend `handlers/intents/` — checkProWall/checkProLimit calls

Para cada feature Pro-only, verificar que:
- El backend tiene gate (`checkProWall` o `checkProLimit`)
- La webapp tiene gate (`ProGate` component o `canAccess()` check)
- La landing lo muestra correctamente en la tabla de precios

### Fase 4: Reporte
Generar reporte con:
1. **Estado general** (tests, build, DB)
2. **Fixes aplicados** durante la auditoría
3. **Bugs por severidad** (CRÍTICO > ALTO > MEDIO > BAJO)
4. **Gaps de Pro gating** (features prometidas sin enforcement)
5. **Tabla Free vs Pro** consolidada y verificada

### Severidades
- **CRÍTICO**: Vulnerabilidad de seguridad, data leak, auth bypass — bloquea cualquier demo
- **ALTO**: Bug que afecta funcionalidad core o datos del usuario — corregir antes del pitch
- **MEDIO**: Inconsistencia, UX pobre, race condition teórica — siguiente sprint
- **BAJO**: Mejora de mantenibilidad, SEO menor — nice to have

## Archivos clave a revisar
- `webapp/middleware.ts` — Auth middleware
- `webapp/src/lib/plan.ts` — Feature gating definitions
- `webapp/src/components/shared/pro-gate.tsx` — UI gating component
- `services/neto-gpt.js` — OpenAI integration
- `services/gmail.js` — Gmail OAuth tokens
- `services/budget.js` — Budget alerts
- `services/debts.js` — Debt payments
- `services/metas.js` — Savings goals
- `handlers/intents/` — All intent handlers (12 files)
- `landing/src/components/landing/Pricing.tsx` — Pricing display
- `landing/public/sitemap.xml` — SEO sitemap
