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
    color: 'var(--primary)',
  },
  {
    label: 'Reportes',
    icon: FileText,
    href: '/dashboard/reportes',
    color: 'var(--warning)',
  },
  {
    label: 'Planes',
    icon: Flag,
    href: '/dashboard/planes',
    color: 'var(--primary)',
  },
  {
    label: 'Presupuestos',
    icon: PiggyBank,
    href: '/dashboard/presupuestos',
    color: 'var(--negative)',
  },
  {
    label: 'Suscripciones',
    icon: CreditCard,
    href: '/dashboard/suscripciones',
    color: 'var(--muted-foreground)',
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
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm shadow-primary/20'
                : 'border border-border bg-foreground/2 text-foreground-soft hover:bg-foreground/5 hover:border-border'
            }`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
          >
            <Icon className="h-3.5 w-3.5" style={{ color: isPrimary ? 'var(--primary-foreground)' : action.color }} />
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
