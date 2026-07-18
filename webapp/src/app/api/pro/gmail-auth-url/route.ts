import { getNetoUserId } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

export const dynamic = 'force-dynamic';

// GET /api/pro/gmail-auth-url — URL de OAuth Gmail para conectar desde la webapp.
// El callback backend redirige de vuelta a /dashboard?gmail=conectado (origen 'web').
export async function GET() {
  const userId = await getNetoUserId();
  if (!userId) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY no configurada en el entorno de la webapp' }, { status: 500 });
  }
  try {
    const res = await fetch(`${BACKEND_URL}/pro/gmail-auth-url?usuario_id=${encodeURIComponent(userId)}`, {
      headers: { 'x-internal-key': INTERNAL_API_KEY },
      cache: 'no-store',
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.msg || 'No se pudo generar el enlace' }, { status: res.status || 500 });
    }
    return NextResponse.json({ ok: true, url: json.url });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
