import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { verificarTokenActivacion } from '@/lib/activacion-token';

// Entrada del link de activación que Neto manda por WhatsApp después del primer
// gasto. El token ya lleva la identidad del usuario, así que acá no se teclea
// nada: ni email ni código. Lo único que falta es probar la cuenta Google, y eso
// lo prueba el login.
//
// El link NO abre sesión por sí solo, y eso es deliberado: vive en un chat de
// WhatsApp, o sea que un reenvío, un screenshot o un backup lo dejarían en manos
// de un tercero. Lo que hace es llevar la identidad hasta el otro lado del login.

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get('t');
  const payload = verificarTokenActivacion(token);

  if (!payload) {
    // Firma inválida o vencido. No se distingue cuál de los dos: el siguiente
    // gasto que registre trae un link nuevo, así que la salida es la misma.
    return NextResponse.redirect(`${origin}/login?activacion=expirado`);
  }

  // El token viaja en una cookie httpOnly hasta el otro lado del login, donde
  // /auth/callback lo consume. Mismo patrón que `neto_ref` para el código de
  // referido: en la URL no puede ir, porque el redirect de OAuth es de Supabase
  // y no conserva nuestros parámetros.
  const setCookie = (res: NextResponse) => {
    res.cookies.set('neto_act', token!, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60,   // 1h: el login pasa ahora o no pasa. El token dura 7 días aparte.
    });
    return res;
  };

  // ¿Ya hay sesión abierta en este navegador? Entonces NO se vincula solo. La
  // sesión abierta puede no ser de quien manda el mensaje (teléfono compartido,
  // el Google de la pareja, un navegador prestado), y vincular a ciegas ahí
  // fusionaría dos cuentas ajenas — y merge_and_link BORRA la fila perdedora, o
  // sea que no hay vuelta atrás. Se pide un toque de confirmación explícito.
  //
  // Este camino existe además por una razón mecánica: el middleware rebota a
  // /dashboard a quien pise /login con sesión, así que mandarlo al login haría
  // que /auth/callback nunca corriera y el link no hiciera nada.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) return setCookie(NextResponse.redirect(`${origin}/activar/confirmar`));

  return setCookie(NextResponse.redirect(`${origin}/login?activar=1`));
}
