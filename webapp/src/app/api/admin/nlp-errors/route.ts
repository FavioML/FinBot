import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';

const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';
const ADMIN_KEY = process.env.ADMIN_KEY;

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');
  // Los 429 de OpenAI (error_tipo='rate_limit') son infra, no NLP. Por defecto se excluyen
  // del listado y del conteo real; se devuelven aparte para que el panel los muestre como
  // categoría separada. ?includeRateLimit=1 los trae mezclados.
  const includeRateLimit = searchParams.get('includeRateLimit') === '1';

  let query = getServiceClient()
    .from('nlp_errors')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (!includeRateLimit) query = query.neq('error_tipo', 'rate_limit');

  const { data, error, count } = await query.range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { count: rateLimitTotal } = await getServiceClient()
    .from('nlp_errors')
    .select('*', { count: 'exact', head: true })
    .eq('error_tipo', 'rate_limit');

  return NextResponse.json({
    ok: true,
    total: count || 0,
    rateLimitTotal: rateLimitTotal || 0,
    errors: data || [],
  });
}

/**
 * POST — le responde como NETO a quien dejó un feedback o una queja.
 *
 * Estas dos cosas viven en `nlp_errors`, no en `tickets_soporte`, así que el flujo de respuesta
 * del tab Tickets no les servía: no hay ticket que responder. El resultado era que la única
 * forma de contestarle a alguien que se tomó el trabajo de escribir una sugerencia era hacerlo
 * desde un celular.
 *
 * La webapp no puede mandar WhatsApp (no tiene token de Meta), igual que en /api/admin/tickets:
 * el envío lo hace el backend. Ver routes/admin.js → /admin/contactar-usuario.
 *
 * El `msg` del backend se DEVUELVE tal cual, el del fallo incluido: ahí vive la razón que
 * importa (la ventana de 24h de Meta), y el panel la tiraba para poner "Error al responder".
 */
export async function POST(request: Request) {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { whatsapp, mensaje, usuario_id, nombre } = body || {};
  if (!whatsapp || !mensaje) {
    return NextResponse.json({ error: 'Faltan whatsapp o mensaje' }, { status: 400 });
  }
  if (!ADMIN_KEY) {
    return NextResponse.json({ error: 'ADMIN_KEY no configurada en el entorno de la webapp' }, { status: 500 });
  }

  try {
    const res = await fetch(`${BACKEND_URL}/admin/contactar-usuario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ whatsapp, mensaje, usuario_id, nombre }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.msg || 'No se pudo enviar el mensaje' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, msg: json.msg, conversacionAbierta: json.conversacionAbierta === true });
  } catch (e) {
    return NextResponse.json({ error: 'Error contactando el backend: ' + (e as Error).message }, { status: 502 });
  }
}
