import Link from 'next/link';
import { Coins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { vistaInvitacionDeuda } from '@/lib/invitaciones';
import { MarcoInvitacion, PieSinCuenta } from '../../marco';
import { AccionConfirmarDeuda } from './accion';

/**
 * Resuelta en el servidor. El porqué está en `join/gasto/[code]/page.tsx`; lo medido acá:
 *
 *   first-paint = FCP 1664ms  →  LCP 4172ms   gap de 2508ms mirando "Cargando..."
 */
export const dynamic = 'force-dynamic';

export default async function JoinDeudaPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const preview = await vistaInvitacionDeuda(code);

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

  const puedeConfirmar = preview.estado !== 'pagada' && !preview.ya_confirmada;

  return (
    <MarcoInvitacion>
      <div className="glass-card glass-card-glow p-6 space-y-5">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-[rgba(216,90,48,0.12)] flex items-center justify-center mx-auto">
            <Coins className="h-7 w-7 text-[#D85A30]" />
          </div>
          <h1 className="text-lg font-semibold text-[#F0EFE8] mt-4">
            {preview.acreedor} registró una deuda
          </h1>
          <p className="text-xs text-[#8A877D] mt-1">
            a nombre de <span className="text-[#C8C6BC]">{preview.contraparte}</span>
          </p>
        </div>

        <div className="text-center py-3 rounded-xl bg-[rgba(255,255,255,0.03)]">
          <p className="text-2xl font-bold text-[#D85A30]">
            {formatCurrency(preview.monto_original, preview.moneda)}
          </p>
          {preview.monto_pendiente < preview.monto_original && (
            <p className="text-xs text-[#8A877D] mt-1">
              Pendiente: {formatCurrency(preview.monto_pendiente, preview.moneda)}
            </p>
          )}
          {preview.descripcion && (
            <p className="text-xs text-[#8A877D] mt-2">{preview.descripcion}</p>
          )}
        </div>

        {preview.estado === 'pagada' && (
          <p className="text-center text-xs text-[#1D9E75] bg-[rgba(29,158,117,0.1)] rounded-lg py-2">
            Esta deuda ya fue saldada
          </p>
        )}

        {preview.ya_confirmada && preview.estado !== 'pagada' && (
          <p className="text-center text-xs text-[#EF9F27] bg-[rgba(239,159,39,0.1)] rounded-lg py-2">
            Alguien ya confirmo esta deuda
          </p>
        )}

        {puedeConfirmar ? (
          <AccionConfirmarDeuda code={code} />
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
