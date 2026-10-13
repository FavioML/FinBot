'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Target,
  FileBarChart,
  CreditCard,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { haptic } from '@/lib/haptics';
import { usePrefetchNav } from '@/lib/hooks/use-dashboard-bootstrap';

const navItems = [
  { label: 'Inicio', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Movimientos', href: '/dashboard/transacciones', icon: ArrowLeftRight },
  { label: 'Presupuestos', href: '/dashboard/presupuestos', icon: Target },
  { label: 'Reporte', href: '/dashboard/reportes', icon: FileBarChart },
  { label: 'Suscripc.', href: '/dashboard/suscripciones', icon: CreditCard },
];

export function BottomNav() {
  const pathname = usePathname();
  // Ver `usePrefetchNav`: estas 5 rutas se prefetchean, pero no mientras el arranque
  // del dashboard todavia esta pidiendo lo que el usuario esta mirando.
  const prefetch = usePrefetchNav();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 md:hidden border-t border-border bg-nav safe-area-bottom">
      <div className="flex items-center justify-around px-1 pt-2 pb-1.5">
        {navItems.map((item) => {
          const isActive =
            item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={prefetch}
              onClick={() => haptic('tap')}
              className={cn(
                'relative flex flex-col items-center gap-1 rounded-xl px-1.5 py-2 min-w-[60px] min-h-[56px] transition-all duration-200 active:scale-95',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground active:text-foreground-soft'
              )}
            >
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-primary" />
              )}
              <item.icon className={cn('h-[22px] w-[22px] transition-transform', isActive && 'drop-shadow-[0_0_6px_color-mix(in_srgb,var(--primary)_50%,transparent)] scale-110')} />
              <span className="text-xs font-medium leading-none tracking-tight">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
