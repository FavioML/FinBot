'use client';

import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Activity } from 'lucide-react';
import { getScoreColor } from '@/lib/utils';
import { MESES } from '@/lib/constants';
import { useNetoScoreHistory } from '@/lib/hooks/use-neto-score';
import { Skeleton } from '@/components/ui/skeleton';

interface MonthScore {
  label: string;
  score: number;
  color: string;
}

export function ScoreTrend() {
  const { data, isLoading } = useNetoScoreHistory(4);

  const scores = useMemo<MonthScore[]>(() => {
    if (!data?.history?.length) return [];

    // Take last 4 months from history
    const recent = data.history.slice(-4);
    return recent.map((h) => {
      const [, monthStr] = (h.period || '').split('-');
      const monthNum = parseInt(monthStr, 10);
      return {
        label: MESES[monthNum]?.slice(0, 3) || monthStr || '',
        score: h.score,
        color: getScoreColor(h.score),
      };
    });
  }, [data]);

  if (isLoading) {
    return <Skeleton className="h-[160px] rounded-2xl" />;
  }

  // Only show if at least 2 months have data
  if (scores.filter((s) => s.score > 0).length < 2) return null;

  const maxScore = 100;

  return (
    <div className="glass-card glass-card-glow p-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-4 w-4 text-[#8A877D]" />
        <h3 className="text-sm font-medium md:text-base md:font-semibold text-[#C8C6BC]">Tendencia del Score</h3>
      </div>
      <div className="flex items-end gap-3 h-[100px]">
        {scores.map((month, i) => {
          const height = month.score > 0 ? Math.max(8, (month.score / maxScore) * 100) : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
              {month.score > 0 && (
                <span className="text-xs font-bold" style={{ color: month.color }}>
                  {month.score}
                </span>
              )}
              <div className="w-full flex items-end" style={{ height: '72px' }}>
                <motion.div
                  className="w-full rounded-t-md"
                  style={{ backgroundColor: month.score > 0 ? month.color : 'rgba(255,255,255,0.05)', opacity: month.score > 0 ? 0.85 : 1 }}
                  initial={{ height: 0 }}
                  animate={{ height: month.score > 0 ? `${height}%` : '8px' }}
                  transition={{ duration: 0.6, delay: i * 0.1, ease: [0.25, 0.46, 0.45, 0.94] }}
                />
              </div>
              <span className="text-[10px] text-[#8A877D]">{month.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
