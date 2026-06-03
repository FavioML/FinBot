@AGENTS.md

# Webapp — app.neto.pe

## Stack
- Next.js 16 + React 19 + TypeScript 5 (strict)
- Tailwind CSS v4 + shadcn/ui v4 + Magic UI
- Supabase Auth (Google OAuth) + Supabase PostgreSQL (RLS)
- React Query v5 (staleTime 5min, retry 1)
- Recharts v3 (charts), Motion v12 (animations)
- html2canvas-pro + jsPDF (export PDF)
- Sonner (toasts), Lucide (icons)

## Comandos
```bash
npm run dev      # Dev server (Turbopack)
npm run build    # Build produccion
npm run lint     # ESLint
```

## Arquitectura
```
src/
  app/                    # App Router (todas las paginas)
    layout.tsx            # Root layout (fonts, Supabase)
    auth/page.tsx         # Login Google OAuth
    dashboard/
      layout.tsx          # Sidebar + topbar + bottom-nav
      page.tsx            # Overview (KPIs, charts, widgets)
      transacciones/      # CRUD transacciones
      presupuestos/       # CRUD presupuestos
      reporte/            # Reporte PDF descargable
      metas/              # Metas de ahorro
      suscripciones/      # Deteccion automatica
      configuracion/      # Perfil, plan, referidos
    api/                  # API Routes (server-side)
      transactions/       # POST, PUT, DELETE
      budgets/            # POST, PUT, DELETE
      goals/              # POST, PUT, DELETE
      user/               # GET perfil
      advice/             # POST consejo IA (GPT-4o-mini)
      exchange-rate/      # GET tipo de cambio USD/PEN
      notifications/      # POST preferencias
      auth/callback/      # OAuth callback
  components/
    dashboard/            # Shell, sidebar, topbar, bottom-nav, KPIs
      charts/             # Donut, trend, score-gauge, heatmap
      widgets/            # Transacciones recientes, suscripciones, etc.
    shared/               # WhatsApp button
    auth/                 # OAuth button
  lib/
    supabase/client.ts    # Browser client (createBrowserClient)
    supabase/server.ts    # Server client (createServerClient + cookies)
    hooks/                # 13 React Query hooks (use-transactions, use-budgets, etc.)
    types.ts              # Interfaces TypeScript
    format.ts             # Formatters (moneda, fechas)
    constants.ts          # Constantes
    exchange-rate.ts      # Cache 1h dolar.pe
    subscriptions-catalog.ts  # 50+ servicios digitales
    validators.ts         # Validacion de inputs
```

## Patrones criticos

### Rendering dinamico obligatorio
Todas las paginas con Supabase deben usar:
```typescript
export const dynamic = 'force-dynamic'
```
No se puede pre-renderizar datos de usuario.

### Autenticacion (2 capas)
1. **Supabase Auth** → Google OAuth → cookie session
2. **Mapeo interno**: `auth.user.id` → `usuarios.id` via `getNetoUserId()`
   - Usa service-role client (privilegiado)
   - Retorna null si no autenticado

### API Routes — patron estandar
```typescript
export async function POST(request: Request) {
  const userId = await getNetoUserId()
  if (!userId) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  // ... logica con .eq('usuario_id', userId)
}
```

### Multimoneda
- Columnas: `monto` (original) + `monto_pen` (convertido) + `tipo_cambio`
- Conversion en insert/update via `getExchangeRate()`

### React Query hooks
- Ubicacion: `src/lib/hooks/`
- Query keys incluyen filtros (mes, anio) para invalidacion
- Mutations con `onSuccess` → `queryClient.invalidateQueries()`

## Theme "Nocturnal Precision"
- Dark-only, OLED-friendly
- Background: #0E0E0C, Foreground: #F0EFE8
- Primary: #1D9E75 (verde Neto)
- Solid surface tiers (no glassmorphism): `.glass-card` uses #131311 + border
  rgba(240,239,232,0.08) + drop shadow. `.glass-card-elevated` uses #1C1C19
  for modals/nested content. Surface tokens live in `@theme` as
  `--color-neto-bg2` (#131311) and `--color-neto-bg3` (#1C1C19).
  Note: the class is named `.glass-card` for backwards compatibility but
  the blur was removed during the mobile-comfort sprint (feat/mobile-comfort,
  April 2026) because it drained battery on Android mid-range and was
  nearly invisible on #0E0E0C anyway.
- Form inputs use `.form-input` utility: #1A1A17 bg, focus ring #1D9E75.
- Typographic tokens: `--text-display` (44px hero), `--text-hero` (52px),
  `--text-section` (18px), `--text-label` (12px) — defined in `@theme`.
- Tokens en `globals.css` via `@theme` (Tailwind v4)

## Deploy
- Vercel: auto-deploy on push, app.neto.pe + neto-app.vercel.app
- Env vars en Vercel: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY

## Gotchas
- Next.js 16 tiene breaking changes vs versiones anteriores — leer `node_modules/next/dist/docs/` antes de escribir codigo
- Tailwind v4 usa `@import` en CSS, NO plugin en postcss.config
- Imagenes remotas: solo `lh3.googleusercontent.com` (avatars Google)
- `force-dynamic` obligatorio en TODAS las paginas dashboard
- Service-role key SOLO en API routes server-side, NUNCA en cliente

## Deploy & monitoring
- Config: `.claude/deploy-config.json` (Vercel app.neto.pe + Supabase RLS check).
- Daily canary 10am Lima vía scheduled task `canary-daily-deploys`. Reporte solo si hay fallo en `C:/Vortik.dev/memory/canary/`.
- Verificación manual post-push: `curl -I https://app.neto.pe/` y `curl -I https://api.neto.pe/health`.
