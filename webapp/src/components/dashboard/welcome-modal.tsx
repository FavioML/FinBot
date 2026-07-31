'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Mail, MessageCircle, BarChart3, ChevronRight, ChevronLeft } from 'lucide-react';

const STORAGE_KEY = 'neto_welcome_seen';

const slides = [
  {
    icon: MessageCircle,
    iconColor: '#25D366',
    title: 'Registra gastos en segundos',
    description: 'Manda un gasto por WhatsApp (texto, voz o foto de tu Yape o Plin) y Neto lo registra solo. También puedes agregarlo desde la app.',
  },
  {
    icon: Mail,
    iconColor: '#4285F4',
    title: 'Conecta tu Gmail',
    description: 'NETO lee tus correos bancarios (BCP, BBVA, Interbank y más) para importar tus transacciones sin que hagas nada.',
  },
  {
    icon: BarChart3,
    iconColor: '#1D9E75',
    title: 'Visualiza tus finanzas',
    description: 'Dashboard con gráficos, score financiero, presupuestos y reportes. Todo en un solo lugar para tomar mejores decisiones.',
  },
];

export function WelcomeModal() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    try {
      const seen = localStorage.getItem(STORAGE_KEY);
      if (!seen) {
        setOpen(true);
      }
    } catch {
      // localStorage not available
    }
  }, []);

  const handleClose = () => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
  };

  const handleNext = () => {
    if (step < slides.length - 1) {
      setStep(step + 1);
    } else {
      handleClose();
    }
  };

  if (!open) return null;

  const slide = slides[step];
  const isLast = step === slides.length - 1;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

        {/* Modal */}
        <motion.div
          className="relative w-full max-w-sm glass-card-elevated p-6"
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-3 right-3 rounded-lg p-1 text-[#8A877D] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[#C8C6BC]"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Slide content */}
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.25 }}
              className="text-center"
            >
              {/* Icon */}
              <div
                className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
                style={{ backgroundColor: `${slide.iconColor}15` }}
              >
                <slide.icon className="h-8 w-8" style={{ color: slide.iconColor }} />
              </div>

              {/* Text */}
              <h3 className="mb-2 text-lg font-semibold text-[#F0EFE8]">{slide.title}</h3>
              <p className="text-sm leading-relaxed text-[#8A877D]">{slide.description}</p>
            </motion.div>
          </AnimatePresence>

          {/* Dots */}
          <div className="mt-6 flex items-center justify-center gap-1.5">
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-[#1D9E75]' : 'w-1.5 bg-[#8A877D]/30'}`}
              />
            ))}
          </div>

          {/* Navigation */}
          <div className="mt-5 flex items-center justify-between">
            {step > 0 ? (
              <button
                onClick={() => setStep(step - 1)}
                className="flex items-center gap-1 text-xs text-[#8A877D] transition-colors hover:text-[#C8C6BC]"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Anterior
              </button>
            ) : (
              <button
                onClick={handleClose}
                className="text-xs text-[#8A877D] transition-colors hover:text-[#C8C6BC]"
              >
                Saltar
              </button>
            )}

            <button
              onClick={handleNext}
              className="flex items-center gap-1 rounded-lg bg-[#1D9E75] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1D9E75]/90"
            >
              {isLast ? 'Empezar' : 'Siguiente'}
              {!isLast && <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
