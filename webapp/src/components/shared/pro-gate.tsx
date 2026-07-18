'use client';

import Link from 'next/link';
import { Lock, Crown } from 'lucide-react';
import { motion } from 'motion/react';

interface ProGateProps {
  featureName: string;
  description?: string;
}

export function ProGate({ featureName, description }: ProGateProps) {
  return (
    <motion.div
      className="flex items-center justify-center min-h-[400px] bg-gradient-to-br from-[#0a0a0a] via-[#1a1a1a] to-[#0f0f0f] rounded-2xl border border-[#2a2a2a] p-8 glass-card-glow"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="text-center max-w-sm space-y-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[#1D9E75]/10 border border-[#1D9E75]/30">
          <Lock className="w-8 h-8 text-[#1D9E75]" />
        </div>

        <div className="space-y-2">
          <h3 className="text-xl font-bold text-[#F0EFE8]">
            {featureName} es Pro
          </h3>
          {description && (
            <p className="text-sm text-[#8A877D]">
              {description}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <Link
            href="/dashboard/pro"
            className="block w-full px-4 py-3 bg-[#1D9E75] hover:bg-[#1a8a6a] active:scale-[0.98] text-[#F0EFE8] font-semibold rounded-lg transition-all duration-200"
          >
            Pasar a Pro
          </Link>
          <a
            href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20activar%20Pro%20%E2%AD%90"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
          >
            o hazlo por WhatsApp
          </a>
          <p className="text-xs text-[#8A877D]">
            S/10/mes • Cancelar en cualquier momento
          </p>
        </div>
      </div>
    </motion.div>
  );
}

interface ProBadgeProps {
  size?: 'sm' | 'md';
}

export function ProBadge({ size = 'md' }: ProBadgeProps) {
  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
  };

  return (
    <a
      href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20activar%20Pro%20%E2%AD%90"
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 rounded-full bg-[#1D9E75]/15 border border-[#1D9E75]/40 hover:bg-[#1D9E75]/25 transition-colors duration-200 ${sizeClasses[size]}`}
    >
      <Crown className={size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'} style={{ color: '#68dbae' }} />
      <span style={{ color: '#68dbae' }} className="font-semibold">
        Pro
      </span>
    </a>
  );
}
