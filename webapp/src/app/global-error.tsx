'use client';

import { useEffect } from 'react';

// Error boundary raíz: reemplaza al root layout si algo falla arriba del árbol. Debe renderizar
// su propio <html>/<body>. Estilos inline (el CSS del layout puede no estar disponible aquí).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global] error boundary:', error);
  }, [error]);

  return (
    // Reemplaza al root layout, así que acá no hay globals.css ni script de tema: los colores van
    // literales (paleta B) con light-dark(), que sigue el esquema del sistema.
    <html lang="es" style={{ colorScheme: 'light dark' }}>
      <body
        style={{
          background: 'light-dark(#EDF5F0, #07120E)',
          color: 'light-dark(#0A1D15, #EEF8F3)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          margin: 0,
        }}
      >
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Algo salió mal</h2>
            <p style={{ fontSize: 14, color: 'light-dark(#486155, #9DBAAC)', marginBottom: 20 }}>
              Ocurrió un error inesperado. Intenta recargar la página.
            </p>
            <button
              onClick={() => reset()}
              style={{
                background: 'light-dark(#117C59, #3BE0A6)',
                color: 'light-dark(#FFFFFF, #03211A)',
                border: 'none',
                borderRadius: 8,
                padding: '10px 18px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reintentar
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
