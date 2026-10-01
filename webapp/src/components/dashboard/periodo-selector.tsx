'use client';

import { useState, useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { MonthSelector } from '@/components/dashboard/month-selector';
import {
  type Periodo,
  type TipoPeriodo,
  MAX_DIAS_RANGO,
  lunesDe,
  sumarDias,
} from '@/lib/periodo-reporte';

const PARAMS_DE_PERIODO = ['mes', 'semana', 'desde', 'hasta'] as const;

/**
 * Mes | Semana | Rango para Reportes. El periodo vive en la URL (igual que `?mes=`), así un
 * reporte se puede compartir o abrir desde un aviso. Cambiar de modo borra los parámetros del
 * modo anterior, porque `resolverPeriodo` les da precedencia y uno viejo se impondría.
 *
 * El padre lo monta con una `key` hecha del periodo (tipo y fechas): así el estado local (la
 * pestaña elegida y las fechas del rango a medio escribir) se reinicia cada vez que la URL
 * cambia de periodo, sin un efecto. Con la key solo por tipo, pasar de una semana a otra
 * dejaba el rango precargado con las fechas de la semana anterior.
 */
export function PeriodoSelector({ periodo, hoy }: { periodo: Periodo; hoy: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const ultimoDia = sumarDias(periodo.hasta, -1);
  const [modo, setModo] = useState<TipoPeriodo>(periodo.tipo);
  const [desde, setDesde] = useState(periodo.desde);
  const [hasta, setHasta] = useState(ultimoDia > hoy ? hoy : ultimoDia);

  const navegar = useCallback(
    (valores: Partial<Record<(typeof PARAMS_DE_PERIODO)[number], string>>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const k of PARAMS_DE_PERIODO) params.delete(k);
      for (const [k, v] of Object.entries(valores)) if (v) params.set(k, v);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  // Al cambiar de modo se conserva el contexto: la semana o el mes del último día que se veía.
  const referencia = ultimoDia > hoy ? hoy : ultimoDia;

  const cambiarModo = (valor: TipoPeriodo) => {
    setModo(valor);
    if (valor === 'mes') navegar({ mes: `${referencia.slice(0, 4)}-${Number(referencia.slice(5, 7))}` });
    if (valor === 'semana') navegar({ semana: lunesDe(referencia) });
    // 'rango' no navega: espera a que se elijan las fechas y se aplique.
  };

  const esSemanaActual = periodo.tipo === 'semana' && periodo.desde >= lunesDe(hoy);
  const rangoValido = Boolean(desde && hasta && desde <= hasta && hasta <= hoy);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={modo} onValueChange={(v) => cambiarModo(v as TipoPeriodo)}>
          <TabsList>
            <TabsTrigger value="mes">Mes</TabsTrigger>
            <TabsTrigger value="semana">Semana</TabsTrigger>
            <TabsTrigger value="rango">Rango</TabsTrigger>
          </TabsList>
        </Tabs>

        {modo === 'mes' && periodo.tipo === 'mes' && (
          <MonthSelector hoy={hoy} value={`${periodo.desde.slice(0, 4)}-${Number(periodo.desde.slice(5, 7))}`} />
        )}

        {modo === 'semana' && periodo.tipo === 'semana' && (
          <div className="flex items-center gap-1 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Semana anterior"
              className="text-[#C8C6BC]"
              onClick={() => navegar({ semana: sumarDias(periodo.desde, -7) })}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[120px] text-center text-sm text-[#F0EFE8] tabular-nums">{periodo.etiqueta}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Semana siguiente"
              className="text-[#C8C6BC]"
              disabled={esSemanaActual}
              onClick={() => navegar({ semana: sumarDias(periodo.desde, 7) })}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {modo === 'rango' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-[#8A877D]">
            Desde
            <input
              type="date"
              value={desde}
              max={hoy}
              onChange={(e) => setDesde(e.target.value)}
              className="form-input h-9 px-3 text-sm [color-scheme:dark]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[#8A877D]">
            Hasta
            <input
              type="date"
              value={hasta}
              min={desde || undefined}
              max={hoy}
              onChange={(e) => setHasta(e.target.value)}
              className="form-input h-9 px-3 text-sm [color-scheme:dark]"
            />
          </label>
          <Button
            size="sm"
            className="h-9 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
            disabled={!rangoValido}
            onClick={() => navegar({ desde, hasta })}
          >
            Ver
          </Button>
          <p className="w-full text-xs text-[#8A877D]">
            {periodo.recortado
              ? `Mostramos los últimos ${MAX_DIAS_RANGO} días del rango que elegiste: es el máximo por reporte.`
              : `Hasta ${MAX_DIAS_RANGO} días por reporte.`}
          </p>
        </div>
      )}
    </div>
  );
}
