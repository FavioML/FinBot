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

  // `?thread=<ticketId>` devuelve el HILO de ese ticket (migración 079) en vez del listado.
  // Va acá y no en el backend porque la webapp ya lee `tickets_soporte` con service-role: un
  // endpoint nuevo en Railway sólo agregaría un salto y una segunda forma de leer lo mismo.
  const thread = searchParams.get('thread');
  if (thread) {
    const { data, error } = await getServiceClient()
      .from('tickets_mensajes')
      .select('id, rol, mensaje, created_at, wamid')
      .eq('ticket_id', thread)
      .order('created_at', { ascending: true });
    // Se distingue "falló la lectura" de "no hay mensajes": pintar un hilo vacío sobre una
    // caída le diría al admin que nadie escribió nada.
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // El DESENLACE de cada turno del admin (migración 079b). "Enviado" sólo significa que
    // Meta aceptó el POST: sobre 30 días, de 556 aceptados se entregaron 67. El que decide
    // es el callback de status, que escribe `delivered_at`/`failed_at` sobre la fila del
    // ledger, y el `wamid` es lo que une los dos lados.
    const wamids = (data || []).map((m) => m.wamid).filter(Boolean) as string[];
    const entregas: Record<string, { delivered_at: string | null; failed_at: string | null; code: number | null }> = {};
    if (wamids.length > 0) {
      const { data: dels, error: errDel } = await getServiceClient()
        .from('notification_deliveries')
        .select('wamid, delivered_at, failed_at, code')
        .in('wamid', wamids);
      // Un fallo acá NO tumba el hilo: los mensajes son lo que el admin vino a leer, y el
      // estado de entrega es el adorno. Se devuelve el hilo sin estados, que la UI pinta
      // como "sin dato" — nunca como "no entregado", que sería afirmar algo que no se sabe.
      if (!errDel) {
        for (const d of dels || []) {
          if (d.wamid) entregas[d.wamid] = { delivered_at: d.delivered_at, failed_at: d.failed_at, code: d.code };
        }
      }
    }

    return NextResponse.json({
      ok: true,
      mensajes: (data || []).map((m) => ({ ...m, entrega: m.wamid ? entregas[m.wamid] || null : null })),
    });
  }

  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');
  const estado = searchParams.get('estado') || null;
  const search = searchParams.get('search') || null;

  let query = getServiceClient()
    .from('tickets_soporte')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (estado && estado !== 'todos') {
    query = query.eq('estado', estado);
  }

  if (search) {
    query = query.or(`mensaje_usuario.ilike.%${search}%,whatsapp.ilike.%${search}%`);
  }

  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, total: count || 0, tickets: data || [] });
}

export async function PUT(request: Request) {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { id, action, ...data } = body;

  if (!id || !action) {
    return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
  }

  switch (action) {
    case 'respond': {
      const respuesta = data.respuesta;
      if (!respuesta) {
        return NextResponse.json({ error: 'Missing respuesta' }, { status: 400 });
      }
      if (!ADMIN_KEY) {
        return NextResponse.json({ error: 'ADMIN_KEY no configurada en el entorno de la webapp' }, { status: 500 });
      }
      // La webapp no puede mandar WhatsApp (sin token de Meta). El backend envía el
      // mensaje al usuario Y marca el ticket como respondido (columnas mensaje_admin /
      // estado / updated_at). Ver routes/admin.js → /admin/responder-ticket.
      try {
        const res = await fetch(`${BACKEND_URL}/admin/responder-ticket`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
          body: JSON.stringify({ ticket_id: id, mensaje: respuesta }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          return NextResponse.json({ error: json.msg || 'No se pudo enviar la respuesta' }, { status: 502 });
        }
        return NextResponse.json({ ok: true, action: 'respond', msg: json.msg });
      } catch (e) {
        return NextResponse.json({ error: 'Error contactando el backend: ' + (e as Error).message }, { status: 502 });
      }
    }

    case 'set_estado': {
      const estado = data.estado;
      if (!estado) {
        return NextResponse.json({ error: 'Missing estado' }, { status: 400 });
      }
      const { error } = await getServiceClient()
        .from('tickets_soporte')
        .update({ estado })
        .eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'set_estado', estado });
    }

    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}
