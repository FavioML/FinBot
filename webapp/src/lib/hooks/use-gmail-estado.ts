'use client';

import { useQuery } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { useBootstrapGate } from '@/lib/hooks/use-dashboard-bootstrap';

export interface GmailEstado {
  /** Instante en que Google rechazó el refresh token. null = sana, o no hay cuenta conectada. */
  authErrorAt: string | null;
}

/**
 * Estado de la conexión de Gmail, para el banner del shell.
 *
 * Lo siembra el bootstrap consolidado (`/api/dashboard`), igual que `useUser`, y por la misma
 * razón: un `useQuery` suelto en el shell resucita el fan-out de requests que ese endpoint
 * existe para matar. El `queryFn` es solo el fallback para cuando la key no vino sembrada
 * (deploy viejo del backend, o el hook usado fuera del shell).
 *
 * Gated por `useBootstrapGate()`: sin el gate este fetch gana la carrera contra el bootstrap
 * y el fallback se convierte en el camino normal.
 *
 * `enabled` NO es cosmético. Al usuario en el muro, `/api/dashboard` le responde 402, así que
 * NADA se siembra y este hook caía siempre a su fetch de fallback — resucitando, justo para
 * ellos, el fan-out que el bootstrap existe para matar. Y era gasto puro: sin Pro pagado el
 * `checkGmailHuerfanos` ya les revocó la cuenta, o sea que nunca hay nada que avisar. Son 42
 * de 48 usuarios con webapp.
 */
export function useGmailEstado({ enabled = true }: { enabled?: boolean } = {}) {
  const gate = useBootstrapGate();
  return useQuery<GmailEstado>({
    queryKey: ['gmail-estado'],
    enabled: !IS_DEMO && gate && enabled,
    staleTime: 1000 * 60 * 5,
    queryFn: async () => {
      const r = await fetch('/api/pro/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('No se pudo leer el estado de Gmail');
      const j = await r.json();
      return { authErrorAt: (j.gmailAuthErrorAt as string | null) ?? null };
    },
  });
}
