'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { motion, AnimatePresence } from 'motion/react';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Target,
  FileBarChart,
  CreditCard,
  Flag,
  Landmark,
  Trophy,
  TrendingUp,
  AlertTriangle,
  Users,
  Settings,
  Shield,
  Crown,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SOCIAL_LINKS } from '@/lib/constants';
import { useIsAdmin } from '@/lib/hooks/use-is-admin';
import { usePrefetchNav } from '@/lib/hooks/use-dashboard-bootstrap';

const mainNav = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Transacciones', href: '/dashboard/transacciones', icon: ArrowLeftRight },
  { label: 'Presupuestos', href: '/dashboard/presupuestos', icon: Target },
  { label: 'Score', href: '/dashboard/score', icon: TrendingUp },
  { label: 'Alertas', href: '/dashboard/alertas', icon: AlertTriangle },
  { label: 'Espacios', href: '/dashboard/espacios', icon: Users },
  { label: 'Reporte PDF', href: '/dashboard/reportes', icon: FileBarChart },
  { label: 'Suscripciones', href: '/dashboard/suscripciones', icon: CreditCard },
  { label: 'Planes', href: '/dashboard/planes', icon: Flag },
  { label: 'Deudas', href: '/dashboard/deudas', icon: Landmark },
  { label: 'Logros', href: '/dashboard/logros', icon: Trophy },
];

const secondaryNav = [
  { label: 'Neto Pro', href: '/dashboard/pro', icon: Crown },
  { label: 'Configuracion', href: '/dashboard/configuracion', icon: Settings },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  // Ver `usePrefetchNav`: las 13 rutas del menu son la mayor parte de las 24 peticiones
  // RSC que salian a competir con el arranque. Se corren de lugar, no se apagan.
  const prefetch = usePrefetchNav();
  const { data: isAdmin } = useIsAdmin();

  const secondaryNavItems = [
    ...secondaryNav,
    ...(isAdmin
      ? [{ label: 'Admin', href: '/admin', icon: Shield }]
      : []),
  ];

  const sidebarContent = (
    <div className="flex h-full flex-col bg-[#141412] border-r border-[rgba(255,255,255,0.06)]">
      {/* Logo */}
      <div className="flex h-16 items-center justify-center px-4">
        <Link href="/dashboard" className="flex items-center justify-center">
          <Image
            src="/neto-icon.png"
            alt="NETO"
            width={48}
            height={48}
            loading="eager"
            priority
            className="h-12 w-12 rounded-xl object-contain mx-auto"
          />
        </Link>
        {/* Close button - mobile only */}
        <button
          onClick={onClose}
          className="ml-auto md:hidden rounded-md p-1 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 min-h-0 overflow-y-auto flex flex-col px-3 py-4">
        {/* Main nav */}
        <div className="space-y-1">
          {mainNav.map((item) => {
            const isActive =
              item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={prefetch}
                onClick={onClose}
                className={cn(
                  'relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                  isActive
                    ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75] glow-green shadow-[inset_2px_0_0_rgba(29,158,117,0.6)]'
                    : 'text-[#8A877D] hover:text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.03)]'
                )}
              >
                {isActive && (
                  <motion.div
                    className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[3px] rounded-r-full bg-[#1D9E75]"
                    layoutId="sidebar-active"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Secondary nav */}
        <div className="border-t border-[rgba(255,255,255,0.06)] pt-3 space-y-1">
          {secondaryNavItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={prefetch}
                onClick={onClose}
                className={cn(
                  'relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                  isActive
                    ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75] glow-green shadow-[inset_2px_0_0_rgba(29,158,117,0.6)]'
                    : item.label === 'Admin'
                      ? 'text-[#EF9F27] hover:text-[#EF9F27] hover:bg-[rgba(239,159,39,0.06)]'
                      : 'text-[#8A877D] hover:text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.03)]'
                )}
              >
                {isActive && (
                  <motion.div
                    className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[3px] rounded-r-full bg-[#1D9E75]"
                    layoutId="sidebar-active"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Bottom section - Social links + WhatsApp */}
      <div className="border-t border-[rgba(255,255,255,0.06)] px-3 py-4 space-y-3">
        <div className="flex items-center justify-center gap-4">
          <a
            href={SOCIAL_LINKS.facebook}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2.5 rounded-lg text-[#8A877D] hover:text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.03)] transition-colors"
            aria-label="Facebook"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>
          </a>
          <a
            href={SOCIAL_LINKS.instagram}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2.5 rounded-lg text-[#8A877D] hover:text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.03)] transition-colors"
            aria-label="Instagram"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
            </svg>
          </a>
          <a
            href={SOCIAL_LINKS.tiktok}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2.5 rounded-lg text-[#8A877D] hover:text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.03)] transition-colors"
            aria-label="TikTok"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 0010.86 4.48V13a8.28 8.28 0 005.58 2.15V11.7a4.79 4.79 0 01-3.77-1.82V6.69h3.77z"/>
            </svg>
          </a>
        </div>
        <a
          href={SOCIAL_LINKS.whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-lg bg-[#1D9E75] px-3 py-2 text-sm font-medium text-white hover:bg-[#1D9E75]/90 hover:shadow-lg hover:shadow-[#1D9E75]/20 transition-all active:scale-[0.98]"
        >
          Chatea con NETO
        </a>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:w-60 md:shrink-0">
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 bg-black/60"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          {/* Sidebar panel */}
          <motion.aside
            className="fixed inset-y-0 left-0 w-60 z-50"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
          >
            {sidebarContent}
          </motion.aside>
        </div>
      )}
      </AnimatePresence>
    </>
  );
}
