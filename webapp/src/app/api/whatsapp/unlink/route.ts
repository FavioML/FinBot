import { requireNetoUser } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

// Desvincular el numero de WhatsApp de la cuenta (self-serve, "cambiar numero").
//
// Caso real: un usuario con dos numeros vinculo el equivocado. Antes solo se
// arreglaba por soporte con SQL a mano. Aca lo corrige el propio dueno.
//
// Es un cambio SEGURO y de bajo radio: el numero vive como escalar `whatsapp` en
// la MISMA fila del usuario (indexada por supabase_auth_id). Ponerlo en null NO
// toca el auth_id, ni Gmail, ni el plan, ni el slot OAuth de los 100 Pro; toda la
// data financiera (indexada por usuarios.id) queda intacta. Por eso se permite
// para TODOS los planes, incluido Pro.
//
// Para re-vincular el numero correcto el usuario pasa por el flujo reverse-OTP
// existente (/onboarding -> webhook): con el survivor en whatsapp=null,
// merge_and_link adopta el numero nuevo (whatsapp = COALESCE(loser, survivor)).
//
// Desvincular borra el numero Y el BSUID (12-sep-2026). Desde que el bot contesta y avisa por
// BSUID, dejar el BSUID puesto hacia que alguien que desvinculo siguiera recibiendo mensajes:
// el backend le escribe a `whatsapp || bsuid`. Y quien se vinculo sin mostrar su numero tiene
// SOLO el BSUID, asi que "no hay numero" ya no significa "no hay nada que desvincular".
export async function POST() {
  const auth = await requireNetoUser('id, whatsapp, bsuid');
  if (!auth.ok) return auth.response;

  // Idempotente: si no hay ninguna de las dos direcciones, no hay nada que desvincular.
  if (!auth.user.whatsapp && !auth.user.bsuid) {
    return NextResponse.json({ success: true, alreadyUnlinked: true });
  }

  // Solo la fila de la sesion (auth.user.id viene del chokepoint requireNetoUser):
  // no se acepta ningun id de entrada, asi que no hay superficie de IDOR.
  const { error } = await getServiceClient()
    .from('usuarios')
    .update({ whatsapp: null, bsuid: null })
    .eq('id', auth.user.id);

  if (error) {
    console.error('[whatsapp:unlink] update fallido', {
      usuario_id: auth.user.id,
      code: error.code,
      message: error.message,
    });
    return NextResponse.json({ error: 'Error temporal, intenta de nuevo' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
