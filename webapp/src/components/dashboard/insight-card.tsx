'use client';

import { Lightbulb } from 'lucide-react';

interface InsightCardProps {
  insight?: string;
}

export function InsightCard({ insight }: InsightCardProps) {
  return (
    <div
      className="glass-card p-5 relative overflow-hidden"
      style={{
        borderTopColor: 'rgba(29, 158, 117, 0.4)',
        borderTopWidth: '2px',
      }}
    >
      {/* Subtle gradient glow */}
      <div
        className="absolute top-0 left-0 right-0 h-16 pointer-events-none"
        style={{
          background:
            'linear-gradient(180deg, rgba(29,158,117,0.06) 0%, transparent 100%)',
        }}
      />
      <div className="relative flex items-start gap-3">
        <div className="rounded-lg bg-[rgba(29,158,117,0.12)] p-2 shrink-0">
          <Lightbulb className="h-5 w-5 text-[#1D9E75]" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-[#F0EFE8] mb-1">Consejo del mes</h3>
          <p className="text-sm text-[#8A877D] leading-relaxed">
            {insight || 'Conecta tus datos para recibir consejos personalizados de IA'}
          </p>
        </div>
      </div>
    </div>
  );
}
