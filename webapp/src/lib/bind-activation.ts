import type { SupabaseClient } from '@supabase/supabase-js';

// Vinculación de una cuenta nacida en WhatsApp con la sesión Google que acaba de
// abrirse, usando el token firmado que viajó en el link (lib/activacion.js).
//
// Es el reverso del OTP `NETO-XXXXXX` (handlers/webhook.js): allá el usuario
// probaba posesión del número mandando un código desde su WhatsApp; acá la
// posesión ya está probada por el canal — el link solo pudo salir del chat de
// ese número — y lo que falta probar es la cuenta Google, que la prueba el login.
//
// Las tres ramas son las MISMAS que las del OTP, a propósito: si el modelo de
// identidad cambia, los dos caminos tienen que moverse juntos.

export type ResultadoBind =
  | { estado: 'adoptada'; usuarioId: string }
  | { estado: 'fusionada'; usuarioId: string }
  | { estado: 'ya_activada' }
  | { estado: 'conflicto'; usuarioId: string }
  | { estado: 'sin_fila' }
  | { estado: 'error' };

/**
 * @param svc     cliente service-role (ignora RLS)
 * @param uid     usuarios.id que venía firmado en el token
 * @param authId  auth.users.id de la sesión recién abierta
 * @param email   email de la sesión (puede faltar)
 * @param nombre  nombre de la cuenta Google (puede faltar)
 */
export async function bindActivacion(
  svc: SupabaseClient,
  uid: string,
  authId: string,
  email: string | null,
  nombre: string | null
): Promise<ResultadoBind> {
  const { data: filaWA, error: eWA } = await svc
    .from('usuarios')
    .select('id, supabase_auth_id, nombre, email')
    .eq('id', uid)
    .maybeSingle();

  if (eWA) {
    console.error('[activar] lectura de la fila del token fallida:', eWA.message);
    return { estado: 'error' };
  }
  if (!filaWA) return { estado: 'sin_fila' };

  // Ya la activó (con esta cuenta o con otra). El token queda inerte: eso es lo
  // que lo hace de un solo uso sin necesidad de una tabla de tokens. Si fue con
  // otra cuenta Google, tampoco se toca — sería un takeover con un link viejo.
  if (filaWA.supabase_auth_id) {
    return filaWA.supabase_auth_id === authId
      ? { estado: 'adoptada', usuarioId: filaWA.id }   // idempotente: re-abrir el link no rompe nada
      : { estado: 'ya_activada' };
  }

  // ¿Esta cuenta Google ya tiene su propia fila en Neto? (se registró antes por
  // la web, o entró con otro número). Entonces no se adopta: se fusiona.
  const { data: filaWeb, error: eWeb } = await svc
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', authId)
    .maybeSingle();

  if (eWeb) {
    console.error('[activar] lectura de la fila web fallida:', eWeb.message);
    return { estado: 'error' };
  }

  if (filaWeb) {
    // Survivor = la fila web, que es la que conserva el auth_id de la sesión viva.
    // merge_and_link es atómica y rechaza los bordes inseguros (número ya ligado a
    // otra cuenta Google, o espacio/meta compartida entre ambas filas).
    const { data: resultado, error: eMerge } = await svc.rpc('merge_and_link', {
      p_survivor: filaWeb.id,
      p_loser: filaWA.id,
    });
    if (eMerge) {
      console.error('[activar] merge_and_link falló:', eMerge.message);
      return { estado: 'error' };
    }
    if (resultado === 'conflict') return { estado: 'conflicto', usuarioId: filaWeb.id };
    if (resultado !== 'linked' && resultado !== 'noop') {
      console.error('[activar] merge_and_link resultado inesperado:', resultado);
      return { estado: 'error' };
    }
    return { estado: 'fusionada', usuarioId: filaWeb.id };
  }

  // Camino normal y de lejos el más común: la fila de WhatsApp adopta la cuenta
  // Google. NO se llama a createWebUser — eso crearía una segunda fila y dejaría
  // el historial de gastos del usuario en la otra, que es exactamente el bug que
  // este flujo existe para evitar.
  const update: Record<string, unknown> = {
    supabase_auth_id: authId,
    onboarding_completado: true,
  };
  if (email && !filaWA.email) update.email = email;
  if (nombre && !filaWA.nombre) update.nombre = nombre;

  const { error: eUpd } = await svc.from('usuarios').update(update).eq('id', filaWA.id);
  if (eUpd) {
    // 23505 sobre el índice usuarios_email_lower_unique: el correo de la cuenta
    // Google ya pertenece a otra fila. Se reintenta sin tocar el email, que es
    // accesorio — lo que importa es vincular el auth_id.
    if (eUpd.code === '23505' && update.email) {
      delete update.email;
      const { error: eRetry } = await svc.from('usuarios').update(update).eq('id', filaWA.id);
      if (!eRetry) return { estado: 'adoptada', usuarioId: filaWA.id };
      console.error('[activar] update de adopción falló en el reintento:', eRetry.message);
      return { estado: 'error' };
    }
    console.error('[activar] update de adopción falló:', eUpd.message);
    return { estado: 'error' };
  }

  return { estado: 'adoptada', usuarioId: filaWA.id };
}

/**
 * Avisa al backend (único con token de Meta y con el distinctId correcto de
 * PostHog). Best-effort absoluto: la activación ya ocurrió en la DB, así que un
 * fallo acá no puede tumbar el login.
 */
export async function notificarBackendActivacion(
  resultado: ResultadoBind,
  fallbackUid?: string
): Promise<void> {
  const base = process.env.PUBLIC_BACKEND_URL || 'https://api.neto.pe';
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return;

  try {
    if (resultado.estado === 'adoptada' || resultado.estado === 'fusionada') {
      await fetch(`${base}/internal/activacion-completada`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ usuario_id: resultado.usuarioId, resultado: resultado.estado }),
      });
      return;
    }
    const motivo =
      resultado.estado === 'ya_activada' ? 'ya_activada'
      : resultado.estado === 'conflicto' ? 'merge_conflict'
      : resultado.estado === 'sin_fila' ? 'token_invalido'
      : 'error';
    await fetch(`${base}/internal/activacion-fallida`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify({
        usuario_id: 'usuarioId' in resultado ? resultado.usuarioId : fallbackUid,
        motivo,
      }),
    });
  } catch (e) {
    console.error('[activar] no se pudo avisar al backend:', e);
  }
}
