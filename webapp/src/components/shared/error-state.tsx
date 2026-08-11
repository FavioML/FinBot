'use client';

import { AlertTriangle, type LucideIcon } from 'lucide-react';

/**
 * Un fetch que falla NO es "no tienes nada".
 *
 * El patrón que este componente reemplaza es `const { data: x = [] } = useAlgo()`: con el
 * default puesto y sin mirar `isError`, una caída de red renderiza exactamente el mismo
 * empty state que un usuario recién creado. Al que tiene 400 gastos anotados le dice que no
 * tiene ninguno, que es la peor cosa que le puede decir un producto de finanzas — y encima
 * sin un botón para reintentar, así que la salida es recargar o irse.
 *
 * El texto vive acá y no en cada página por un motivo concreto: estaba copiado en cuatro
 * archivos (dashboard, deudas, espacios, suscripciones) y ya había divergido en el tamaño
 * del título. Este componente es esas cuatro copias unificadas más las seis páginas que no
 * lo tenían (hallazgo F4 de la auditoría del 2026-08-10).
 *
 * **La condición de uso importa tanto como el componente.** Va con
 * `isError && data.length === 0`, no con `isError` a secas: react-query conserva la data
 * anterior mientras reintenta, y tapar una lista que el usuario está viendo por un fallo de
 * refetch es peor que el fallo. La única excepción es una página cuya vista entera se
 * construye desde una sola query sin cache útil.
 */

interface ErrorStateProps {
  /** Qué no se pudo cargar, en las palabras del usuario: "tus gastos", "tu score". */
  titulo: string;
  /** Vuelve a intentar la query. Es `refetch` de react-query. */
  onReintentar: () => void;
  /** `page` ocupa la pantalla (la página entera falló); `card` va dentro de un layout. */
  variante?: 'page' | 'card';
  icono?: LucideIcon;
  descripcion?: string;
  /** Se renderiza bajo el boton. Para la salida secundaria de una vista de detalle
   *  ("volver al listado"), que no todas las paginas necesitan. */
  children?: React.ReactNode;
}

const BOTON =
  'inline-flex items-center gap-2 rounded-lg bg-[#1D9E75] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1D9E75]/90';

export function ErrorState({
  titulo,
  onReintentar,
  variante = 'page',
  icono: Icono = AlertTriangle,
  // "Tu información está a salvo" no es relleno: el miedo concreto que produce ver el
  // dashboard vacío es haber perdido los datos.
  descripcion = 'Revisa tu conexión e inténtalo de nuevo. Tu información está a salvo.',
  children,
}: ErrorStateProps) {
  const cuerpo = (
    <div className="glass-card flex w-full flex-col items-center gap-3 p-8 text-center">
      <Icono className="h-10 w-10 text-[#8A877D]/50" />
      <h2 className="text-lg font-semibold text-[#F0EFE8]">{titulo}</h2>
      <p className="max-w-xs text-sm text-[#8A877D]">{descripcion}</p>
      <button type="button" onClick={onReintentar} className={BOTON}>
        Reintentar
      </button>
      {children}
    </div>
  );

  if (variante === 'card') return cuerpo;
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md">{cuerpo}</div>
    </div>
  );
}
