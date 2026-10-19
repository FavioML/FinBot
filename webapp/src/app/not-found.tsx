'use client';

import Link from 'next/link';
import Image from 'next/image';
import { Home, ArrowLeft } from 'lucide-react';

/**
 * El 404, y la razón por la que ya no usa `motion`.
 *
 * Next incluye el `not-found` de la raíz en el árbol de cliente de TODA ruta, así que las
 * cuatro entradas escalonadas de esta pantalla estaban costando el bundle entero de
 * `motion` (**38.7 KB gzip**) en `/login`, `/onboarding` y en cualquier pantalla que el
 * usuario abra primero — una animación decorativa de la pantalla de error, cobrada en la
 * pantalla de éxito. Es el hallazgo P′8, y no se veía quitando `motion` de `/login`: sacarlo
 * de ahí bajaba 0.1 KB, porque el que lo arrastraba era este archivo.
 *
 * Las mismas entradas ahora salen del keyframe `fade-up` de `globals.css`, que además
 * respeta `prefers-reduced-motion` por el bloque global.
 *
 * **Si vas a animar algo acá, hacelo con CSS.** Cualquier librería de animación que entre
 * a este archivo se la cobra toda la app.
 */
const ENTRADA = 'animate-[fade-up_0.5s_cubic-bezier(0.16,1,0.3,1)_both]';

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background px-6 text-center">
      {/* Logo */}
      <div className={ENTRADA}>
        <div className="mb-6 flex items-center justify-center gap-3">
          <Image
            src="/neto-icon.png"
            alt="NETO"
            width={56}
            height={56}
            priority
            className="h-14 w-14 rounded-xl object-contain"
          />
          <span className="text-xl font-bold text-foreground">NETO</span>
        </div>
      </div>

      {/* 404 number */}
      <h1 className={`text-7xl font-bold text-primary mb-2 ${ENTRADA} [animation-delay:100ms]`}>
        404
      </h1>

      {/* Message */}
      <div className={`${ENTRADA} [animation-delay:200ms]`}>
        <h2 className="text-xl font-semibold text-foreground mb-2">
          Pagina no encontrada
        </h2>
        <p className="text-sm text-muted-foreground max-w-sm mb-8">
          La pagina que buscas no existe o fue movida. Vuelve al inicio para seguir controlando tus finanzas.
        </p>
      </div>

      {/* Actions */}
      <div className={`flex flex-col sm:flex-row gap-3 ${ENTRADA} [animation-delay:300ms]`}>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 hover:shadow-primary/30"
        >
          <Home className="h-4 w-4" />
          Ir al dashboard
        </Link>
        <button
          onClick={() => window.history.back()}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-foreground/3 px-6 py-3 text-sm font-medium text-foreground-soft transition-all hover:bg-foreground/6"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver atras
        </button>
      </div>
    </div>
  );
}
