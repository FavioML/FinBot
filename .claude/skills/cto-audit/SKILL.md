---
name: cto-audit
description: >-
  Auditoría técnica CTO-grade de Neto (landing neto.pe + webapp app.neto.pe + backend
  api.neto.pe + Supabase) antes de un demo, pitch a empresas/inversores o launch. Úsala
  cuando el usuario pida "audita Neto", "revisa que Neto esté listo para prod/demo",
  "chequeo técnico completo de app.neto.pe", "está sólido Neto", "auditoría CTO/senior de
  Neto", "revisa seguridad y performance de la webapp/landing", o un barrido de estado de
  una auditoría previa. Es el override local de Neto sobre la skill global cto-audit:
  corre el mismo motor stack-adaptive y le suma el profile de Neto (consistencia Free-vs-Pro,
  harness E2E autenticado). NO es para code review de un diff (/code-review), QA visual
  (/design-review) ni SEO (/seo).
---

# CTO Audit — Neto (override del motor global)

Esta skill NO reimplementa la auditoría: **delega en el motor global `cto-audit`**
(`~/.claude/skills/cto-audit/SKILL.md`) y le añade lo que es específico de Neto. El motor
es genérico y stack-adaptive; Neto solo aporta su perfil.

## Cómo correrla

1. **Leé y seguí el motor global**: `~/.claude/skills/cto-audit/SKILL.md` y sus
   `references/`. Todas las fases (RECON en vivo, fan-out de agentes, síntesis, olas,
   modos, tiers) vienen de ahí. No dupliques ese contenido acá.
2. **En la Fase 1 (RECON), cargá el profile de Neto**:
   `products/neto/app/.claude/cto-audit-profile.md`. Trae las dimensiones extra y los
   datos de stack de Neto (3 deploys, Supabase id, harness E2E, chequeo Free-vs-Pro).
3. El stack de Neto activa estos `references/stacks/` del motor: `supabase.md`,
   `vercel.md` (webapp) y `cloudflare-pages.md` (landing). Además el backend Node en
   Railway aplica los principios de `railway.md`.

## Qué agrega Neto sobre el motor genérico

- **Dimensión extra: consistencia Free-vs-Pro** entre las 4 fuentes de gating. Detalle en
  el profile — es el check que el motor genérico no tiene porque es propio de Neto.
- **Harness E2E ya construido**: `products/neto/app/qa-e2e/qa-login.mjs` (password grant →
  cookie SSR forjada → Playwright → veredicto). El motor lo referencia como el patrón de
  `references/e2e-harness.md`; en Neto ya existe, se corre directo.

Todo lo demás (severidades, formato de hallazgo, artifact, ledger, barrido idempotente,
principio de honestidad sobre complacencia) es del motor global.
