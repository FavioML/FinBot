'use client';

import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { GlobalSearch } from '@/components/dashboard/global-search';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/dashboard/transacciones': 'Transacciones',
  '/dashboard/presupuestos': 'Presupuestos',
  '/dashboard/reportes': 'Reportes',
  '/dashboard/suscripciones': 'Suscripciones',
  '/dashboard/configuracion': 'Configuracion',
};

interface TopbarProps {
  onMenuClick: () => void;
}

export function Topbar({ onMenuClick }: TopbarProps) {
  const pathname = usePathname();
  const title = PAGE_TITLES[pathname] || 'NETO';

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[rgba(255,255,255,0.04)]">
      {/* Mobile: hamburger + title */}
      <div className="flex items-center gap-3 px-4 md:hidden">
        <button
          onClick={onMenuClick}
          className="rounded-md p-2 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-[#C8C6BC]">{title}</span>
      </div>

      {/* Desktop + mobile: search */}
      <div className="ml-auto px-4 flex items-center">
        <GlobalSearch />
      </div>
    </header>
  );
}
