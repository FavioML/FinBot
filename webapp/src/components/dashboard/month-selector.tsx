'use client';

import { useMemo, useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { MESES } from '@/lib/constants';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

function generateMonthOptions() {
  const now = new Date();
  const options: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mes = d.getMonth() + 1;
    const anio = d.getFullYear();
    options.push({
      value: `${anio}-${mes}`,
      label: `${MESES[mes]} ${anio}`,
    });
  }
  return options;
}

export function MonthSelector() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const selectedMonth = searchParams.get('mes') || defaultMonth;

  const monthOptions = useMemo(() => generateMonthOptions(), []);

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
      <SelectTrigger className="w-[180px] border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[#F0EFE8] hover:bg-[rgba(255,255,255,0.05)]">
        <SelectValue />
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
