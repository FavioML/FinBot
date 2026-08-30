'use client';

import { useMemo, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { getPerfilSesionSync } from '@/lib/supabase/session';
import { signOutAndClear } from '@/lib/query-client';
import { useUser } from '@/lib/hooks/use-user';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
export function UserMenu() {
  const router = useRouter();
  const { data: user } = useUser();
  // La foto sale de la cookie, no de un `getUser()` de red. Era una ida y vuelta a
  // Supabase en sa-east-1 (medida entre 130 y 1500 ms) durante el arranque del
  // dashboard, para pintar un avatar. Verificar el JWT no aporta nada acá: lo único
  // que alguien puede falsear editando su propia cookie es su propia foto de perfil.
  // Ver `getPerfilSesionSync` para dónde SÍ importa la verificación.
  //
  // Sigue en un efecto y no en el cuerpo del render: el shell del dashboard se
  // PRERENDERIZA (ver "Rendering" en webapp/CLAUDE.md), así que el HTML estático nace
  // sin cookie y sin avatar. Leerlo durante el render lo devolvería ya en la hidratación
  // y el árbol no coincidiría con el HTML servido. El efecto corre después de hidratar,
  // que es lo mismo que hacía la versión con `getUser()` — lo que cambia es que ya no
  // hay viaje a la red.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    setAvatarUrl(getPerfilSesionSync()?.avatarUrl ?? null);
  }, []);

  const initials = useMemo(() => {
    if (user?.nombre) return user.nombre.slice(0, 2).toUpperCase();
    if (user?.email) return user.email.slice(0, 2).toUpperCase();
    return 'NE';
  }, [user]);

  async function handleSignOut() {
    toast.success('Sesión cerrada');
    await signOutAndClear();
    router.push('/');
  }

  return (
      <DropdownMenu>
        <DropdownMenuTrigger className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#1D9E75] transition-transform hover:scale-105 active:scale-95">
          <Avatar className="h-10 w-10 ring-2 ring-transparent hover:ring-[#1D9E75]/30 transition-all">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={user?.nombre || ''} />}
            <AvatarFallback className="bg-[rgba(29,158,117,0.12)] text-[#1D9E75] text-xs font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-[#141412] border-[rgba(255,255,255,0.06)] min-w-[200px]">
        <div className="px-2 py-2">
          <p className="text-sm font-semibold text-[#F0EFE8]">{user?.nombre || 'Mi cuenta'}</p>
          <p className="text-xs text-[#8A877D]">{user?.email || user?.whatsapp || ''}</p>
        </div>
        <DropdownMenuSeparator className="bg-[rgba(255,255,255,0.06)]" />
        <button
          onClick={handleSignOut}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[#D85A30] hover:bg-[rgba(255,255,255,0.05)] cursor-pointer"
        >
          <LogOut className="h-4 w-4" />
          Cerrar sesion
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
