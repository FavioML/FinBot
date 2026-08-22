import Link from 'next/link';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { vistaInvitacionMeta } from '@/lib/invitaciones';
import { MarcoInvitacion } from '../../marco';
import { AccionUnirseMeta } from './accion';

/**
 * Resuelta en el servidor. El porqué está en `join/gasto/[code]/page.tsx`; lo medido acá:
 *
 *   first-paint = FCP 1636ms  →  LCP 4464ms   gap de 2828ms mirando "Cargando invitacion..."
 *
 * Ésta fue la peor de las cuatro: una de las cinco corridas todavía mostraba el spinner a
 * los 6 segundos, con el logo como elemento LCP.
 */
export const dynamic = 'force-dynamic';

export default async function JoinMetaPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const preview = await vistaInvitacionMeta(code);

  if (!preview) {
    return (
      <MarcoInvitacion>
        <div className="glass-card p-8 text-center">
          <p className="text-sm text-[#D85A30] mb-4">Invitacion invalida o expirada</p>
          <Button variant="outline" nativeButton={false} render={<Link href="/dashboard" />}>
            Ir al dashboard
          </Button>
        </div>
      </MarcoInvitacion>
    );
  }

  return (
    <MarcoInvitacion>
      <div className="glass-card glass-card-glow p-6 space-y-5">
        <div className="text-center">
          <span className="text-4xl">{preview.icono}</span>
          <h1 className="text-lg font-semibold text-[#F0EFE8] mt-3">{preview.nombre}</h1>
          <p className="text-xs text-[#8A877D] mt-1">
            Creada por <span className="text-[#C8C6BC]">{preview.creador}</span>
          </p>
        </div>

        {/* Progress
          *
          * La barra crece con CSS (`.animate-barra-progreso` en globals.css) y no con
          * `motion`, que era el unico uso que quedaba en esta pantalla y le costaba
          * 118 KB sin comprimir (~38.8 KB gzip) de bundle propio: medido contra
          * produccion el 22-ago-2026, /join/meta pesaba 1159.0 KB contra los 1041.7 KB
          * de /join/gasto y /join/deuda, que ya no lo importan.
          *
          * La regla del repo (docblock de login/page.tsx) no es "nunca motion": es que
          * paga cuando anima estado que cambia de verdad. Esto anima un valor de runtime
          * UNA vez, al montar, y despues no vuelve a moverse — mas cerca de una entrada
          * decorativa que de estado vivo. Y la pantalla es la peor superficie posible
          * para pagarlo: se abre desde una invitacion de WhatsApp, en datos moviles, con
          * gente que todavia no tiene cuenta.
          */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-[#8A877D]">Progreso</span>
            <span className="text-[#1D9E75] font-medium">{preview.porcentaje}%</span>
          </div>
          <div className="h-2 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[#1D9E75] animate-barra-progreso"
              style={{ width: `${preview.porcentaje}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-[#8A877D] mt-1">
            <span>{formatCurrency(preview.monto_actual)}</span>
            <span>{formatCurrency(preview.monto_objetivo)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-[#8A877D]">
          <Users className="h-4 w-4" />
          <span>
            {preview.participantes} participante{preview.participantes !== 1 ? 's' : ''}
          </span>
        </div>

        <AccionUnirseMeta code={code} />
      </div>
    </MarcoInvitacion>
  );
}
