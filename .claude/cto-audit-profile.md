# cto-audit profile — Neto

Perfil de proyecto que el motor global `cto-audit` auto-carga en la Fase 1 (RECON). Trae
lo que es específico de Neto y que el motor genérico no puede derivar solo. Todo lo demás
lo maneja el motor.

## Stack y deployables

| Componente | Framework | Hosting | URL prod | Auth |
|------------|-----------|---------|----------|------|
| Landing | Next.js 16 static export + Framer Motion | Cloudflare Pages | https://neto.pe | pública |
| Webapp | Next.js 16 + TS + shadcn/ui + Recharts | Vercel | https://app.neto.pe | Supabase Auth (Google OAuth + magic link, passwordless) |
| Backend/API | Node + Express + OpenAI + Meta Cloud API | Railway | https://api.neto.pe | Bearer admin (ADMIN_KEY) + webhook HMAC |
| DB | Supabase (PostgreSQL + Auth + RLS) | — | project id `zvorjqlubmfrjtkbhqcx` | RLS deny-all documentado + policies en tablas leídas con anon key |

Stacks del motor a cargar: `supabase.md`, `vercel.md`, `cloudflare-pages.md`, `railway.md`.

Health check manual:
```bash
curl -I https://neto.pe/            # landing
curl -I https://app.neto.pe/        # webapp
curl -I https://api.neto.pe/health  # backend
```

## Dimensión extra — Consistencia Free vs Pro (propia de Neto)

El gating de features Pro-only vive en 4 fuentes que se desincronizan en silencio.
Verificá que cada feature Pro-only esté alineada en las 4:

1. `webapp/PRICING-PLAN.md` — fuente de verdad de qué es Pro.
2. `webapp/src/lib/plan.ts` — array `PRO_ONLY_FEATURES` + `canAccess()`.
3. `products/neto/landing/src/components/landing/Pricing.tsx` — lo que el usuario ve (repo neto-landing).
4. Backend `handlers/intents/` — llamadas a `checkProWall` / `checkProLimit`.

Para cada feature Pro-only confirmá: backend con gate (`checkProWall`/`checkProLimit`),
webapp con gate (`ProGate` / `canAccess()`), y landing que la muestra bien en la tabla de
precios. Un gap = feature prometida sin enforcement (ALTO: fuga de valor Pro) o mostrada y
no entregada (MEDIO: promesa incumplida). Reportalos como su propia sub-sección en la
síntesis.

## Harness E2E (ya construido)

`products/neto/app/qa-e2e/qa-login.mjs` — verificación autónoma del flujo autenticado sin
magic link: password grant a Supabase → forja cookie `sb-<ref>-auth-token` (`base64-` +
base64url del session, chunked) → Playwright maneja `/dashboard` → veredicto PASS/FAIL
(dashboard con data real sin bounce, persistencia de cache, buster keyed al user, logout
purga cache + cookie). Creds del test user en `~/.config/neto/qa.env` (fuera del repo,
nunca imprimir). Correr con `node qa-e2e/qa-login.mjs`. Es el harness de la Fase 5 del
motor — en Neto ya existe, no hay que construirlo.

## Descartado por decisión (para el barrido — no re-flaggear)

- **Leaked-password protection (Supabase) OFF**: la auth es passwordless (Google OAuth +
  magic link). No aplica. Cosmético. No es un pendiente.
- **Waterfall client-side / no-RSC en la webapp**: revisar si sigue vigente. En el audit
  de referencia (2026-07-08) la performance de la webapp quedó **resuelta** (shell estático
  sin force-dynamic, user hidratado, score persistido, persistencia React Query con purge
  en logout). Confirmá contra el ledger antes de re-levantarlo.
- **Performance de la landing (P1–P4 del audit de referencia)**: descartada por decisión.

## Notas de RECON específicas

- Restricción CASA: no mencionar email parser / Gmail API en superficies públicas (no es
  hallazgo técnico, es de producto — ignorar en la auditoría de seguridad).
- Tests backend: `npm test` en `products/neto/app` (vitest, 121 tests). El build de la
  webapp: `cd webapp && npx next build`.
- Ledgers previos: `C:/Vortik.dev/memory/audits/*_cto-audit_neto*.md` (si existen).
