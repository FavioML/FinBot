'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Usuario } from '@/lib/types';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_USER } from '@/lib/demo/mock-data';
import { useBootstrapGate } from '@/lib/hooks/use-dashboard-bootstrap';

/**
 * Espejo cliente de `requireNetoUser` (`lib/supabase/auth.ts`): sesion -> fila de
 * `usuarios`. Aca no hay codigos HTTP, pero la distincion es la misma y por las
 * mismas razones.
 *
 * **Lanza si la lectura falla.** Tragarse el `error` era peor que un reintento
 * fallido: la queryFn TERMINABA BIEN con `null`, asi que React Query lo cacheaba
 * como resultado valido (`retry` solo cubre promesas rechazadas) y lo persistia
 * 24h en localStorage. Ese `null` no es neutro:
 *
 * - `canAccess(user?.plan, ...)` trata `undefined` como Free (`lib/plan.ts`), o
 *   sea que un usuario Pro pierde calendario, consejo IA, breakdown del score y
 *   come los limites de metas y presupuestos.
 * - `AuthRedirect` (`dashboard-shell.tsx`) lee `null` como "no tiene fila" y
 *   manda a `/onboarding` a re-registrarse por OTP a alguien que ya existe.
 *
 * Con el throw, React Query reintenta, no contamina la cache persistida, y el
 * `null` vuelve a significar una sola cosa: no hay fila.
 */
/**
 * Columnas de `usuarios` que NO pueden llegar al browser (hallazgo D9).
 *
 * `select('*')` se queda a propósito: enumerar columnas acá significa que agregar una a la
 * tabla la deja fuera del hook EN SILENCIO, y el consumidor la lee como `undefined`. Con
 * `*` + lista negra pasa lo contrario, que es la dirección segura: una columna nueva llega,
 * y si es sensible hay que agregarla acá.
 *
 * Por qué importa más de lo que parece: esta respuesta va a la cache de React Query, y esa
 * cache está PERSISTIDA (`PersistQueryClientProvider` en `dashboard-shell.tsx`), o sea que
 * termina en el localStorage del navegador. Los tokens de Gmail están cifrados, pero un
 * secreto cifrado en localStorage sigue siendo un secreto en localStorage.
 *
 * Medido antes de quitarlas: cero lecturas de estas columnas en `src/` fuera de `api/`.
 */
const COLUMNAS_SENSIBLES = [
  'gmail_access_token',
  'gmail_refresh_token',
  'gmail_token_expiry',
  // El BSUID es el identificador opaco que Meta le da a esta persona PARA ESTE NEGOCIO.
  // La webapp no lo usa para nada y es la clave con la que se la reconoce cuando ya no
  // manda su número.
  'bsuid',
] as const;

function quitarSensibles(fila: Usuario | null): Usuario | null {
  if (!fila) return fila;
  const copia = { ...fila } as unknown as Record<string, unknown>;
  for (const c of COLUMNAS_SENSIBLES) delete copia[c];
  return copia as unknown as Usuario;
}

export async function fetchNetoUser(): Promise<Usuario | null> {
  if (IS_DEMO) return DEMO_USER;

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // maybeSingle (not single): este fetch directo puede correr en una carrera
  // antes de que el token de auth propague; entonces RLS devuelve 0 filas y
  // single() responde 406 (visible en consola). maybeSingle() separa limpio las
  // 0 filas (data null) de la lectura caida (error).
  const { data, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`No se pudo leer el usuario: ${error.message}`);
  }
  return quitarSensibles(data);
}

export function useUser() {
  // Gate: en el dashboard, el bootstrap consolidado (/api/dashboard) siembra
  // ['user']. Sin el gate, este fetch directo ganaría la carrera y activaría el
  // waterfall de hooks gated por userId antes de que se siembren los dominios.
  // Fuera del shell no hay provider → gate=true → self-fetch normal.
  const gate = useBootstrapGate();
  return useQuery({
    queryKey: ['user'],
    enabled: IS_DEMO || gate,
    queryFn: fetchNetoUser,
  });
}

export type AuthRedirectDecision =
  /** Todavia no se sabe: cache restaurando, query en vuelo, o la lectura se cayo. */
  | 'esperar'
  /** Hay fila: el usuario esta donde tiene que estar. */
  | 'quedarse'
  /** No hay fila: hay que ver si tiene sesion (-> /onboarding) o no (-> /login). */
  | 'revisar-sesion';

/**
 * Decide si el shell expulsa al usuario del dashboard.
 *
 * Esta separado del componente para poder probarlo: es la pieza que convierte
 * un hipo de Supabase en "tu cuenta no existe", y el caso `error` es justo el
 * que no se ve mirando el happy path.
 *
 * `error` NO puede caer en 'revisar-sesion'. Con la lectura caida no sabemos si
 * el usuario tiene fila; asumir que no la tiene es expulsar a alguien que sí
 * existe. Esperar es correcto: React Query reintenta y, si de verdad no hay
 * fila, la proxima lectura buena lo manda a `/onboarding` igual.
 */
export function decidirRedirectAuth(estado: {
  isRestoring: boolean;
  isPending: boolean;
  isError: boolean;
  user: Usuario | null | undefined;
}): AuthRedirectDecision {
  if (estado.isRestoring || estado.isPending) return 'esperar';
  if (estado.isError) return 'esperar';
  if (estado.user) return 'quedarse';
  return 'revisar-sesion';
}
