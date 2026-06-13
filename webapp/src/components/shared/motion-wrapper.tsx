'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

interface FadeInProps {
  children: ReactNode;
  delay?: number;
  className?: string;
}

export function FadeIn({ children, delay = 0, className }: FadeInProps) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      // Reduced motion: skip the rise, just render in place (no movement).
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

interface StaggerProps {
  children: ReactNode;
  className?: string;
  staggerDelay?: number;
}

export function StaggerContainer({ children, className, staggerDelay = 0.06 }: StaggerProps) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: reduce ? 0 : staggerDelay } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      variants={{
        hidden: reduce ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 },
        visible: {
          opacity: 1,
          y: 0,
          transition: reduce ? { duration: 0 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
        },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function ScaleIn({ children, delay = 0, className }: FadeInProps) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      // Never animate from scale(0); reduced motion skips the scale entirely.
      initial={reduce ? false : { opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? { duration: 0 } : { duration: 0.45, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
