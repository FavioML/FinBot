import { getNetoUserId } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';
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

// POST /api/pro/bancos — guarda la selección de bancos del usuario (post-aprobación).
// body: { bancos: string[] | null }  (null = todos). Se aplica al conectar Gmail.
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!checkRateLimit(userId)) return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });

  const body = await request.json().catch(() => ({}));
  const raw = (body as { bancos?: unknown }).bancos;
  // null = todos; array de ids = selección específica.
  const bancos = Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : null;

  const { error } = await getServiceClient()
    .from('usuarios')
    .update({ bancos_seleccionados: bancos })
    .eq('id', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
