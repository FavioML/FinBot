'use client';

import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { NotificationBell } from './notification-bell';
import { UserMenu } from './user-menu';
import { ThemeToggle } from './theme-toggle';

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
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border md:hidden">
      <div className="flex min-w-0 items-center gap-3 px-4">
        <button
          onClick={onMenuClick}
          className="rounded-md p-2 text-muted-foreground hover:text-foreground-soft transition-colors"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="truncate text-sm font-medium text-foreground-soft">{title}</span>
      </div>
      <div className="flex items-center gap-2 px-4">
        <ThemeToggle />
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
    <div className="flex shrink-0 items-center gap-2 sm:gap-3 flex-nowrap">
      {children}
      <div className="hidden md:flex items-center gap-3">
        <ThemeToggle />
        <NotificationBell />
        <UserMenu />
      </div>
    </div>
  );
}
