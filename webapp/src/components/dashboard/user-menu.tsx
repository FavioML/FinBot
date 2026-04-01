'use client';

import { useMemo, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useUser } from '@/lib/hooks/use-user';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { NotificationBell } from './notification-bell';

export function UserMenu() {
  const router = useRouter();
  const { data: user } = useUser();
  const supabase = createClient();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user: authUser } }) => {
      if (authUser?.user_metadata?.avatar_url) {
        setAvatarUrl(authUser.user_metadata.avatar_url);
      }
    });
  }, [supabase]);

  const initials = useMemo(() => {
    if (user?.nombre) return user.nombre.slice(0, 2).toUpperCase();
    if (user?.email) return user.email.slice(0, 2).toUpperCase();
    return 'NE';
  }, [user]);

  async function handleSignOut() {
    toast.success('Sesión cerrada');
    await supabase.auth.signOut();
    router.push('/');
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden md:block">
        <NotificationBell />
      </div>
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
    </div>
  );
}
