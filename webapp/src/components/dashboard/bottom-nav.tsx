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

const navItems = [
  { label: 'Inicio', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Movimientos', href: '/dashboard/transacciones', icon: ArrowLeftRight },
  { label: 'Presupuestos', href: '/dashboard/presupuestos', icon: Target },
  { label: 'Reporte', href: '/dashboard/reportes', icon: FileBarChart },
  { label: 'Suscripc.', href: '/dashboard/suscripciones', icon: CreditCard },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 md:hidden border-t border-[rgba(240,239,232,0.08)] bg-[#0E0E0C] safe-area-bottom">
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
              className={cn(
                'relative flex flex-col items-center gap-1 rounded-xl px-3 py-2 min-w-[60px] min-h-[56px] transition-all duration-200 active:scale-95',
                isActive
                  ? 'text-[#1D9E75]'
                  : 'text-[#8A877D] active:text-[#C8C6BC]'
              )}
            >
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-[#1D9E75]" />
              )}
              <item.icon className={cn('h-[22px] w-[22px] transition-transform', isActive && 'drop-shadow-[0_0_6px_rgba(29,158,117,0.5)] scale-110')} />
              <span className="text-[11px] font-medium leading-none tracking-tight">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
