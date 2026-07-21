import { getServiceClient } from '@/lib/supabase/service';
import { getSpaceBalances, requireSpaceOwner } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Only owner can remove members
  const auth = await requireSpaceOwner(id);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  // Can't remove yourself
  if (userId === auth.user.id) return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 });

  // No se sale de un espacio con cuentas abiertas. Los gastos ya registrados
  // conservan su division congelada, asi que la deuda de un removido NO se
  // evapora (los balances cubren la union de miembros e historial); pero dejarlo
  // salir debiendo produce un saldo que ya nadie puede liquidar desde la app.
  const balances = await getSpaceBalances(id);
  const saldo = balances[userId] ?? 0;
  if (Math.abs(saldo) > 0.005) {
    return NextResponse.json(
      {
        error:
          saldo < 0
            ? `No puedes remover a este miembro: debe S/ ${Math.abs(saldo).toFixed(2)} al espacio. Liquiden primero.`
            : `No puedes remover a este miembro: el espacio le debe S/ ${saldo.toFixed(2)}. Liquiden primero.`,
        balance: saldo,
      },
      { status: 409 }
    );
  }

  const { error } = await getServiceClient()
    .from('space_members')
    .delete()
    .eq('space_id', id)
    .eq('user_id', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
