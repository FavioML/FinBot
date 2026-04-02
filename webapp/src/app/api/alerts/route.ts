import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();
  if (!usuario) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '20');

  const { data: alerts } = await supabase
    .from('spending_alerts')
    .select('*')
    .eq('user_id', usuario.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  return NextResponse.json({
    alerts: alerts || [],
    isPro: usuario.plan === 'premium',
  });
}
