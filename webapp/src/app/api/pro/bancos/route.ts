import { getNetoUserId } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

export const dynamic = 'force-dynamic';

// GET /api/pro/bancos — catálogo de bancos (id + label) para el multiselect del upgrade.
export async function GET() {
  const userId = await getNetoUserId();
  if (!userId) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY no configurada en el entorno de la webapp' }, { status: 500 });
  }
  try {
    const res = await fetch(`${BACKEND_URL}/pro/bancos`, {
      headers: { 'x-internal-key': INTERNAL_API_KEY },
      cache: 'no-store',
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.msg || 'Error obteniendo bancos' }, { status: res.status || 500 });
    }
    return NextResponse.json({ ok: true, bancos: json.bancos || [] });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
