'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useUser } from '@/lib/hooks/use-user';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

interface TopbarProps {
  onMenuClick: () => void;
}

export function Topbar({ onMenuClick }: TopbarProps) {
  const router = useRouter();
  const { data: user } = useUser();
  const supabase = createClient();

  const initials = useMemo(() => {
    if (user?.email) {
      return user.email.slice(0, 2).toUpperCase();
    }
    if (user?.whatsapp) {
      return user.whatsapp.slice(-2);
    }
    return 'NE';
  }, [user]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/');
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-[rgba(255,255,255,0.06)] bg-[#0E0E0C] px-4 md:px-6">
      {/* Mobile hamburger */}
      <button
        onClick={onMenuClick}
        className="md:hidden rounded-md p-2 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#1D9E75]">
          <Avatar>
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
            Cerrar sesión
          </button>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
