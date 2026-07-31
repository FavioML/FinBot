'use client';

import { useState, useEffect } from 'react';
import { X, ChevronRight, Sparkles, Target, LayoutDashboard, Receipt } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useUser } from '@/lib/hooks/use-user';
import { IS_DEMO } from '@/lib/demo/is-demo';
import type { Usuario } from '@/lib/types';

const TOUR_KEY = 'neto_tour_v2';

const STEPS = [
  {
    title: 'Registra tus gastos e ingresos',
    description: 'Agrega transacciones aqui en la app o por WhatsApp. Neto tambien lee fotos de Yape y Plin automaticamente.',
    icon: Receipt,
    color: '#1D9E75',
  },
  {
    title: 'Establece tus presupuestos',
    description: 'Define limites de gasto por categoria para controlar tus finanzas. Neto te avisa cuando estes cerca del limite.',
    icon: Target,
    color: '#EF9F27',
  },
  {
    title: 'Tu score financiero',
    description: 'Este numero refleja tu salud financiera. Mientras mejor controles tus gastos, mas alto sera tu score.',
    icon: Sparkles,
    color: '#1D9E75',
  },
  {
    title: 'Todo en tu dashboard',
    description: 'Graficos, reportes PDF, suscripciones detectadas, calendario financiero y mas. Todo en un solo lugar.',
    icon: LayoutDashboard,
    color: '#378ADD',
  },
];

export function OnboardingTour() {
  const { data: user } = useUser();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(-1); // -1 = not started / hidden
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // Gate 1-vez-por-CUENTA: la marca vive en usuarios.tour_visto (server), no solo en el
    // navegador. Se espera a que cargue el usuario. localStorage queda como fast-path: quien ya
    // cerró el tour (en este navegador, o antes de este cambio) no lo vuelve a ver aunque el
    // flag server siga en false → el rollout no re-dispara el tour a los que ya lo vieron.
    if (IS_DEMO || !user) return;
    if (user.tour_visto || localStorage.getItem(TOUR_KEY)) return;
    // Small delay so the page renders first
    const timer = setTimeout(() => {
      setStep(0);
      setDismissed(false);
    }, 1500);
    return () => clearTimeout(timer);
  }, [user]);

  function handleNext() {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      handleComplete();
    }
  }

  function handleComplete() {
    localStorage.setItem(TOUR_KEY, 'true');
    setDismissed(true);
    // Persistir en la cuenta para que NO reaparezca en otro navegador/dispositivo/incógnito.
    // Optimista + best-effort: el localStorage ya lo cubre en este navegador; si el POST falla,
    // se reintenta la próxima visita (el flag server sigue en false).
    queryClient.setQueryData<Usuario | null>(['user'], (prev) =>
      prev ? { ...prev, tour_visto: true } : prev,
    );
    fetch('/api/user/tour-visto', { method: 'POST' }).catch(() => {});
  }

  if (dismissed || step < 0) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={handleComplete}
        />

        {/* Card */}
        <motion.div
          key={step}
          className="relative w-full max-w-sm glass-card p-6 space-y-4 border-t-2"
          style={{ borderTopColor: current.color }}
          initial={{ opacity: 0, y: 30, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ duration: 0.3 }}
        >
          {/* Close */}
          <button
            onClick={handleComplete}
            className="absolute top-3 right-3 text-[#8A877D] hover:text-[#F0EFE8] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Icon */}
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: `${current.color}15` }}
          >
            <Icon className="h-5 w-5" style={{ color: current.color }} />
          </div>

          {/* Content */}
          <div>
            <h3 className="text-base font-semibold text-[#F0EFE8] mb-1">{current.title}</h3>
            <p className="text-sm text-[#8A877D] leading-relaxed">{current.description}</p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-1">
            {/* Progress dots */}
            <div className="flex gap-1.5">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className="h-1.5 rounded-full transition-all duration-300"
                  style={{
                    width: i === step ? 16 : 6,
                    backgroundColor: i === step ? current.color : 'rgba(255,255,255,0.1)',
                  }}
                />
              ))}
            </div>

            {/* Next / Finish button */}
            <button
              onClick={handleNext}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors"
              style={{ backgroundColor: current.color }}
            >
              {isLast ? 'Empezar' : 'Siguiente'}
              {!isLast && <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>

          {/* Step counter */}
          <p className="text-[10px] text-[#8A877D] text-center">
            {step + 1} de {STEPS.length}
          </p>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
