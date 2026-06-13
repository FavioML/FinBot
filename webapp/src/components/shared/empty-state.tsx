'use client';

import Link from 'next/link';
import { MessageCircle, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { SOCIAL_LINKS } from '@/lib/constants';

interface EmptyStateAction {
  label: string;
  /** Navigation target. Omit when using `onClick` for an in-page action. */
  href?: string;
  external?: boolean;
  variant?: 'primary' | 'secondary';
  /** In-page action (e.g. open a dialog). Takes precedence over `href`. */
  onClick?: () => void;
}

interface EmptyStateProps {
  title: string;
  description: string;
  showWhatsApp?: boolean;
  icon?: LucideIcon;
  actions?: EmptyStateAction[];
}

export function EmptyState({ title, description, showWhatsApp = true, icon: Icon = MessageCircle, actions }: EmptyStateProps) {
  return (
    <motion.div
      className="glass-card flex flex-col items-center justify-center py-16 text-center"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      <motion.div
        className="relative rounded-full bg-[rgba(255,255,255,0.03)] p-6 mb-5"
        initial={{ scale: 0.8 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="absolute inset-0 rounded-full bg-[#1D9E75]/5 animate-pulse" />
        <Icon className="relative h-8 w-8 text-[#8A877D] animate-float" />
      </motion.div>
      <h3 className="text-lg font-semibold text-[#F0EFE8] mb-2">{title}</h3>
      <p className="text-sm text-[#8A877D] max-w-md mb-6 leading-relaxed">{description}</p>

      {/* Custom actions */}
      {actions && actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-3 mb-4">
          {actions.map((action) => {
            const isPrimary = action.variant !== 'secondary';
            const cls = isPrimary
              ? 'inline-flex items-center gap-2 rounded-xl bg-[#1D9E75] px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-[#1D9E75]/20 transition-all hover:bg-[#1D9E75]/90 hover:shadow-[#1D9E75]/30 active:scale-[0.98]'
              : 'inline-flex items-center gap-2 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-5 py-2.5 text-sm font-medium text-[#C8C6BC] transition-all hover:bg-[rgba(255,255,255,0.06)] active:scale-[0.98]';

            if (action.onClick) {
              return (
                <motion.button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className={cls}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {action.label}
                </motion.button>
              );
            }

            if (action.external) {
              return (
                <motion.a
                  key={action.label}
                  href={action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cls}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {isPrimary && <MessageCircle className="h-4 w-4" />}
                  {action.label}
                </motion.a>
              );
            }

            return (
              <motion.div key={action.label} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                <Link href={action.href ?? '#'} className={cls}>
                  {action.label}
                </Link>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Default WhatsApp CTA (only if no custom actions) */}
      {showWhatsApp && (!actions || actions.length === 0) && (
        <motion.a
          href={SOCIAL_LINKS.whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-xl bg-[#1D9E75] px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-[#1D9E75]/20 transition-all hover:bg-[#1D9E75]/90 hover:shadow-[#1D9E75]/30 active:scale-[0.98]"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <MessageCircle className="h-4 w-4" />
          Registra gastos por WhatsApp
        </motion.a>
      )}
    </motion.div>
  );
}
