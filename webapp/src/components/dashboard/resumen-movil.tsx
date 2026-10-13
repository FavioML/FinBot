import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface Cifra {
  etiqueta: string;
  valor: ReactNode;
  /** Clase de color del número (`text-negative`, `text-positive`...). */
  colorValor?: string;
  icono?: LucideIcon;
  colorIcono?: string;
}

/**
 * Las cifras de resumen de una pantalla, en celular: UNA tarjeta, una cifra por renglón.
 *
 * Transacciones, Presupuestos y Planes abrían con tres tarjetas a todo el ancho para tres números,
 * y a 390 px la primera pantalla no mostraba nada más. Desde `sm` cada página sigue pintando sus
 * tres tarjetas en fila (con `hidden sm:grid`); esta versión se oculta ahí. Las dos viven en el DOM
 * y el corte lo hace el CSS, como el hero de `kpi-cards`: un hook de ancho no sabe cuál es en el
 * primer pintado.
 */
export function ResumenMovil({ cifras }: { cifras: Cifra[] }) {
  return (
    <div className="glass-card divide-y divide-border px-4 sm:hidden">
      {cifras.map(({ etiqueta, valor, colorValor, icono: Icono, colorIcono }) => (
        <div key={etiqueta} className="flex items-center justify-between gap-3 py-3">
          <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            {Icono && <Icono className={`h-4 w-4 shrink-0 ${colorIcono ?? ''}`} aria-hidden />}
            <span className="truncate">{etiqueta}</span>
          </span>
          <span className={`shrink-0 text-lg font-semibold tabular-nums ${colorValor ?? 'text-foreground'}`}>
            {valor}
          </span>
        </div>
      ))}
    </div>
  );
}
