/**
 * Subtle haptic feedback for key mobile actions.
 *
 * Uses the Vibration API (Android Chrome; iOS Safari has no support and is
 * silently skipped). Kept intentionally light — a short tick, not a buzz —
 * so it reads as a native press confirmation rather than a notification.
 *
 * Guards: no-op on the server, when the API is missing, or when the user
 * prefers reduced motion (haptics are motion too).
 */
type HapticPattern = 'tap' | 'success' | 'warning' | 'error';

const PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 8,
  success: [10, 40, 10],
  warning: [16, 60, 16],
  error: [24, 40, 24, 40, 24],
};

export function haptic(pattern: HapticPattern = 'tap'): void {
  if (typeof window === 'undefined') return;
  if (!('vibrate' in navigator) || typeof navigator.vibrate !== 'function') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  try {
    navigator.vibrate(PATTERNS[pattern]);
  } catch {
    // Some user agents throw if vibrate is called without a user gesture; ignore.
  }
}
