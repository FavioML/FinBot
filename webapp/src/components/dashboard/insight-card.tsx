'use client';

import { Lightbulb, Sparkles } from 'lucide-react';
import { motion } from 'motion/react';

interface InsightCardProps {
  insight?: string;
}

export function InsightCard({ insight }: InsightCardProps) {
  return (
    <motion.div
      className="glass-card glass-card-glow p-5 relative overflow-hidden"
      style={{
        borderTopColor: 'rgba(29, 158, 117, 0.4)',
        borderTopWidth: '2px',
      }}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      {/* Subtle gradient glow */}
      <div
        className="absolute top-0 left-0 right-0 h-16 pointer-events-none"
        style={{
          background:
            'linear-gradient(180deg, rgba(29,158,117,0.08) 0%, transparent 100%)',
        }}
      />
      <div className="relative flex items-start gap-3">
        <motion.div
          className="rounded-lg bg-[rgba(29,158,117,0.12)] p-2 shrink-0"
          animate={{ rotate: [0, 5, -5, 0] }}
          transition={{ duration: 3, repeat: Infinity, repeatDelay: 5 }}
        >
          <Sparkles className="h-5 w-5 text-[#1D9E75]" />
        </motion.div>
        <div>
          <h3 className="text-sm font-medium text-[#F0EFE8] mb-1">Consejo del mes</h3>
          <p className="text-sm text-[#8A877D] leading-relaxed">
            {insight || 'Conecta tus datos para recibir consejos personalizados de IA'}
          </p>
        </div>
      </div>
    </motion.div>
  );
}
