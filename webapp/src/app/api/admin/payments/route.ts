import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';

const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';
const ADMIN_KEY = process.env.ADMIN_KEY;

export const dynamic = 'force-dynamic';

// GET /api/admin/payments?user_id=  → historial de pagos (constancia de suscripción)
export async function GET(request: Request) {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!ADMIN_KEY) {
    return NextResponse.json({ error: 'ADMIN_KEY no configurada en el entorno de la webapp' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('user_id') || '';
  // Clave admin por header (nunca en query string: se filtra a logs de Railway).
  const url = `${BACKEND_URL}/admin/pagos${userId ? `?usuario_id=${encodeURIComponent(userId)}` : ''}`;

  try {
    const res = await fetch(url, { cache: 'no-store', headers: { 'x-admin-key': ADMIN_KEY } });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.msg || 'Error consultando pagos' }, { status: res.status || 500 });
    }
    return NextResponse.json({ ok: true, pagos: json.pagos || [], referido: json.referido ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

// POST /api/admin/payments  → aprobar pago + activar Pro + notificar al usuario
// Body: { user_id, whatsapp?, tipo_plan }
export async function POST(request: Request) {
  if (!(await requireAdminUser())) {
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
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ usuario_id: user_id, whatsapp, tipo_plan }),
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
