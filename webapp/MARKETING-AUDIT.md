# Marketing Audit — neto.pe

**URL:** https://neto.pe
**Date:** 2026-03-24
**Composite Marketing Score:** 53/100

---

## Executive Summary

Neto tiene un producto sólido con diferenciadores reales (lectura automática de correos de 11 bancos peruanos, WhatsApp-native, dashboard web), pero su motor de go-to-market aún no está construido. La landing page es visualmente atractiva y el copy tiene buena voz local, pero falla en conversión activa, SEO técnico, prueba social y mecanismos de crecimiento viral. Las mayores oportunidades de mejora están en: (1) indexación en Google, (2) diferenciación del plan Pro, (3) mecanismos de captura de leads, y (4) activación del programa de referidos.

---

## Composite Score Breakdown

| Category | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Content & Messaging | 25% | 67 | 16.75 |
| Conversion Optimization | 20% | 44 | 8.80 |
| SEO & Discoverability | 20% | 55 | 11.00 |
| Competitive Positioning | 15% | 56 | 8.40 |
| Brand & Trust | 10% | 48 | 4.80 |
| Growth & Strategy | 10% | 32 | 3.20 |
| **TOTAL** | **100%** | | **52.95 → 53** |

---

## 1. Content & Messaging — 67/100

### Strengths
- Hero headline "Ordena tu plata sin mover un dedo" es claro, coloquial y peruano
- Subheadline explica el HOW + aborda la objeción #1 (sin contraseñas bancarias)
- Copy conversacional y auténtico — "tu plata", "sin humo", "cero fricción"
- Testimonios con métricas específicas (S/2,400 ahorrados, -40% gastos hormiga)
- FAQ con 14 preguntas en 4 categorías
- Tono consistente ("amigo que sabe de finanzas")

### Gaps
- **Social proof débil** (45/100): Sin fotos reales, sin logos de empresas, sin conteo de usuarios en landing, testimonios parecen AI-generated
- **Contenido incompleto** (55/100): No hay página de comparación vs alternativas, no hay "Quiénes somos", no hay páginas por segmento (freelancers, parejas, estudiantes)
- **CTAs genéricos** (65/100): Todo es "Empezar gratis" — no dice qué pasa después ni crea urgencia
- **Features en modo lista** en vez de beneficios emocionales

### Top Actions
1. Agregar eyebrow text "Asistente financiero por WhatsApp" sobre el H1
2. Mover conteo de usuarios a la landing hero ("100+ peruanos ya controlan su plata")
3. Mostrar logos de bancos como visual trust (no solo texto)
4. Reescribir CTAs: "Empezar gratis" → "Conecta tu banco en 2 minutos"
5. Crear página "Neto vs alternativas" (comparación SEO)

---

## 2. Conversion Optimization — 44/100

### Strengths
- Zero-friction signup: WhatsApp = 1 click, Google OAuth = 1 click
- Triple objection buster bajo CTA final ("Gratis - Sin tarjeta - Sin contraseña bancaria")
- Dual path: WhatsApp + webapp satisface diferentes perfiles

### Gaps
- **Sin CTA sticky** en scroll — una vez que el usuario pasa el hero, no hay CTA hasta pricing
- **Urgencia/escasez = 0** — sin ofertas limitadas, sin contadores, sin FOMO
- **Sin captura de email** — zero lead magnets, zero exit intent, zero retargeting
- **Sin retargeting pixels** — no Facebook Pixel, no Google Ads tag (solo GA4)
- **Pricing débil** (42/100): Free y Pro son casi idénticos (solo difieren en historial 3 meses vs ilimitado)
- **Exit intent = 0** — visitantes que se van están perdidos para siempre

### Top Actions
1. **CRÍTICO:** Agregar sticky CTA bar (mobile: bottom bar, desktop: floating button)
2. **CRÍTICO:** Agregar Facebook Pixel + Google Ads remarketing tag
3. Agregar exit-intent popup con lead magnet ("Guía de gastos hormiga Perú 2026")
4. Diferenciar plan Pro con 3-5 features exclusivas reales
5. Agregar urgencia: "Precio fundador S/10/mes — solo primeros 500 usuarios"

