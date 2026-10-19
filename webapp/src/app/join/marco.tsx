import Image from 'next/image';
import { ENTRADA_TARJETA } from '@/lib/entrada';
// El link de WhatsApp del pie lleva `[invitacion|invitacion]`: sin corchete el alta quedaba NULL.
import { WA_INVITACION } from '@/lib/atribucion';

/**
 * El marco común de las cuatro pantallas de invitación: fondo, logo y la tarjeta que entra.
 *
 * Es un componente de SERVIDOR y eso es lo que importa acá: el logo es el primer elemento
 * *contentful* de la pantalla, así que va en el HTML inicial y no espera a ningún bundle.
 * La animación de entrada es `transform` (ver el docblock de `lib/entrada.ts`): nada nace
 * transparente, porque lo que está en `opacity: 0` no cuenta como primer pintado.
 */
export function MarcoInvitacion({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-background flex items-center justify-center p-4">
      <div className={`w-full max-w-sm ${ENTRADA_TARJETA} animation-duration-400`}>
        <div className="flex items-center justify-center gap-3 mb-8">
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
        {children}
      </div>
    </div>
  );
}

/** El pie de "¿No tienes cuenta NETO?" — va en gasto, deuda y espacio; la meta nunca lo tuvo. */
export function PieSinCuenta() {
  return (
    <div className="pt-3 border-t border-border text-center">
      <p className="text-xs text-muted-foreground mb-2">¿No tienes cuenta NETO?</p>
      {/* En celular los links miden 44 px de alto (regla táctil de globals.css): sin
          `inline-flex items-center` su texto queda arriba y la "o" centrada, 14 px más abajo. */}
      <div className="flex items-center justify-center gap-2 text-xs">
        <a href="/login" className="inline-flex items-center text-primary hover:underline">
          Regístrate en la app
        </a>
        <span className="text-muted-foreground">o</span>
        <a
          href={WA_INVITACION}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-primary hover:underline"
        >
          por WhatsApp
        </a>
      </div>
    </div>
  );
}
