'use client';

import Link from 'next/link';
import { Plus, FileText, Flag, CreditCard, PiggyBank } from 'lucide-react';
import { motion } from 'motion/react';
import { SOCIAL_LINKS } from '@/lib/constants';

const actions = [
  {
    label: 'Agregar gasto',
    icon: Plus,
    href: SOCIAL_LINKS.whatsapp,
    external: true,
    color: '#1D9E75',
  },
  {
    label: 'Reportes',
    icon: FileText,
    href: '/dashboard/reportes',
    color: '#EF9F27',
  },
  {
    label: 'Metas',
    icon: Flag,
    href: '/dashboard/metas',
    color: '#1D9E75',
  },
  {
    label: 'Presupuestos',
    icon: PiggyBank,
    href: '/dashboard/presupuestos',
    color: '#D85A30',
  },
  {
    label: 'Suscripciones',
    icon: CreditCard,
    href: '/dashboard/suscripciones',
    color: '#8A877D',
  },
];

export function QuickActions() {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1">
      {actions.map((action, i) => {
        const Icon = action.icon;
        const content = (
          <motion.div
            className="flex items-center gap-2 rounded-xl border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2 text-xs font-medium text-[#C8C6BC] whitespace-nowrap transition-all hover:bg-[rgba(255,255,255,0.05)] hover:border-[rgba(255,255,255,0.12)] hover:translate-y-[-1px] cursor-pointer shrink-0"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
          >
            <Icon className="h-3.5 w-3.5" style={{ color: action.color }} />
            {action.label}
          </motion.div>
        );

        if (action.external) {
          return (
            <a key={action.label} href={action.href} target="_blank" rel="noopener noreferrer">
              {content}
            </a>
          );
        }

        return (
          <Link key={action.label} href={action.href}>
            {content}
          </Link>
        );
      })}
    </div>
  );
}
