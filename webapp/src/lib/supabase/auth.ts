import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

/**
 * Chokepoint del mapeo sesion Supabase -> fila de `usuarios`.
 *
 * Toda ruta autenticada de la webapp necesita este salto: `auth.user.id` (el id
 * de Supabase Auth) no es `usuarios.id` (el id interno con el que esta indexada
 * TODA la data financiera). Antes vivia copiado a mano en ~36 sitios y ninguno
 * capturaba el `error` de la lectura, asi que Supabase tosiendo se le presentaba
 * al cliente como "no eres tu" (401) o "no existes" (404) sobre un usuario
 * legitimo con sesion valida.
 *
 * Los tres casos son distintos y tienen que responder distinto:
 *
 * | Senal                | Significa                       | Respuesta |
 * |----------------------|---------------------------------|-----------|
 * | no hay sesion        | no autenticado                  | 401       |
 * | `error` presente     | la lectura se cayo               | 500       |
 * | `data === null`      | sesion valida, sin fila todavia | 404       |
 *
 * Por eso se usa `.maybeSingle()` y no `.single()`: con `single()` cero filas
 * TAMBIEN llega como error (PGRST116), o sea que "no hay fila" y "la lectura se
 * cayo" quedan mezcladas dentro del mismo objeto y el 500 es indistinguible del
 * 404. Con `maybeSingle()` la senal queda limpia.
 *
 * Un 401 espurio no es solo un codigo feo: las paginas de invitacion
 * (`/join/*`) mandan a `/login` con un 401, y el middleware rebota a
 * `/dashboard` a quien ya tiene sesion — la invitacion se pierde en silencio.
 */

export interface NetoUserRow {
  id: string;
  [key: string]: unknown;
}

export type NetoUserAuth =
  | {
      ok: true;
      user: NetoUserRow;
      /** id de Supabase Auth (`auth.users.id`), distinto de `user.id`. */
      authId: string;
    }
  | { ok: false; response: NextResponse };

/**
 * Usuario Neto detras de la sesion actual, o la respuesta de error que la ruta
 * debe devolver tal cual.
 *
 * ```ts
 * const auth = await requireNetoUser('id, plan');
 * if (!auth.ok) return auth.response;
 * // auth.user.id
 * ```
 *
 * `columns` se pasa a `.select()`; siempre incluye `id` aunque no se pida.
 */
export async function requireNetoUser(columns = 'id'): Promise<NetoUserAuth> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const select = columns.split(',').some((c) => ['id', '*'].includes(c.trim()))
    ? columns
    : `id, ${columns}`;

  const { data, error } = await getServiceClient()
    .from('usuarios')
    .select(select)
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (error) {
    // El mensaje de Postgres no sale al cliente; queda en los logs de Vercel con
    // tag propio para poder distinguir esto de un 401 real en un incidente.
    console.error('[auth:usuarios] lectura fallida', {
      supabase_auth_id: user.id,
      code: error.code,
      message: error.message,
    });
    return {
      ok: false,
      response: NextResponse.json({ error: 'Error temporal, intenta de nuevo' }, { status: 500 }),
    };
  }

  if (!data) {
    return { ok: false, response: NextResponse.json({ error: 'User not found' }, { status: 404 }) };
  }

  return { ok: true, user: data as unknown as NetoUserRow, authId: user.id };
}

/**
 * Como `requireNetoUser`, mas el muro de lectura: responde **402 Payment Required**
 * si el usuario ya termino su prueba de 14 dias y no pago.
 *
 * La regla del producto es que **escribir nunca se corta; lo que se cobra es leer**
 * (ver `lib/trial.js` en el backend). Toda ruta que devuelva data acumulada del
 * usuario — su dashboard, sus transacciones, sus presupuestos, su score — tiene que
 * usar este helper y no `requireNetoUser` a secas.
 *
 * Gatear solo en el cliente seria cosmetico: quien tenga la sesion puede pegarle a
 * `/api/dashboard` directo y llevarse exactamente lo que el muro cobra.
 *
 * Durante el trial `plan` vale `'premium'`, asi que el usuario en prueba pasa este
 * check sin ningun caso especial — es el mismo truco que hace que los ~40 gates de
 * Pro funcionen sin tocarse.
 *
 * ```ts
 * const auth = await requireLectura('id, plan');
 * if (!auth.ok) return auth.response;
 * ```
 *
 * `columns` siempre incluye `plan` aunque no se pida (es lo que decide el muro).
 */
export async function requireLectura(columns = 'id'): Promise<NetoUserAuth> {
  const conPlan = columns.split(',').some((c) => ['plan', '*'].includes(c.trim()))
    ? columns
    : `${columns}, plan`;

  const auth = await requireNetoUser(conPlan);
  if (!auth.ok) return auth;

  if (auth.user.plan !== 'premium') {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'trial_terminado',
          message: 'Tu prueba de Neto Pro terminó. Tus datos siguen guardados.',
        },
        { status: 402 },
      ),
    };
  }

  return auth;
}

/**
 * Igual que `requireNetoUser` pero para los sitios donde NO tener fila es el
 * caso normal, no un error (el onboarding, el callback de auth): distingue
 * "no hay fila" de "la lectura se cayo" sin decidir la respuesta HTTP.
 *
 * Lanza si la lectura falla. Devuelve null si no hay sesion o no hay fila.
 */
export async function findNetoUser(columns = 'id'): Promise<NetoUserRow | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await getServiceClient()
    .from('usuarios')
    .select(columns)
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`No se pudo leer el usuario: ${error.message}`);
  }
  return (data as unknown as NetoUserRow) ?? null;
}
