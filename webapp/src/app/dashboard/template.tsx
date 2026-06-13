/**
 * Per-navigation enter transition for the dashboard.
 *
 * `template.tsx` (unlike `layout.tsx`) re-mounts on every navigation, so this
 * wrapper re-plays its CSS enter animation each time you move between screens —
 * a subtle fade + 8px rise that reads as a native push. It's pure CSS (class
 * `.page-transition` in globals.css) on purpose: CSS animations run off the
 * main thread, so the motion stays smooth even while the destination route is
 * still compiling/streaming. `prefers-reduced-motion` removes the movement.
 *
 * The animation plays once per navigation and wraps both the loading skeleton
 * and the page, so the skeleton-to-content swap inside is seamless (no re-anim).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-transition">{children}</div>;
}
