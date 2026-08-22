import Link from 'next/link';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { vistaInvitacionEspacio } from '@/lib/invitaciones';
import { MarcoInvitacion, PieSinCuenta } from '../../marco';
import { AccionUnirseEspacio } from './accion';

/**
 * Resuelta en el servidor. El porqué está en `join/gasto/[code]/page.tsx`; lo medido acá:
 *
 *   first-paint = FCP 1624ms  →  LCP 4060ms   gap de 2436ms mirando "Cargando invitación..."
 */
export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  pareja: 'Espacio de pareja',
  roommates: 'Espacio de roommates',
  custom: 'Espacio compartido',
};

const TYPE_ICON: Record<string, string> = {
  pareja: '💑',
  roommates: '🏘️',
  custom: '👥',
};

export default async function JoinSpacePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const preview = await vistaInvitacionEspacio(code);

  if (!preview) {
    return (
      <MarcoInvitacion>
        <div className="glass-card p-8 text-center">
          <Users className="w-10 h-10 text-[#8A877D]/50 mx-auto" />
          <p className="text-base font-semibold text-[#F0EFE8] mt-3">Invitación no válida</p>
          <p className="text-sm text-[#8A877D] mt-1">Código de invitación inválido o expirado</p>
          <Button
            variant="outline"
            className="mt-4"
            nativeButton={false}
            render={<Link href="/dashboard" />}
          >
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
          <div className="w-14 h-14 rounded-2xl bg-[rgba(29,158,117,0.12)] flex items-center justify-center mx-auto">
            <span className="text-2xl">{TYPE_ICON[preview.type] || '👥'}</span>
          </div>
          <h1 className="text-lg font-semibold text-[#F0EFE8] mt-4">
            {preview.creator} te invita a un espacio
          </h1>
          <p className="text-xs text-[#8A877D] mt-1">
            {TYPE_LABEL[preview.type] || 'Espacio compartido'}
          </p>
        </div>

        <div className="text-center py-3 rounded-xl bg-[rgba(255,255,255,0.03)]">
          <p className="text-xl font-bold text-[#1D9E75]">{preview.name}</p>
          <p className="text-xs text-[#8A877D] mt-1">
            {preview.members_count} miembro{preview.members_count !== 1 ? 's' : ''}
          </p>
        </div>

        <AccionUnirseEspacio code={code} />

        <PieSinCuenta />
      </div>
    </MarcoInvitacion>
  );
}
