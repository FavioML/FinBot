import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

// Reverse-OTP: verificamos posesion del numero ANTES de vincular la cuenta Google
// con un registro de usuario. El endpoint ya NO vincula/crea usuarios directamente
// (eso permitia reclamar la cuenta de otro tecleando su numero). Ahora:
//   POST  -> genera un codigo y devuelve el deep link de WhatsApp (wa.me).
//   GET   -> el cliente hace polling; true cuando el webhook confirmo el codigo.
// El vinculo real (usuarios.supabase_auth_id) lo hace el webhook al recibir el
// codigo desde el WhatsApp del usuario, que prueba posesion del numero.

const OTP_TTL_MIN = 15;
const BOT_WA = '51933014505';

function genCode(): string {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `NETO-${n}`;
}

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
  const svc = getServiceClient();

  // Ya vinculado: nada que verificar.
  const { data: alreadyLinked } = await svc
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (alreadyLinked) {
    return NextResponse.json({ success: true, alreadyLinked: true });
  }

  const code = genCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60_000).toISOString();
  const nombre =
    user.user_metadata?.full_name || user.user_metadata?.name || null;

  // Un OTP pendiente por cuenta (unique index en supabase_auth_id): regenerar reemplaza.
  const { error } = await svc.from('webapp_otp').upsert(
    {
      supabase_auth_id: user.id,
      email: user.email,
      nombre,
      code,
      whatsapp_claimed: fullWhatsapp,
      verified_at: null,
      whatsapp_verified: null,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    },
    { onConflict: 'supabase_auth_id' },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const text = `Hola Neto, verifica mi cuenta web: ${code}`;
  const waLink = `https://wa.me/${BOT_WA}?text=${encodeURIComponent(text)}`;

  return NextResponse.json({ success: true, code, waLink, expiresAt });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const svc = getServiceClient();

  const { data: linked } = await svc
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (linked) {
    return NextResponse.json({ verified: true });
  }

  const { data: otp } = await svc
    .from('webapp_otp')
    .select('verified_at')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  return NextResponse.json({ verified: !!otp?.verified_at });
}
