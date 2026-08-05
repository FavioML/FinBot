import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { generarCodigoOtp } from '@/lib/codigos-seguros';

// Reverse-OTP: verificamos posesion del numero ANTES de vincular la cuenta Google
// con un registro de usuario. El endpoint ya NO vincula/crea usuarios directamente
// (eso permitia reclamar la cuenta de otro tecleando su numero). Ahora:
//   POST  -> genera un codigo y devuelve el deep link de WhatsApp (wa.me).
//   GET   -> el cliente hace polling; true cuando el webhook confirmo el codigo.
// El vinculo real (usuarios.supabase_auth_id) lo hace el webhook al recibir el
// codigo desde el WhatsApp del usuario, que prueba posesion del numero.

const OTP_TTL_MIN = 15;
const BOT_WA = '51933014505';

// El código sale de `lib/codigos-seguros`, que documenta por qué NO puede venir de Math.random()
// y tiene su test. Acá quedaría sin poder testearse: los `route.ts` solo exportan handlers.
const genCode = generarCodigoOtp;

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

  // Ya vinculado: nada que verificar. Aca "no hay fila" es el caso NORMAL (el
  // usuario todavia no se vinculo), asi que no puede ser un 404 — pero tampoco
  // puede confundirse con una lectura caida: si la lectura falla y lo tomamos
  // por "no vinculado", se le manda a re-verificar por OTP una cuenta que ya
  // esta vinculada.
  // "Ya vinculado" ahora significa "ya tiene un número de WhatsApp", NO "tiene fila":
  // un usuario web-first tiene fila (supabase_auth_id) pero whatsapp NULL, y justamente
  // viene aquí a conectarlo. Chequear solo la existencia de la fila lo dejaría atrapado.
  const { data: current, error: eLinked } = await svc
    .from('usuarios')
    .select('id, whatsapp')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (eLinked) {
    console.error('[onboarding] lectura de usuarios fallida:', eLinked.message);
    return NextResponse.json({ error: 'Error temporal, intenta de nuevo' }, { status: 500 });
  }

  if (current?.whatsapp) {
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

  // El cliente hace polling de esto hasta que da true. La señal de que el vínculo se
  // cerró es que la fila de esta cuenta Google YA tiene un número de WhatsApp: el webhook
  // lo setea al confirmar el código (link directo) o al fusionar (merge_and_link). Con el
  // error tragado, una lectura caida se ve igual que "todavia no confirmo": el usuario se
  // queda mirando el spinner de una verificacion que ya ocurrio.
  const { data: linked, error: eLinked } = await svc
    .from('usuarios')
    .select('id, whatsapp')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (eLinked) {
    console.error('[onboarding] lectura de usuarios fallida:', eLinked.message);
    return NextResponse.json({ error: 'Error temporal, intenta de nuevo' }, { status: 500 });
  }

  if (linked?.whatsapp) {
    return NextResponse.json({ verified: true });
  }

  const { data: otp, error: eOtp } = await svc
    .from('webapp_otp')
    .select('verified_at')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (eOtp) {
    console.error('[onboarding] lectura de webapp_otp fallida:', eOtp.message);
    return NextResponse.json({ error: 'Error temporal, intenta de nuevo' }, { status: 500 });
  }

  return NextResponse.json({ verified: !!otp?.verified_at });
}
