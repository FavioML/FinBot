import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json();
  const digits = (body.whatsapp || '').replace(/\D/g, '');

  if (!digits || digits.length !== 9) {
    return NextResponse.json(
      { error: 'WhatsApp invalido. Ingresa 9 digitos.' },
      { status: 400 },
    );
  }

  const fullWhatsapp = `51${digits}`;

  // Check if this auth user already has a record (prevent duplicates)
  const { data: alreadyLinked } = await serviceClient
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (alreadyLinked) {
    return NextResponse.json({ success: true, linked: false });
  }

  // Check if a user with this WhatsApp already exists
  const { data: existing } = await serviceClient
    .from('usuarios')
    .select('id')
    .eq('whatsapp', fullWhatsapp)
    .maybeSingle();

  if (existing) {
    // Link existing WhatsApp user to this Google account
    const { error } = await serviceClient
      .from('usuarios')
      .update({
        supabase_auth_id: user.id,
        email: user.email,
        nombre:
          user.user_metadata?.full_name ||
          user.user_metadata?.name ||
          null,
      })
      .eq('id', existing.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, linked: true });
  }

  // Create new user
  const { error } = await serviceClient.from('usuarios').insert({
    whatsapp: fullWhatsapp,
    supabase_auth_id: user.id,
    email: user.email,
    nombre:
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      null,
    plan: 'free',
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, linked: false });
}
