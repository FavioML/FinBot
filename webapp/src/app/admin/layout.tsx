import { notFound } from 'next/navigation';
import { getAdminContext } from '@/lib/admin';

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
          <a
            href="/dashboard"
            className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#131311] px-3 py-2 text-sm text-[#C8C6BC] transition-colors hover:text-[#F0EFE8]"
          >
            Volver al dashboard
          </a>
        </header>
        {children}
      </div>
    </div>
  );
}
