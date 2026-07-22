import { NextResponse } from 'next/server';

// Expone el commit del deployment que sirve app.neto.pe, para que el canary
// diario pueda confirmar que el bundle corresponde al HEAD de `main`.
// `VERCEL_GIT_COMMIT_SHA` lo inyecta Vercel solo en cada build/runtime — no hay
// env var que configurar. Fuera de Vercel (dev local) queda null, que el probe
// ignora porque solo mide contra https://app.neto.pe.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    {
      sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      env: process.env.VERCEL_ENV ?? 'local',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
