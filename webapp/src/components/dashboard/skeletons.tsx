/**
 * Shared per-route loading skeletons.
 *
 * Each skeleton mirrors the real first-paint layout of its screen so that the
 * whole click → navigate → mount → fetch → data sequence has zero layout shift.
 * The SAME component is rendered in two places:
 *   1. `app/dashboard/<route>/loading.tsx`  — shown during the route RSC fetch.
 *   2. the page's own `isLoading` branch     — shown while React Query fetches.
 * Because both use the identical component, there is no skeleton-to-skeleton
 * swap between them — it reads as one continuous loading state.
 *
 * No client hooks here on purpose: these render fine as Server Components
 * (loading.tsx) and inside Client Components (page isLoading) alike.
 */
import { Skeleton } from '@/components/ui/skeleton';

/**
 * `subtitulo` es el renglón bajo el título. Por defecto es una barra más del esqueleto;
 * el shell le pasa `AvisoCargaLenta`, que ocupa ese mismo renglón —misma altura, arriba
 * de todo— y lo convierte en texto cuando la espera se estira. Ese slot existe porque el
 * aviso puesto DEBAJO del esqueleto nacía fuera del pliegue en móvil.
 *
 * Sigue sin hooks de cliente acá: el nodo llega ya construido desde arriba, así que
 * `loading.tsx` (Server Component) lo renderiza igual sin pasar nada.
 */
export function OverviewSkeleton({ subtitulo }: { subtitulo?: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Skeleton className="h-8 w-48 mb-2" />
          {subtitulo ?? <Skeleton className="h-4 w-64" />}
        </div>
        <Skeleton className="h-10 w-10 rounded-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[120px] rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-[320px] rounded-2xl" />
        <Skeleton className="h-[320px] rounded-2xl" />
      </div>
      <Skeleton className="h-[300px] rounded-2xl" />
    </div>
  );
}

export function TransaccionesSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[100px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[56px] rounded-2xl" />
      <Skeleton className="h-[400px] rounded-2xl" />
    </div>
  );
}

export function PresupuestosSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[100px] rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[140px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export function ScoreSkeleton() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-[200px] rounded-2xl" />
      <Skeleton className="h-[300px] rounded-2xl" />
    </div>
  );
}

export function AlertasSkeleton() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-24 rounded-2xl" />
      ))}
    </div>
  );
}

export function ConfiguracionSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-52" />
      <Skeleton className="h-[200px] rounded-2xl" />
      <Skeleton className="h-[260px] rounded-2xl" />
      <Skeleton className="h-[160px] rounded-2xl" />
      <Skeleton className="h-[140px] rounded-2xl" />
      <Skeleton className="h-[120px] rounded-2xl" />
    </div>
  );
}

export function DeudasSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-[180px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export function ReportesSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-10 w-48" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}

export function SuscripcionesSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export function PlanesSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[200px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export function LogrosSkeleton() {
  return (
    <div className="flex-1 space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-10 w-10 rounded-full" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-36 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export function EspaciosSkeleton() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-72" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export function EspacioDetailSkeleton() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-[120px] rounded-2xl" />
      <Skeleton className="h-[200px] rounded-2xl" />
    </div>
  );
}
