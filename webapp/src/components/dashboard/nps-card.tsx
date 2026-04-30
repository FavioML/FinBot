'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MessageCircle, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useNpsEligibility } from '@/lib/hooks/use-nps-eligibility';
import { useNpsSubmit } from '@/lib/hooks/use-nps-submit';

const QUESTIONS: Array<{
  key: 'ease' | 'usefulness' | 'recommend';
  label: string;
  low: string;
  high: string;
}> = [
  {
    key: 'ease',
    label: '¿Qué tan fácil te resulta usar Neto?',
    low: 'Muy difícil',
    high: 'Muy fácil',
  },
  {
    key: 'usefulness',
    label: '¿Qué tan útil ha sido para entender tus finanzas?',
    low: 'Nada útil',
    high: 'Muy útil',
  },
  {
    key: 'recommend',
    label: '¿Qué tan probable es que recomiendes Neto a un amigo?',
    low: 'Nunca',
    high: 'Sin duda',
  },
];

const MAX_COMMENT = 500;

export function NPSCard() {
  const { data: eligibility } = useNpsEligibility();
  const { respond, dismiss } = useNpsSubmit();
  const [answers, setAnswers] = useState<{
    ease?: number;
    usefulness?: number;
    recommend?: number;
  }>({});
  const [comment, setComment] = useState('');

  if (!eligibility?.eligible) return null;

  const allAnswered =
    typeof answers.ease === 'number' &&
    typeof answers.usefulness === 'number' &&
    typeof answers.recommend === 'number';

  const handleSubmit = async () => {
    if (!allAnswered) return;
    try {
      await respond.mutateAsync({
        ease: answers.ease!,
        usefulness: answers.usefulness!,
        recommend: answers.recommend!,
        comment: comment.trim() || null,
      });
      toast.success('¡Gracias por tu feedback!');
    } catch {
      toast.error('No se pudo enviar tu respuesta. Intenta de nuevo.');
    }
  };

  const handleDismiss = async () => {
    try {
      await dismiss.mutateAsync();
    } catch {
      // Silent — card already disappeared visually if invalidation fired.
    }
  };

  const isSubmitting = respond.isPending;

  return (
    <AnimatePresence>
      <motion.div
        key="nps-card"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="glass-card glass-card-elevated relative overflow-hidden rounded-2xl p-5 sm:p-6"
        style={{ borderColor: 'rgba(29,158,117,0.22)' }}
      >
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Cerrar encuesta"
          disabled={dismiss.isPending || isSubmitting}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-[#8A877D] transition-colors hover:bg-[rgba(255,255,255,0.05)] hover:text-[#F0EFE8] disabled:opacity-50"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-[rgba(29,158,117,0.12)] p-2 text-[#1D9E75]">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-[#F0EFE8]">
              Ayúdame a mejorar Neto
            </h3>
            <p className="mt-0.5 text-sm text-[#8A877D]">
              3 preguntas rápidas, te toma 30 segundos.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-5">
          {QUESTIONS.map((q) => {
            const value = answers[q.key];
            return (
              <div key={q.key}>
                <p className="text-sm font-medium text-[#F0EFE8]">{q.label}</p>
                <div className="mt-2.5 grid grid-cols-5 gap-1.5 sm:gap-2">
                  {[1, 2, 3, 4, 5].map((n) => {
                    const selected = value === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() =>
                          setAnswers((prev) => ({ ...prev, [q.key]: n }))
                        }
                        disabled={isSubmitting}
                        aria-label={`${q.label} — ${n}`}
                        className={`flex h-11 items-center justify-center rounded-lg border text-sm font-semibold tabular-nums transition-all ${
                          selected
                            ? 'border-[#1D9E75] bg-[rgba(29,158,117,0.18)] text-[#F0EFE8] shadow-[0_0_0_1px_rgba(29,158,117,0.4)]'
                            : 'border-[rgba(255,255,255,0.08)] bg-[#1A1A17] text-[#C8C6BC] hover:border-[rgba(29,158,117,0.3)] hover:text-[#F0EFE8]'
                        } disabled:opacity-50`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-[#8A877D]">
                  <span>{q.low}</span>
                  <span>{q.high}</span>
                </div>
              </div>
            );
          })}

          <div>
            <label
              htmlFor="nps-comment"
              className="text-sm font-medium text-[#F0EFE8]"
            >
              ¿Quieres agregar algo más?{' '}
              <span className="text-[#8A877D]">(opcional)</span>
            </label>
            <textarea
              id="nps-comment"
              value={comment}
              maxLength={MAX_COMMENT}
              onChange={(e) => setComment(e.target.value)}
              disabled={isSubmitting}
              rows={3}
              placeholder="Lo que más te gusta, lo que falta, lo que cambiarías…"
              className="form-input mt-2 w-full resize-none rounded-lg bg-[#1A1A17] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#5A584F] focus:outline-none focus:ring-2 focus:ring-[#1D9E75] disabled:opacity-50"
            />
            <p className="mt-1 text-right text-[11px] text-[#8A877D]">
              {comment.length}/{MAX_COMMENT}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-col-reverse items-stretch justify-between gap-3 sm:flex-row sm:items-center">
          <p className="text-[11px] leading-snug text-[#8A877D]">
            Tus respuestas van directo a Favio (creador de Neto). Cero data
            compartida con terceros.
          </p>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allAnswered || isSubmitting}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#1D9E75] px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-[#178C66] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isSubmitting ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
