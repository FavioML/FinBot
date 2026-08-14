'use client';

import { Toaster } from 'sonner';

/**
 * El `<Toaster>` de Sonner con la configuración de Neto.
 *
 * **Va UNA sola vez, en el root layout, y ahí se queda.** Dos `<Toaster>` en el árbol
 * pintan dos contenedores y cada toast sale duplicado.
 *
 * Se intentó bajarlo a cada superficie que llama a `toast()` para sacar sonner del bundle
 * de `/login` (hallazgo P′8, 9.2 KB gzip). **No se puede**, y el motivo es del diseño de
 * sonner, no del nuestro: el `<Toaster>` se suscribe al observer cuando se monta y arranca
 * con la lista vacía — no re-emite lo publicado antes. O sea que un `toast()` seguido de
 * una navegación que desmonte el árbol donde vive el Toaster **no se ve en ningún lado**.
 * Pasa en los dos avisos de éxito que más importan: el "Sesión cerrada" de `user-menu`
 * (empuja a `/`) y el "Cuenta verificada" del onboarding (puede aterrizar en `/join/*`).
 *
 * Existe como componente y no inline en el layout para que la configuración tenga un solo
 * dueño, y para que el motivo de arriba viva pegado a la decisión.
 */
export function AppToaster() {
  return (
    <Toaster
      theme="dark"
      position="bottom-right"
      toastOptions={{
        style: {
          background: '#1A1A18',
          border: '1px solid rgba(255,255,255,0.08)',
          color: '#F0EFE8',
          fontSize: '14px',
        },
      }}
    />
  );
}
