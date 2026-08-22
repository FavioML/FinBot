import Link from 'next/link';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { vistaInvitacionGasto } from '@/lib/invitaciones';
import { MarcoInvitacion, PieSinCuenta } from '../../marco';
import { AccionConfirmarGasto } from './accion';

/**
 * La invitación se resuelve EN EL SERVIDOR, y esa es toda la diferencia con la versión que
 * había hasta el 22-ago-2026.
 *
 * Antes esta pantalla era un componente de cliente que pedía su propio contenido con un
 * `fetch` dentro de un `useEffect`. El HTML inicial traía un spinner, y lo que la persona
 * vino a ver —quién dividió el gasto y cuánto le toca— no podía aparecer hasta que bajara
 * el bundle, hidratara y volviera la request. Medido contra producción (412×823, 1.6 Mbps,
 * CPU 4×, contexto limpio, 5 corridas):
 *
 *   first-paint = FCP 1640ms  →  LCP 3776ms   **gap de 2136ms mirando "Cargando..."**
 *   (una corrida seguía en el spinner a los 6s)
 *
 * La ruta ya era dinámica (`X-Vercel-Cache: MISS` en todas las respuestas), o sea que la
 * función se invocaba igual en cada visita y devolvía un cascarón idéntico para cualquier
 * código: se pagaba el origen sin usarlo. Resolver la invitación acá no agrega un viaje,
 * usa el que ya se hacía.
 *
 * Cae sobre alguien que llega de una invitación de WhatsApp y todavía no tiene cuenta. Es
 * la peor pantalla del producto para hacer esperar.
 */
export const dynamic = 'force-dynamic';

export default async function JoinGastoPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const preview = await vistaInvitacionGasto(code);

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

  const puedeConfirmar = !preview.pagado && !preview.ya_confirmada;

  return (
    <MarcoInvitacion>
      <div className="glass-card glass-card-glow p-6 space-y-5">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-[rgba(239,159,39,0.12)] flex items-center justify-center mx-auto">
            <Users className="h-7 w-7 text-[#EF9F27]" />
          </div>
          <h1 className="text-lg font-semibold text-[#F0EFE8] mt-4">
            {preview.creador} dividio un gasto
          </h1>
          <p className="text-xs text-[#8A877D] mt-1">{preview.descripcion}</p>
        </div>

        <div className="text-center py-3 rounded-xl bg-[rgba(255,255,255,0.03)] space-y-2">
          <p className="text-xs text-[#8A877D]">
            Total: {formatCurrency(preview.monto_total, preview.moneda)}
          </p>
          <p className="text-2xl font-bold text-[#EF9F27]">
            Tu parte: {formatCurrency(preview.monto_debe, preview.moneda)}
          </p>
          {preview.monto_pagado > 0 && (
            <p className="text-xs text-[#1D9E75]">
              Ya abonaste: {formatCurrency(preview.monto_pagado, preview.moneda)}
            </p>
          )}
          {preview.fecha_limite && (
            <p className="text-xs text-[#8A877D]">
              Vence:{' '}
              {new Date(preview.fecha_limite + 'T12:00:00').toLocaleDateString('es-PE', {
                day: 'numeric',
                month: 'long',
              })}
            </p>
          )}
        </div>

        {preview.pagado && (
          <p className="text-center text-xs text-[#1D9E75] bg-[rgba(29,158,117,0.1)] rounded-lg py-2">
            Esta parte ya fue pagada
          </p>
        )}

        {preview.ya_confirmada && !preview.pagado && (
          <p className="text-center text-xs text-[#EF9F27] bg-[rgba(239,159,39,0.1)] rounded-lg py-2">
            Ya confirmaste esta participacion
          </p>
        )}

        {puedeConfirmar ? (
          <AccionConfirmarGasto code={code} />
        ) : (
          <Button
            variant="outline"
            className="w-full"
            nativeButton={false}
            render={<Link href="/dashboard/deudas" />}
          >
            Ir a mis deudas
          </Button>
        )}

        <PieSinCuenta />
      </div>
    </MarcoInvitacion>
  );
}
