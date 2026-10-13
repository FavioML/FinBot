'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

// Navegación del header admin. En una subpágina (/admin/operacion, etc.) el único
// botón antes te sacaba a /dashboard, sin forma de volver al home del panel. Aquí
// añadimos "Volver al panel" (a /admin) cuando NO estás en el home del panel.
export function AdminHeaderNav() {
  const pathname = usePathname();
  const inSubpage = pathname !== '/admin';

  return (
    <div className="flex items-center gap-2">
      {inSubpage && (
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground-soft transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Volver al panel</span>
          <span className="sm:hidden">Panel</span>
        </Link>
      )}
      <Link
        href="/dashboard"
        className="inline-flex items-center rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground-soft transition-colors hover:text-foreground"
      >
        <span className="hidden sm:inline">Volver al dashboard</span>
        <span className="sm:hidden">Dashboard</span>
      </Link>
    </div>
  );
}
