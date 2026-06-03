import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'faviomendoza27jl@gmail.com';
const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';
const ADMIN_KEY = process.env.ADMIN_KEY;

export const dynamic = 'force-dynamic';

async function getAdminEmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email || null;
}

// GET /api/admin/payments?user_id=  → historial de pagos (constancia de suscripción)
export async function GET(request: Request) {
  const email = await getAdminEmail();
  if (email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!ADMIN_KEY) {
    return NextResponse.json({ error: 'ADMIN_KEY no configurada en el entorno de la webapp' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('user_id') || '';
  const url = `${BACKEND_URL}/admin/pagos?clave=${encodeURIComponent(ADMIN_KEY)}${userId ? `&usuario_id=${encodeURIComponent(userId)}` : ''}`;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.msg || 'Error consultando pagos' }, { status: res.status || 500 });
    }
    return NextResponse.json({ ok: true, pagos: json.pagos || [] });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

// POST /api/admin/payments  → aprobar pago + activar Pro + notificar al usuario
// Body: { user_id, whatsapp?, tipo_plan }
export async function POST(request: Request) {
  const email = await getAdminEmail();
  if (email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!ADMIN_KEY) {
    return NextResponse.json({ error: 'ADMIN_KEY no configurada en el entorno de la webapp' }, { status: 500 });
  }

  const body = await request.json();
  const { user_id, whatsapp, tipo_plan } = body;
  if (!user_id && !whatsapp) {
    return NextResponse.json({ error: 'Falta user_id o whatsapp' }, { status: 400 });
  }

  try {
    const res = await fetch(`${BACKEND_URL}/admin/aprobar-pago`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave: ADMIN_KEY, usuario_id: user_id, whatsapp, tipo_plan }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.msg || 'Error aprobando pago' }, { status: res.status || 500 });
    }
    return NextResponse.json({ ok: true, ...json });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
