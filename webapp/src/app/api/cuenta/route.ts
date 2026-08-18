import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

// Eliminar la cuenta desde la webapp.
//
// Hasta ahora la unica salida del producto era el intent `desconectar_cuenta` por WhatsApp, y
// solo por NLP: no hay comando que lo abra. O sea que quien no escribiera la frase exacta no
// encontraba la puerta, y los usuarios sin numero de WhatsApp (7 al 17-ago-2026, sobre 113)
// directamente no tenian ninguna. La seccion "Zona de peligro" de /dashboard/configuracion
// existia desde antes, pero mandaba a pedirlo por WhatsApp — la puerta que ellos no tienen.
//
// ESTA RUTA NO BORRA NADA. Es un proxy al backend, y eso es la decision, no un atajo: el
// borrado toca Google (revocar el grant), Storage, el Admin API de Auth y una transaccion de
// Postgres. Escribirlo tambien aca serian dos implementaciones en dos lenguajes y dos
// deploys, con un arreglo llegando a una sola mitad. Es exactamente el error de las TRES
// copias del wipe que se unificaron el 17-ago, a mayor escala.
//
// Ver `app/services/account-deletion.js` y `app/migrations/073_borrado_cuenta.sql`.

export async function DELETE() {
  const auth = await requireNetoUser('id');
  if (!auth.ok) return auth.response;

  const base = process.env.NETO_BACKEND_URL || 'https://api.neto.pe';
  const key = process.env.INTERNAL_API_KEY;

  // Falla DURO si falta el secreto, y no en silencio. Los avisos best-effort de este repo
  // (`bind-activation.ts`, `spaces-server.ts`) hacen `if (!key) return;` porque un aviso
  // perdido no rompe nada. Aca es al reves: sin el secreto NO se borro la cuenta, y devolver
  // 200 haria que la UI le dijera "listo" a alguien cuyos datos siguen enteros.
  if (!key) {
    console.error('[cuenta:borrar] INTERNAL_API_KEY no configurada: no se puede borrar');
    return NextResponse.json({ error: 'Error temporal, intenta de nuevo' }, { status: 500 });
  }

  let res: Response;
  try {
    res = await fetch(`${base}/internal/cuenta/borrar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': key },
      // Solo el id de la sesion (`auth.user.id` sale del chokepoint `requireNetoUser`). No se
      // acepta ningun id de entrada, asi que no hay superficie de IDOR.
      body: JSON.stringify({ usuario_id: auth.user.id }),
    });
  } catch (e) {
    // El backend no contesto. NO se puede afirmar que no haya borrado: pudo completar la
    // transaccion y morirse al responder. Por eso el mensaje no dice "tu cuenta sigue igual"
    // — esa frase solo la puede decir quien sabe que el RPC fallo.
    console.error('[cuenta:borrar] el backend no respondio', e);
    return NextResponse.json({ error: 'No pudimos completar la eliminacion. Intenta de nuevo.' }, { status: 502 });
  }

  if (!res.ok) {
    console.error('[cuenta:borrar] el backend respondio', res.status);
    return NextResponse.json({ error: 'No pudimos completar la eliminacion. Intenta de nuevo.' }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
