'use client';

import Link from 'next/link';
import { Plus, FileText, Flag, CreditCard, PiggyBank } from 'lucide-react';
import { motion } from 'motion/react';

const actions = [
  {
    label: 'Agregar gasto',
    icon: Plus,
    href: '#',
    quickAdd: true,
    color: '#1D9E75',
  },
  {
    label: 'Reportes',
    icon: FileText,
    href: '/dashboard/reportes',
    color: '#EF9F27',
  },
  {
    label: 'Planes',
    icon: Flag,
    href: '/dashboard/planes',
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
        const isPrimary = 'quickAdd' in action && action.quickAdd;
        const content = (
          <motion.div
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium whitespace-nowrap transition-all hover:translate-y-[-1px] cursor-pointer shrink-0 ${
              isPrimary
                ? 'bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 shadow-sm shadow-[#1D9E75]/20'
                : 'border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.05)] hover:border-[rgba(255,255,255,0.12)]'
            }`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
          >
            <Icon className="h-3.5 w-3.5" style={{ color: isPrimary ? 'white' : action.color }} />
            {action.label}
          </motion.div>
        );

        if ('quickAdd' in action && action.quickAdd) {
          return (
            <button
              key={action.label}
              onClick={() => window.dispatchEvent(new CustomEvent('neto:quick-add', { detail: { tipo: 'gasto' } }))}
            >
              {content}
            </button>
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
