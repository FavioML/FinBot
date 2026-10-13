'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

/**
 * Error boundary de la RAÍZ del App Router (hallazgo F7 de la auditoría CTO del 2026-08-10).
 *
 * El único `error.tsx` de segmento que había era el de `/dashboard`, así que solo cubría lo
 * que se renderiza DENTRO del shell. Un throw en el layout del shell mismo (Topbar, banners,
 * providers) o en cualquier ruta fuera de `/dashboard` escapaba hasta `global-error.tsx`, y
 * ese reemplaza el documento entero: se pierden `<html>`, fuentes y estilos, o sea que el
 * usuario ve texto negro sobre blanco sin nada de Neto alrededor.
 *
 * Importa más de lo que parece por QUIÉN llega a esas rutas: `/join/*` y `/activar` son links
 * que la gente abre desde WhatsApp, muchas veces sin sesión y desde el navegador embebido de
 * la app. Un documento en blanco ahí no se lee como "hubo un error", se lee como que el link
 * era falso.
 *
 * Deliberadamente sin `motion`: este componente tiene que poder renderizar cuando algo de
 * arriba ya falló, así que cuantas menos dependencias arrastre, mejor. `global-error.tsx`
 * sigue existiendo para lo que ni esto puede atajar (un fallo del layout raíz).
 */

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RootError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error('[Root Error]', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="glass-card w-full max-w-md space-y-4 p-8 text-center">
        <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full border border-negative/25 bg-negative/10">
          <AlertTriangle className="h-7 w-7 text-negative-ink" />
        </div>
        <h1 className="text-xl font-bold text-foreground">Algo se rompió de nuestro lado</h1>
        <p className="text-sm text-muted-foreground">
          No es tu conexión y no perdiste nada: tus gastos siguen guardados. Reintenta en un
          momento.
        </p>
        {/* El `digest` es lo único que ata lo que vio el usuario con la fila del log del
            servidor. Sin él, un reporte por WhatsApp es imposible de rastrear. */}
        {error.digest && (
          <p className="font-mono text-xs text-muted-foreground/70">ref: {error.digest}</p>
        )}
        <div className="flex flex-col items-center gap-3 pt-1">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Reintentar
          </button>
          <Link href="/dashboard" className="text-sm text-primary hover:underline">
            Ir a mi dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
