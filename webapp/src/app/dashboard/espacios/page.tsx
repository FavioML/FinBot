'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Users, Plus, ArrowRight, Lock, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import { useSpaces, useJoinSpace, useCreateSpace } from '@/lib/hooks/use-shared-spaces';

const TYPE_ICON: Record<string, string> = {
  pareja: '💑',
  roommates: '🏘️',
  custom: '👥',
};

const TYPE_LABEL: Record<string, string> = {
  pareja: 'Pareja',
  roommates: 'Roommates',
  custom: 'Grupo',
};

export default function EspaciosPage() {
  const router = useRouter();
  const { data, isLoading } = useSpaces();
  const joinSpace = useJoinSpace();
  const createSpace = useCreateSpace();

  const [joinCode, setJoinCode] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'pareja' | 'roommates' | 'custom'>('custom');

  const spaces = data?.spaces ?? [];
  const isPro = data?.isPro ?? false;

  async function handleJoin() {
    if (!joinCode.trim()) return;
    try {
      const res = await joinSpace.mutateAsync(joinCode.trim());
      toast.success('Te uniste al espacio');
      router.push(`/dashboard/espacios/${res.space_id}`);
    } catch {
      toast.error('Código inválido o expirado');
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const space = await createSpace.mutateAsync({ name: newName.trim(), type: newType });
      toast.success('Espacio creado');
      setShowCreate(false);
      setNewName('');
      router.push(`/dashboard/espacios/${space.id}`);
    } catch {
      toast.error('No se pudo crear el espacio');
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          {[1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <FadeIn>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[#F0EFE8]">Espacios Compartidos</h1>
            <p className="text-[#8A877D] text-sm mt-1">Divide gastos con tu pareja, roommates o amigos</p>
          </div>
          <Button
            onClick={() => setShowCreate(!showCreate)}
            className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-2 shrink-0"
            disabled={!isPro && spaces.length >= 1}
          >
            <Plus className="w-4 h-4" />
            Nuevo
          </Button>
        </div>
      </FadeIn>

      {/* Create form */}
      {showCreate && (
        <FadeIn>
          <div className="glass-card p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[#F0EFE8]">Crear espacio</h2>
            <Input
              placeholder="Nombre del espacio (ej: Depa 2025)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8]"
            />
            <div className="flex gap-2">
              {(['pareja', 'roommates', 'custom'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setNewType(t)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${
                    newType === t
                      ? 'border-[#1D9E75] bg-[rgba(29,158,117,0.12)] text-[#1D9E75]'
                      : 'border-[rgba(255,255,255,0.08)] text-[#8A877D]'
                  }`}
                >
                  {TYPE_ICON[t]} {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleCreate}
                disabled={!newName.trim() || createSpace.isPending}
                className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 flex-1"
              >
                {createSpace.isPending ? 'Creando...' : 'Crear'}
              </Button>
              <Button variant="ghost" onClick={() => setShowCreate(false)} className="text-[#8A877D]">
                Cancelar
              </Button>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Spaces list */}
      {spaces.length === 0 ? (
        <FadeIn delay={0.05}>
          <div className="glass-card p-8 flex flex-col items-center text-center gap-3">
            <Users className="w-10 h-10 text-[#8A877D]/50" />
            <h2 className="text-base font-semibold text-[#F0EFE8]">Aún no tienes espacios compartidos</h2>
            <p className="text-sm text-[#8A877D] max-w-xs">
              Crea uno desde WhatsApp: <span className="text-[#C8C6BC]">"crear espacio Depa"</span>
            </p>
          </div>
        </FadeIn>
      ) : (
        <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {spaces.map((space) => (
            <StaggerItem key={space.id}>
              <Link href={`/dashboard/espacios/${space.id}`}>
                <div className="glass-card p-5 flex items-center justify-between gap-4 hover:bg-[rgba(255,255,255,0.03)] transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{TYPE_ICON[space.type] ?? '👥'}</span>
                    <div>
                      <p className="text-sm font-semibold text-[#F0EFE8]">{space.name}</p>
                      <p className="text-xs text-[#8A877D]">
                        {TYPE_LABEL[space.type]} · {space.role === 'owner' ? 'Propietario' : 'Miembro'}
                      </p>
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#8A877D] shrink-0" />
                </div>
              </Link>
            </StaggerItem>
          ))}
        </StaggerContainer>
      )}

      {/* Join via code */}
      <FadeIn delay={0.1}>
        <div className="glass-card p-5 space-y-3">
          <h2 className="text-sm font-semibold text-[#F0EFE8] flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-[#1D9E75]" />
            Unirse con código
          </h2>
          <div className="flex gap-2">
            <Input
              placeholder="Código de invitación (ej: ABC1234)"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)] text-[#F0EFE8] uppercase"
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            />
            <Button
              onClick={handleJoin}
              disabled={!joinCode.trim() || joinSpace.isPending}
              className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
            >
              {joinSpace.isPending ? '...' : 'Unirse'}
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Pro wall */}
      {!isPro && (
        <FadeIn delay={0.15}>
          <div className="glass-card p-5 flex items-start gap-4 border border-[rgba(29,158,117,0.2)]">
            <div className="rounded-xl p-2.5 bg-[rgba(29,158,117,0.1)] shrink-0">
              <Lock className="w-5 h-5 text-[#1D9E75]" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-[#F0EFE8]">Más con Pro</p>
              <p className="text-xs text-[#8A877D] mt-1">
                Espacios ilimitados, hasta 6 miembros por espacio y splits personalizados.
              </p>
              <Link
                href="/dashboard/configuracion"
                className="inline-block mt-3 rounded-lg bg-[#1D9E75] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#1D9E75]/90 transition-colors"
              >
                Ver planes →
              </Link>
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
