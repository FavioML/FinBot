import type { Usuario } from '@/lib/types';
import { tieneWhatsapp } from '@/lib/whatsapp-vinculo';

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
 *
 * Vive en su propio módulo (12-sep-2026) porque la cache `['user']` tiene DOS puertas y las dos
 * tienen que pasar por acá: el fetch directo de `use-user.ts` y el seed del bootstrap
 * (`use-dashboard-bootstrap.tsx`), que antes guardaba la fila de `/api/dashboard` tal cual.
 * Importarla desde `use-user` cerraba un ciclo, porque `use-user` ya importa del bootstrap.
 */
export const COLUMNAS_SENSIBLES = [
  'gmail_access_token',
  'gmail_refresh_token',
  'gmail_token_expiry',
  // El BSUID es el identificador opaco que Meta le da a esta persona PARA ESTE NEGOCIO.
  // La webapp no lo usa para nada y es la clave con la que se la reconoce cuando ya no
  // manda su número.
  'bsuid',
] as const;

export function quitarSensibles(fila: Usuario | null): Usuario | null {
  if (!fila) return fila;
  const copia = { ...fila } as unknown as Record<string, unknown>;
  // Se deriva ANTES de borrar el `bsuid`: quien se vinculó sin mostrar su número tiene solo esa
  // columna, y sin este booleano la pantalla lo trataría como "sin WhatsApp" (12-sep-2026).
  copia.tiene_whatsapp = tieneWhatsapp(copia);
  for (const c of COLUMNAS_SENSIBLES) delete copia[c];
  return copia as unknown as Usuario;
}