---

## 3. SEO & Discoverability — 55/100

### Strengths
- URLs limpias, slugs con keywords en español
- 5 blog posts bien escritos targeting long-tail peruanas
- Blog tiene Article JSON-LD schema
- Static export en Cloudflare Pages = fast TTFB
- Sitemap.xml presente con 10 URLs

### Gaps
- **CRÍTICO: El sitio NO está indexado en Google** — `site:neto.pe` retorna 0 resultados
- **Sin structured data en homepage** — no Organization, no WebSite, no FAQPage schema
- **Sin og:image** — shares en redes sociales no tienen preview
- **H1 y H2s sin keywords** — todo es copy creativo, cero "finanzas personales peru"
- **Title tag sin keywords clave** — falta "Peru" y "WhatsApp"
- **Sin cross-linking entre blog posts**
- **Blog tiene solo 5 artículos** publicados en 2 días (parece batch publish)

### Top Actions
1. **URGENTE:** Verificar dominio y enviar sitemap a Google Search Console
2. Agregar Organization JSON-LD + FAQPage schema
3. Agregar og:image a todas las páginas
4. Title tag: "Neto — Tu asistente financiero personal" → "Neto — Asistente financiero por WhatsApp | Perú"
5. Cambiar `lang="es"` → `lang="es-PE"` + agregar hreflang
6. Publicar blog content regularmente (2-4 artículos/mes)

---

## 4. Competitive Positioning — 56/100

### Competitor Landscape

| Competitor | Channel | Peru-specific | Bank Integration | Threat |
|-----------|---------|--------------|-----------------|--------|
| **FinasFinanzas** (CCL) | WhatsApp + Web | Sí | No mencionado | **ALTO** |
| Gasti | WhatsApp | No (Argentina) | No | Medio |
| Organizate BCP | App BCP | Sí | Solo BCP | Medio |
| Kodito (Kambista) | WhatsApp + Web | Sí | **CONGELADO** | Bajo* |
| Wasap Finance | WhatsApp | No | No (OCR solo) | Bajo |
| Monefy/Fintonic | App nativa | No | No en Perú | Bajo |

*Kodito podría regresar si se aprueba regulación de open finance.

### Neto's Moat
- **Único** que lee correos de 11 bancos peruanos automáticamente
- **Único** con WhatsApp + web dashboard completo
- **Único** con OCR de imágenes Yape/Plin
- Zero-friction (sin app, sin contraseñas bancarias)

### Gaps
- **Zero awareness competitiva en el sitio** (18/100) — no hay comparaciones, no hay "vs" content
- **USP enterrada** — la lectura automática de bancos debería ser el hero, no secundario
- **Sin claim de categoría** — no dice "el único" ni "el primero" explícitamente
- **Barrier messaging = 12/100** — nada aborda "¿por qué no usar mi app del banco?"

### Top Actions
1. Agregar sección "¿Por qué Neto?" con tabla comparativa visual en landing
2. Claim explícito: "El único asistente que lee tus 11 bancos peruanos automáticamente"
3. Crear blog posts de comparación ("Neto vs apps de gastos", "Neto vs app del banco")
4. Agregar FAQ: "Ya uso Monefy, ¿por qué cambiar?" + "Mi banco ya me muestra gastos"
5. Monitorear FinasFinanzas (CCL-backed, mismo espacio Peru + WhatsApp)

---

## 5. Brand & Trust — 48/100

### Strengths
- Identidad visual consistente (dark theme, green/amber, Manrope/Inter)
- Tono peruano auténtico y memorable
- "Hecho en Perú" badge + pricing en soles
- "Sin contraseña bancaria" repetido estratégicamente

### Gaps
- **Testimonios parecen fabricados** — misma estructura, métricas redondas, sin fotos, sin identidades verificables
- **Sin presencia social activa** — Instagram/TikTok/Facebook existen pero aparentan estar dormidos (<100 seguidores)
- **Sin validación terceros** — sin prensa, sin logos "as seen in", sin reviews
- **Sin página "About/Equipo"** — ¿quién está detrás? Crítico para producto financiero
- **Brand name SEO** — "neto peru" en Google retorna calculadoras de salario neto, no el producto

