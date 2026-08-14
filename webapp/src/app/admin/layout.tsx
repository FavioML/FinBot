import { notFound } from 'next/navigation';
import { getAdminContext } from '@/lib/admin';
import { AdminQueryProvider } from './admin-query-provider';
import { AdminHeaderNav } from './admin-header-nav';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isAdmin } = await getAdminContext();
  if (!user || !isAdmin) notFound();

  return (
    <div className="min-h-screen bg-[#0E0E0C] text-[#F0EFE8]">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-10">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[#8A877D]">
              Neto · Admin
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">
              Panel de control
            </h1>
          </div>
          <AdminHeaderNav />
        </header>
        {/* Sin `TooltipProvider` a propósito, aunque cuatro páginas de acá importen algo
            llamado `Tooltip`: ese viene de **recharts** (trae el suyo) y no de
            `@/components/ui/tooltip`. Montar el provider de @base-ui acá le sumaría el
            bundle al panel para cero tooltips. El `<Toaster>` que usa `/admin/surveys`
            vive en el root layout. */}
        <AdminQueryProvider>{children}</AdminQueryProvider>
      </div>
    </div>
  );
}
