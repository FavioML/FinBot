import { createClient } from '@/lib/supabase/server';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireLectura();
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('metas_ahorro')
    .update({ status: 'abandoned', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('usuario_id', usuario.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
