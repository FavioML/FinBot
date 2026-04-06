'use client';

import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { NotificationBell } from './notification-bell';
import { UserMenu } from './user-menu';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/dashboard/transacciones': 'Transacciones',
  '/dashboard/presupuestos': 'Presupuestos',
  '/dashboard/reportes': 'Reporte PDF',
  '/dashboard/suscripciones': 'Suscripciones',
  '/dashboard/planes': 'Planes de ahorro',
  '/dashboard/deudas': 'Deudas',
  '/dashboard/logros': 'Logros',
  '/dashboard/configuracion': 'Configuracion',
  '/dashboard/score': 'Score',
  '/dashboard/alertas': 'Alertas',
  '/dashboard/espacios': 'Espacios',
};

interface TopbarProps {
  onMenuClick: () => void;
}

export function Topbar({ onMenuClick }: TopbarProps) {
  const pathname = usePathname();
  const title = PAGE_TITLES[pathname] || 'NETO';

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-[rgba(255,255,255,0.04)] md:hidden">
      <div className="flex items-center gap-3 px-4">
        <button
          onClick={onMenuClick}
          className="rounded-md p-2 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-[#C8C6BC]">{title}</span>
      </div>
      <div className="flex items-center gap-2 px-4">
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}

/** Reusable header actions — place in each page's top-right header area.
 *  Children (page-specific buttons) are always visible; bell+avatar only on
 *  desktop (they're already in the mobile Topbar). */
export function HeaderActions({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      {children}
      <div className="hidden md:flex items-center gap-3">
        <NotificationBell />
        <UserMenu />
      </div>
    </div>
  );
}
