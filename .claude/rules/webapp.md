---
paths:
  - "webapp/**/*.tsx"
  - "webapp/**/*.ts"
---

# Reglas Webapp Neto (Next.js 16 + React 19 + Supabase + shadcn)

- TypeScript estricto, prohibido `any`. Si hay tipos sin definir: crearlos en `webapp/types/`.
- App Router: archivos en `app/`. Server components por default, `'use client'` solo cuando se necesite hook o evento.
- Supabase client: server vs browser separados (`@supabase/ssr`). NUNCA usar service role en cliente.
- shadcn/ui para primitivas. NO recrear botones/inputs desde cero.
- Estado: TanStack Query para server state, useState para UI local. NO usar Zustand salvo justificacion.
- Animaciones: motion (Framer Motion v12). Respetar `prefers-reduced-motion`.
- Imagenes: `next/image` con `sizes` correcto. Lazy por default.
- Auth: Supabase auth via SSR cookies. Middleware en `middleware.ts` valida sesion.
