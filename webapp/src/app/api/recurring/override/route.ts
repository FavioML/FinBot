import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

const DOMINIOS = ['recurrente', 'suscripcion'] as const;
// Campos editables del override (whitelist)
const FIELDS = [
  'id_canonico',
  'label_canonico',
  'oculto',
  'es_recurrente_manual',
  'catalog_id',
  'plan_nombre',
] as const;

// Upsert con merge: cada acción manda solo los campos que cambia; se combinan sobre
// el override existente de esa (usuario, dominio, clave_variante).
export async function POST(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;
  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();
  const dominio = body?.dominio;
  const claveVariante = typeof body?.clave_variante === 'string' ? body.clave_variante.trim() : '';
  if (!DOMINIOS.includes(dominio) || !claveVariante) {
    return NextResponse.json({ error: 'dominio o clave_variante inválidos' }, { status: 400 });
  }

  const svc = getServiceClient();
  const { data: existing } = await svc
    .from('recurrentes_overrides')
    .select('*')
    .eq('usuario_id', netoUser.id)
    .eq('dominio', dominio)
    .eq('clave_variante', claveVariante)
    .maybeSingle();

  const merged: Record<string, unknown> = {
    usuario_id: netoUser.id,
    dominio,
    clave_variante: claveVariante,
    updated_at: new Date().toISOString(),
  };
  for (const f of FIELDS) {
    if (f in body) merged[f] = body[f];
    else if (existing && f in existing) merged[f] = (existing as Record<string, unknown>)[f];
  }

  const { data, error } = await svc
    .from('recurrentes_overrides')
    .upsert(merged, { onConflict: 'usuario_id,dominio,clave_variante' })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

// Reset: borra el override de esa clave (vuelve a la heurística automática).
export async function DELETE(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;
  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const dominio = searchParams.get('dominio');
  const claveVariante = (searchParams.get('clave_variante') || '').trim();
  if (!dominio || !DOMINIOS.includes(dominio as (typeof DOMINIOS)[number]) || !claveVariante) {
    return NextResponse.json({ error: 'dominio o clave_variante inválidos' }, { status: 400 });
  }

  const { error } = await getServiceClient()
    .from('recurrentes_overrides')
    .delete()
    .eq('usuario_id', netoUser.id)
    .eq('dominio', dominio)
    .eq('clave_variante', claveVariante);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
