import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { verificarTokenActivacion } from '@/lib/activacion-token';
import { bindActivacion, notificarBackendActivacion } from '@/lib/bind-activation';

// Confirmación explícita de la activación cuando ya había sesión abierta (ver
// src/app/activar/confirmar/page.tsx). Es POST y sin body a propósito: el usuario
// objetivo sale del token en la cookie httpOnly, nunca de lo que mande el cliente,
// así que no hay forma de pedir la activación de la cuenta de otro.
//
// No usa requireNetoUser: la sesión puede no tener fila propia todavía (ese es
// justamente el caso que este endpoint resuelve), y ese helper devolvería 404.

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, estado: 'sin_sesion' }, { status: 401 });

  const token = (await cookies()).get('neto_act')?.value;
  const payload = verificarTokenActivacion(token);
  if (!payload) return NextResponse.json({ ok: false, estado: 'token_invalido' }, { status: 400 });

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const nombre = user.user_metadata?.full_name || user.user_metadata?.name || null;
  const resultado = await bindActivacion(svc, payload.uid, user.id, user.email ?? null, nombre);
  await notificarBackendActivacion(resultado, payload.uid);

  const ok = resultado.estado === 'adoptada' || resultado.estado === 'fusionada';
  const res = NextResponse.json(
    { ok, estado: resultado.estado },
    { status: ok ? 200 : 409 }
  );
  // La cookie se consume pase lo que pase: un token que ya fue intentado no
  // debería quedar dando vueltas en el navegador.
  res.cookies.set('neto_act', '', { maxAge: 0, path: '/' });
  return res;
}
