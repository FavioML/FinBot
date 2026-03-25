'use client';

import { useState, useEffect } from 'react';
import { DollarSign, RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';

interface RateData {
  rate: number;
  pair: string;
  updatedAt: string;
}

export function ExchangeRateWidget() {
  const [data, setData] = useState<RateData | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchRate() {
    setLoading(true);
    try {
      const res = await fetch('/api/exchange-rate');
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch {
      // silent fail
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchRate();
  }, []);

  if (!data && !loading) return null;

  return (
    <motion.div
      className="glass-card glass-card-glow p-4 flex items-center gap-3"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      <div className="rounded-lg bg-[rgba(239,159,39,0.12)] p-2 shrink-0">
        <DollarSign className="h-4 w-4 text-[#EF9F27]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-[#8A877D] uppercase tracking-wider">USD / PEN</p>
        {loading ? (
          <div className="h-5 w-16 rounded bg-[rgba(255,255,255,0.06)] animate-pulse mt-0.5" />
        ) : (
          <p className="text-lg font-bold text-[#F0EFE8] tabular-nums">
            S/ {data?.rate?.toFixed(3) || '—'}
          </p>
        )}
      </div>
      <button
        onClick={fetchRate}
        disabled={loading}
        className="p-1.5 rounded-lg text-[#8A877D] hover:text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.04)] transition-colors disabled:opacity-50"
        title="Actualizar tipo de cambio"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </motion.div>
  );
}
