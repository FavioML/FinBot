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
          className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#131311] px-3 py-2 text-sm text-[#C8C6BC] transition-colors hover:text-[#F0EFE8]"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver al panel
        </Link>
      )}
      <Link
        href="/dashboard"
        className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#131311] px-3 py-2 text-sm text-[#C8C6BC] transition-colors hover:text-[#F0EFE8]"
      >
        Volver al dashboard
      </Link>
    </div>
  );
}
