// El monto de UNA transacción, pintado igual en todas las pantallas.
//
// Primario: lo que la persona pagó, en su moneda. Secundario: el equivalente en
// soles, y solo cuando la moneda no es PEN. La regla y el porqué viven en
// `lib/tx-monto.ts`; acá vive nada más el render.
//
// En una fila PEN esto renderiza UN solo <span>, idéntico al que había antes de
// centralizar: el 94.84% de las filas no cambia de forma. La segunda línea
// aparece únicamente donde hace falta.

import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { formatTxMonto, formatTxMontoPen, type TxMonto as TxMontoData } from '@/lib/tx-monto';

interface TxMontoProps {
  tx: TxMontoData;
  /** Prefijo de signo del call-site ('+' / '-'). Va pegado al primario. */
  signo?: string;
  /** Clases del monto primario. El secundario impone las suyas (tamaño y color). */
  className?: string;
  style?: CSSProperties;
  /**
   * Hacia dónde alinea la pila. `end` para los montos al borde derecho de una
   * fila flex (casi todos); `start` para la celda izquierda de la tabla de
   * escritorio, donde alinear a la derecha desplazaría el primario y rompería
   * la comparación vertical de la columna.
   */
  align?: 'start' | 'end';
}

export function TxMonto({ tx, signo = '', className, style, align = 'end' }: TxMontoProps) {
  const equivalente = formatTxMontoPen(tx);

  if (equivalente === null) {
    return (
      <span className={cn('tabular-nums', className)} style={style}>
        {signo}
        {formatTxMonto(tx)}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex flex-col leading-tight tabular-nums',
        align === 'end' ? 'items-end' : 'items-start',
        className
      )}
      style={style}
    >
      <span>
        {signo}
        {formatTxMonto(tx)}
      </span>
      <span className="text-[10px] font-normal text-[#8A877D]">≈ {equivalente}</span>
    </span>
  );
}
