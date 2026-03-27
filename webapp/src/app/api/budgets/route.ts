import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** Capitalize first letter */
function capitalize(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

async function getNetoUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await serviceClient
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();
  return data || null;
}

const FREE_BUDGET_LIMIT = 3;

export async function POST(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = netoUser.id;

  // All users have full access — limit is Infinity
  if (netoUser.plan !== 'premium') {
    const { count } = await serviceClient
      .from('presupuestos')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', userId);
    if ((count ?? 0) >= FREE_BUDGET_LIMIT) {
      return NextResponse.json(
        { error: 'Plan Free permite máximo 3 presupuestos. Activa Pro para presupuestos ilimitados.', upgrade: true },
        { status: 403 },
      );
    }
  }

  const body = await request.json();
  const { data, error } = await serviceClient
    .from('presupuestos')
    .insert({
      usuario_id: userId,
      categoria: body.categoria,
      subcategoria: capitalize(body.subcategoria),
      monto_limite: body.monto_limite,
      alerta_porcentaje: body.alerta_porcentaje || 80,
      mes: new Date().getMonth() + 1,
      anio: new Date().getFullYear(),
    })
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function PUT(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = netoUser.id;

  const body = await request.json();
  const { data, error } = await serviceClient
    .from('presupuestos')
    .update({
      categoria: body.categoria,
      subcategoria: capitalize(body.subcategoria),
      monto_limite: body.monto_limite,
      alerta_porcentaje: body.alerta_porcentaje || 80,
    })
    .eq('id', body.id)
    .eq('usuario_id', userId)
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = netoUser.id;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await serviceClient
    .from('presupuestos')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
