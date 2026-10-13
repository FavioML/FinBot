'use client';

import { Toaster } from 'sonner';
import { useTema } from '@/lib/hooks/use-tema';

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
  // El tema de sonner pinta lo que el `style` de abajo no cubre (descripción, botón de cerrar).
  // Sigue al tema RESUELTO de la app, no a `system`: el usuario puede haber elegido lo contrario.
  const { resuelto } = useTema();
  return (
    <Toaster
      theme={resuelto}
      position="bottom-right"
      toastOptions={{
        style: {
          background: 'var(--surface-elevated)',
          border: '1px solid var(--border)',
          color: 'var(--foreground)',
          fontSize: '14px',
        },
        // Sin esto el ícono sale del color del texto y un error se distingue de un éxito sólo
        // por la forma. No es `richColors`: ese trae su propia paleta (rompe colores-por-token).
        // Va con `-ink` porque el fondo es `surface-elevated` (tinta-sobre-tinte.test.ts).
        classNames: {
          error: '[&_[data-icon]]:text-negative-ink',
          success: '[&_[data-icon]]:text-positive-ink',
          warning: '[&_[data-icon]]:text-warning-ink',
          info: '[&_[data-icon]]:text-info-ink',
        },
      }}
    />
  );
}
