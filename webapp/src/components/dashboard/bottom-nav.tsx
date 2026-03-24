'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Target,
  FileBarChart,
  MoreHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { label: 'Inicio', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Movimientos', href: '/dashboard/transacciones', icon: ArrowLeftRight },
  { label: 'Metas', href: '/dashboard/presupuestos', icon: Target },
  { label: 'Reportes', href: '/dashboard/reportes', icon: FileBarChart },
  { label: 'Más', href: '/dashboard/configuracion', icon: MoreHorizontal },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 md:hidden border-t border-[rgba(255,255,255,0.06)] bg-[#0E0E0C]/95 backdrop-blur-xl safe-area-bottom">
      <div className="flex items-center justify-around px-1 py-1">
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
                'relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-2 min-w-[56px] transition-colors',
                isActive
                  ? 'text-[#1D9E75]'
                  : 'text-[#8A877D] active:text-[#C8C6BC]'
              )}
            >
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-[#1D9E75]" />
              )}
              <item.icon className={cn('h-5 w-5 transition-transform', isActive && 'drop-shadow-[0_0_6px_rgba(29,158,117,0.5)] scale-110')} />
              <span className="text-[10px] font-medium leading-none">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
