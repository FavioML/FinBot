'use client';

import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import {
  TEMA_EVENTO,
  TEMA_KEY,
  guardarPreferencia,
  leerPreferencia,
  leerTemaResuelto,
  type PreferenciaTema,
  type TemaResuelto,
} from '@/lib/tema';

// Lee el tema que YA aplicó el script inline de `lib/tema.ts`; no decide nada por su cuenta.
// `useSyncExternalStore` con un snapshot de servidor fijo evita el desajuste de hidratación sin
// el patrón `mounted`: en la hidratación usa el del servidor y re-renderiza con el real.

function suscribir(cb: () => void) {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  const enStorage = (e: StorageEvent) => {
    if (e.key === TEMA_KEY) cb();
  };
  window.addEventListener(TEMA_EVENTO, cb);
  window.addEventListener('storage', enStorage);
  mq?.addEventListener?.('change', cb);
  return () => {
    window.removeEventListener(TEMA_EVENTO, cb);
    window.removeEventListener('storage', enStorage);
    mq?.removeEventListener?.('change', cb);
  };
}

const snapshot = () => `${leerPreferencia()}|${leerTemaResuelto()}`;
const snapshotServidor = () => 'system|dark';

export function useTema() {
  const valor = useSyncExternalStore(suscribir, snapshot, snapshotServidor);
  const [preferencia, resuelto] = valor.split('|') as [PreferenciaTema, TemaResuelto];

  // En dev, Strict Mode remonta y React resetea los atributos de <html> que no maneja, borrando
  // el `data-theme` del script. Re-disparar el evento lo reaplica. En producción es un no-op.
  useLayoutEffect(() => {
    window.dispatchEvent(new Event(TEMA_EVENTO));
  }, []);

  const setPreferencia = useCallback((p: PreferenciaTema) => guardarPreferencia(p), []);
  const alternar = useCallback(() => guardarPreferencia(leerTemaResuelto() === 'dark' ? 'light' : 'dark'), []);

  return { preferencia, resuelto, setPreferencia, alternar };
}
