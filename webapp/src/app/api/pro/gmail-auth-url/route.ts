import { requireNetoUser } from '@/lib/supabase/auth';
import { esProPagado } from '@/lib/plan';
import { checkRateLimit } from '@/lib/rate-limit';
import { NextResponse } from 'next/server';

const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

export const dynamic = 'force-dynamic';

// Los tres modos que entiende el callback (`guardarTokens`). Lista blanca: un modo
// inesperado degrada a 'inicial', que es el único que no toca cuentas existentes.
const MODOS = ['inicial', 'agregar', 'reemplazar'] as const;

// GET /api/pro/gmail-auth-url?modo= — URL de OAuth Gmail para conectar desde la webapp.
// El callback backend redirige de vuelta a /dashboard?gmail=conectado (origen 'web').
export async function GET(request: Request) {
  // Se piden `plan` y `trial_estado` porque las dos alimentan el gate: conectar Gmail consume
  // uno de los 100 cupos de Google que tenemos hasta CASA, así que se reserva para quien PAGA.
  // Durante el trial `plan` ya vale 'premium' (migración 052) — de ahí `esProPagado` y no un
  // chequeo de plan. Sigue sin `requireLectura`: el muro de lectura no es este gate, esta ruta
  // es de conversión y por eso está exenta en `lectura-callsites.test.ts`.
  const auth = await requireNetoUser('id, plan, trial_estado');
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;
  if (!esProPagado(auth.user.plan as string | null, auth.user.trial_estado as string | null)) {
    return NextResponse.json(
      { error: 'Conectar Gmail requiere Pro pagado', motivo: 'pro_pagado_requerido' },
      { status: 403 },
    );
  }
  if (!checkRateLimit(userId)) return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY no configurada en el entorno de la webapp' }, { status: 500 });
  }
  // `agregar` (segunda cuenta) y `reemplazar` (reconectar tras un invalid_grant) antes solo
  // existían por WhatsApp. Ahora que la webapp es el único camino, tiene que cubrirlos.
  const pedido = new URL(request.url).searchParams.get('modo');
  const modo = (MODOS as readonly string[]).includes(pedido ?? '') ? pedido! : 'inicial';
  try {
    const res = await fetch(`${BACKEND_URL}/pro/gmail-auth-url?usuario_id=${encodeURIComponent(userId)}&modo=${modo}`, {
      headers: { 'x-internal-key': INTERNAL_API_KEY },
      cache: 'no-store',
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.msg || 'No se pudo generar el enlace' }, { status: res.status || 500 });
    }
    return NextResponse.json({ ok: true, url: json.url });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
