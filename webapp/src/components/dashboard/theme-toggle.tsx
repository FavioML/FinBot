'use client';

import { Moon, Sun } from 'lucide-react';
import { useTema } from '@/lib/hooks/use-tema';

/**
 * Sol/luna del topbar: alterna entre claro y oscuro sobre el tema que se VE, y guarda esa
 * elección. Volver a "seguir al sistema" se hace en Configuración → Apariencia.
 *
 * El ícono lo decide CSS (`dark:`), no el estado: el script de tema ya puso `data-theme` antes
 * de hidratar, así que el ícono correcto aparece desde el primer pintado sin depender de React.
 */
export function ThemeToggle() {
  const { resuelto, alternar } = useTema();
  return (
    <button
      type="button"
      onClick={alternar}
      className="rounded-lg p-2 text-muted-foreground hover:text-foreground-soft hover:bg-foreground/4 transition-all"
      aria-label={resuelto === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
      title="Cambiar tema"
    >
      <Sun className="h-5 w-5 hidden dark:block" />
      <Moon className="h-5 w-5 dark:hidden" />
    </button>
  );
}
