'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Calendar } from 'lucide-react';
import { MESES } from '@/lib/constants';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

function generateMonthOptions(anioBase: number, mesBase: number) {
  const options: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(anioBase, mesBase - 1 - i, 1);
    const mes = d.getMonth() + 1;
    const anio = d.getFullYear();
    options.push({
      value: `${anio}-${mes}`,
      label: `${MESES[mes]} ${anio}`,
    });
  }
  return options;
}

/**
 * `hoy` y `value` son opcionales para no tocar a las pantallas que ya lo usan. Reportes los pasa
 * porque resuelve su mes con la fecha de Lima: sin ellos, un navegador en otra zona mostraba en
 * el select un mes distinto del que estaba pintando el reporte, justo alrededor de medianoche.
 */
export function MonthSelector({ hoy, value }: { hoy?: string; value?: string } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const now = new Date();
  const anioBase = hoy ? Number(hoy.slice(0, 4)) : now.getFullYear();
  const mesBase = hoy ? Number(hoy.slice(5, 7)) : now.getMonth() + 1;
  const defaultMonth = `${anioBase}-${mesBase}`;
  const selectedMonth = value || searchParams.get('mes') || defaultMonth;

  const monthOptions = generateMonthOptions(anioBase, mesBase);

  // La lista son los últimos 12 meses, pero desde la vista Año de un año pasado se puede llegar a
  // uno más viejo: sin esto el select quedaba sin la opción que está mostrando.
  const [anioSel0, mesSel0] = selectedMonth.split('-').map(Number);
  if (MESES[mesSel0] && !monthOptions.some((o) => o.value === selectedMonth)) {
    monthOptions.push({ value: selectedMonth, label: `${MESES[mesSel0]} ${anioSel0}` });
  }

  // El Select de base-ui pinta el VALUE crudo ("2026-9") si no se le da la etiqueta: se veía así
  // en todas las pantallas que usan este selector.
  const [anioSel, mesSel] = selectedMonth.split('-').map(Number);
  const etiqueta = MESES[mesSel] ? `${MESES[mesSel]} ${anioSel}` : selectedMonth;

  const handleChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set('mes', value);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  return (
    <Select value={selectedMonth} onValueChange={handleChange}>
      <SelectTrigger className="w-[190px] border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[#F0EFE8] hover:bg-[rgba(255,255,255,0.05)] hover:border-[rgba(255,255,255,0.12)] transition-colors">
        <div className="flex items-center gap-2">
          <Calendar className="h-3.5 w-3.5 text-[#8A877D]" />
          <SelectValue>{etiqueta}</SelectValue>
        </div>
      </SelectTrigger>
      <SelectContent className="bg-[#141412] border-[rgba(255,255,255,0.06)]">
        {monthOptions.map((opt) => (
          <SelectItem
            key={opt.value}
            value={opt.value}
            className="text-[#F0EFE8] focus:bg-[rgba(255,255,255,0.05)] focus:text-[#F0EFE8]"
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
