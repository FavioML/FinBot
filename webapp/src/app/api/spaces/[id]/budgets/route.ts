import { getServiceClient } from '@/lib/supabase/service';
import { getSpaceOwnerIsPro, parseSpaceBudgets, requireSpaceMember } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  // Presupuesto conjunto del espacio es Pro (tier del owner del espacio).
  if (!(await getSpaceOwnerIsPro(id))) {
    return NextResponse.json({ error: 'El presupuesto conjunto es una función Pro' }, { status: 403 });
  }

  // `request.json()` LANZA con un body vacío o mal formado, y sin este try el 400 del
  // usuario sale como 500 del servidor.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 });
  }

  // El JSONB se escribía crudo: era la única escritura de plata de Espacios que no
  // pasaba por `parseSpaceAmount` (S′6). Ver `parseSpaceBudgets` para por qué rechaza
  // en vez de sanear.
  const parsed = parseSpaceBudgets((body as { budgets?: unknown })?.budgets);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { error } = await getServiceClient()
    .from('shared_spaces')
    .update({ budgets: parsed.budgets })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
