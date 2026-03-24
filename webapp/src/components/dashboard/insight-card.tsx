'use client';

import { Sparkles } from 'lucide-react';
import { motion } from 'motion/react';

interface InsightCardProps {
  insight?: string;
}

export function InsightCard({ insight }: InsightCardProps) {
  const text = insight || 'Conecta tus datos para recibir consejos personalizados de IA';

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
            {text}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Generate a rule-based financial insight from transaction data.
 * Returns a personalized tip string based on spending patterns.
 */
export function generateInsight(params: {
  totalGastos: number;
  totalIngresos: number;
  categorias: { categoria: string; total: number }[];
  scoreFinanciero: number;
  transactionCount: number;
  subscriptionTotal?: number;
}): string {
  const { totalGastos, totalIngresos, categorias, scoreFinanciero, transactionCount, subscriptionTotal } = params;

  if (transactionCount === 0) {
    return 'Conecta tus datos para recibir consejos personalizados de IA';
  }

  const ratio = totalIngresos > 0 ? totalGastos / totalIngresos : 0;
  const topCat = categorias[0];
  const topPct = topCat && totalGastos > 0 ? Math.round((topCat.total / totalGastos) * 100) : 0;
  const ahorro = totalIngresos - totalGastos;

  // Pick the most relevant insight
  if (ratio > 1) {
    const exceso = totalGastos - totalIngresos;
    return `Estás gastando S/${Math.round(exceso)} más de lo que ingresas este mes. Revisa tus gastos en ${topCat?.categoria || 'las categorías principales'} para equilibrar tu balance.`;
  }

  if (ratio > 0.9 && totalIngresos > 0) {
    return `Solo estás ahorrando el ${Math.round((1 - ratio) * 100)}% de tus ingresos. La regla 50/30/20 sugiere ahorrar al menos el 20%. Reducir S/${Math.round(totalGastos * 0.1)} en gastos te acercaría a esa meta.`;
  }

  if (subscriptionTotal && subscriptionTotal > totalGastos * 0.15) {
    return `Tus suscripciones representan más del 15% de tus gastos (S/${Math.round(subscriptionTotal)}/mes). Revisa si todas las sigues usando — cancelar una puede liberar presupuesto para ahorrar.`;
  }

  if (topPct > 40 && topCat) {
    return `${topCat.categoria} concentra el ${topPct}% de tus gastos. Diversificar o establecer un presupuesto para esta categoría te ayudaría a mantener mejor control.`;
  }

  if (scoreFinanciero >= 80) {
    return `Tu score de ${scoreFinanciero} es excelente. Mantén este ritmo — estás ahorrando S/${Math.round(ahorro)}/mes. Considera invertir parte de ese ahorro para hacerlo crecer.`;
  }

  if (ahorro > 0 && totalIngresos > 0) {
    const ahorroMeta = totalIngresos * 0.2;
    if (ahorro < ahorroMeta) {
      return `Ahorras S/${Math.round(ahorro)}/mes, pero tu meta ideal sería S/${Math.round(ahorroMeta)}. Reducir S/${Math.round(ahorroMeta - ahorro)} en gastos te llevaría al 20% recomendado.`;
    }
    return `Buen trabajo: ahorras el ${Math.round((ahorro / totalIngresos) * 100)}% de tus ingresos. Estás por encima del 20% recomendado — sigue así.`;
  }

  return 'Registra más transacciones para que NETO pueda darte consejos personalizados sobre tus finanzas.';
}
