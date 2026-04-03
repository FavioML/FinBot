'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { motion } from 'motion/react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error('[Dashboard Error]', error);
  }, [error]);

  const message = error.message
    ? error.message.slice(0, 200)
    : 'Ocurrió un error inesperado.';

  return (
    <div className="flex items-center justify-center min-h-[400px] p-4">
      <motion.div
        className="glass-card p-8 text-center max-w-sm w-full space-y-5"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[rgba(232,93,74,0.1)] border border-[rgba(232,93,74,0.25)]">
          <AlertTriangle className="w-7 h-7 text-[#E85D4A]" />
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-bold text-[#F0EFE8]">Algo salió mal</h2>
          <p className="text-sm text-[#8A877D] leading-relaxed">{message}</p>
        </div>

        <div className="flex flex-col gap-2 pt-1">
          <button
            onClick={reset}
            className="w-full px-4 py-2.5 bg-[#1D9E75] hover:bg-[#1a8a6a] text-[#F0EFE8] font-semibold rounded-lg transition-colors duration-200 text-sm"
          >
            Reintentar
          </button>
          <a
            href="/dashboard"
            className="w-full px-4 py-2.5 bg-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.08)] text-[#C8C6BC] rounded-lg transition-colors duration-200 text-sm text-center block"
          >
            Volver al inicio
          </a>
        </div>
      </motion.div>
    </div>
  );
}
