import { DashboardShell } from '@/components/dashboard/dashboard-shell';

// No `force-dynamic` and no server-side data fetch here on purpose: the dashboard
// shell is a static skeleton served from the CDN (instant first paint, no cold
// start), and every screen streams its data client-side via React Query. The
// middleware already gates /dashboard behind auth, and the client fetches are
// RLS-scoped, so the static HTML never carries user data. Returning-visit speed
// (seeding the user + data without a client round-trip) is handled by the
// persisted React Query cache in DashboardShell, not by a blocking server render.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardShell>{children}</DashboardShell>;
}
