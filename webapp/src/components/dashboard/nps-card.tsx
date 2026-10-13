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
        style={{ borderColor: 'color-mix(in srgb, var(--primary) 22%, transparent)' }}
      >
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Cerrar encuesta"
          disabled={dismiss.isPending || isSubmitting}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/12 p-2 text-primary-ink">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">
              Ayúdame a mejorar Neto
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              3 preguntas rápidas, te toma 30 segundos.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-5">
          {QUESTIONS.map((q) => {
            const value = answers[q.key];
            return (
              <div key={q.key}>
                <p className="text-sm font-medium text-foreground">{q.label}</p>
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
                            ? 'border-primary bg-primary/18 text-foreground shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_40%,transparent)]'
                            : 'border-border bg-surface-elevated text-foreground-soft hover:border-primary/30 hover:text-foreground'
                        } disabled:opacity-50`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                  <span>{q.low}</span>
                  <span>{q.high}</span>
                </div>
              </div>
            );
          })}

          <div>
            <label
              htmlFor="nps-comment"
              className="text-sm font-medium text-foreground"
            >
              ¿Quieres agregar algo más?{' '}
              <span className="text-muted-foreground">(opcional)</span>
            </label>
            <textarea
              id="nps-comment"
              value={comment}
              maxLength={MAX_COMMENT}
              onChange={(e) => setComment(e.target.value)}
              disabled={isSubmitting}
              rows={3}
              placeholder="Lo que más te gusta, lo que falta, lo que cambiarías…"
              className="form-input mt-2 w-full resize-none rounded-lg bg-surface-elevated px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            />
            <p className="mt-1 text-right text-[11px] text-muted-foreground">
              {comment.length}/{MAX_COMMENT}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-col-reverse items-stretch justify-between gap-3 sm:flex-row sm:items-center">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Tus respuestas van directo a Favio (creador de Neto). Cero data
            compartida con terceros.
          </p>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allAnswered || isSubmitting}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isSubmitting ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
