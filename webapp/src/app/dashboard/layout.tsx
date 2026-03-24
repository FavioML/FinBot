import { DashboardShell } from '@/components/dashboard/dashboard-shell';

// Force dynamic rendering — dashboard requires auth
export const dynamic = 'force-dynamic';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardShell>{children}</DashboardShell>;
}