### Top Actions
1. Reemplazar testimonios fabricados con reales (o eliminarlos)
2. Agregar sección "Seguridad" con detalles técnicos (encriptación, OAuth, RLS, solo lectura)
3. Agregar bio del fundador/equipo — mínimo 1 foto + 1 párrafo
4. Activar social media: 3x/semana Instagram + 2x/semana TikTok
5. Crear video demo 30-60s mostrando la experiencia WhatsApp + dashboard

---

## 6. Growth & Strategy — 32/100

### Strengths
- WhatsApp como canal = retención alta natural (no hay app que olvidar)
- Resúmenes automáticos diarios/semanales crean habit loops
- Score financiero gamifica el engagement
- Referral program existe en el producto

### Gaps
- **Referral program invisible** (15/100) — no aparece en landing, blog, ni FAQ
- **Sin email capture** — zero lista de leads para nurturing
- **Sin viral mechanics** — no hay contenido shareable, no hay "Spotify Wrapped" de finanzas
- **Sin expansion revenue** — un solo tier Pro, sin family/business plan
- **Social media dormida** — cero canal de adquisición orgánica activo
- **Zero paid acquisition** — sin ads, sin retargeting

### Top Actions
1. **Hacer visible el referral program** en landing + webapp + WhatsApp bot (doble incentivo)
2. Agregar email capture con lead magnet (guía PDF, checklist)
3. Crear "Neto Wrapped" mensual — imagen shareable con score + stats del mes
4. Considerar plan Family (S/25/mes, 3 miembros) y Freelancer (IGV, facturas)
5. Publicar en Product Hunt + directorios de startups para backlinks iniciales

---

## Top 10 Highest-Impact Actions (Ranked)

| # | Action | Category | Impact | Effort |
|---|--------|----------|--------|--------|
| 1 | **Verificar dominio en Google Search Console + enviar sitemap** | SEO | CRÍTICO | 15 min |
| 2 | **Agregar Facebook Pixel + Google Ads tag** | Conversion | ALTO | 30 min |
| 3 | **Agregar sticky CTA bar en scroll** | Conversion | ALTO | 1-2 hrs |
| 4 | **Diferenciar plan Pro** (3-5 features exclusivas reales) | Growth | ALTO | 1 día |
| 5 | **Hacer visible el referral program** en landing + bot | Growth | ALTO | 2-3 hrs |
| 6 | **Agregar Organization + FAQPage JSON-LD schema** | SEO | ALTO | 1 hr |
| 7 | **Agregar og:image + social preview** | SEO/Brand | ALTO | 30 min |
| 8 | **Reemplazar testimonios con reales** o agregar sección Seguridad detallada | Trust | ALTO | 1-2 hrs |
| 9 | **Agregar sección comparativa "¿Por qué Neto?"** en landing | Competitive | MEDIO | 2-3 hrs |
| 10 | **Crear video demo 30-60s** (WhatsApp + dashboard) | Brand/Conv | MEDIO | 1 día |

---

## Score Context

| Score Range | Meaning |
|-------------|---------|
| 80-100 | Optimizado — mejoras marginales |
| 60-79 | Buena base — oportunidades claras |
| 40-59 | **← Neto está aquí (53)** — fundamentos sólidos, motor de crecimiento sin construir |
| 20-39 | Necesita trabajo significativo |
| 0-19 | Reconstrucción necesaria |

**Bottom line:** Neto tiene un producto diferenciado y una landing bien diseñada, pero opera como un folleto pasivo. No hay mecanismos activos de captura, conversión, o crecimiento viral. Las 3 acciones más urgentes son: (1) indexarse en Google, (2) agregar retargeting pixels, y (3) diferenciar el plan Pro. Con estas correcciones, el score puede subir a 65+ en 2-4 semanas.

---

*Audit generated by AI Marketing Suite — 5 parallel analysis agents*
*Model: Claude Opus 4.6 | Date: 2026-03-24*
