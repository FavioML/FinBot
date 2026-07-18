import { getNetoUserId } from '@/lib/supabase/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { NextResponse } from 'next/server';

const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

export const dynamic = 'force-dynamic';

// POST /api/pro/solicitud — el usuario logueado sube su comprobante y elige plan/bancos.
// Autenticamos aquí (getNetoUserId) y hacemos proxy al backend, que crea la solicitud
// pendiente y notifica al admin por Telegram con botones. No activa Pro (gate manual).
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!checkRateLimit(userId)) return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY no configurada en el entorno de la webapp' }, { status: 500 });
  }

  const form = await request.formData();
  const file = form.get('comprobante');
  const tipoPlan = String(form.get('tipo_plan') || 'mensual') === 'anual' ? 'anual' : 'mensual';

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Falta la captura del comprobante' }, { status: 400 });
  }
  if (!ALLOWED.includes(file.type)) {
    return NextResponse.json({ error: 'Formato no válido. Usa JPG, PNG o WEBP.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'La imagen supera 5MB.' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-internal-key': INTERNAL_API_KEY,
    'x-usuario-id': userId,
    'x-tipo-plan': tipoPlan,
    'x-mime-type': file.type,
  };

  try {
    const res = await fetch(`${BACKEND_URL}/pro/solicitud`, { method: 'POST', headers, body: buffer });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.msg || 'Error creando la solicitud' }, { status: res.status || 500 });
    }
    return NextResponse.json({ ok: true, pagoId: json.pagoId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
