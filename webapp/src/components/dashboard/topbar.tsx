'use client';

import { useMemo, useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Menu, LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useUser } from '@/lib/hooks/use-user';
import { MESES } from '@/lib/constants';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

interface TopbarProps {
  onMenuClick: () => void;
}

function generateMonthOptions() {
  const now = new Date();
  const options: { value: string; label: string }[] = [];

  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mes = d.getMonth() + 1;
    const anio = d.getFullYear();
    options.push({
      value: `${anio}-${mes}`,
      label: `${MESES[mes]} ${anio}`,
    });
  }

  return options;
}

export function Topbar({ onMenuClick }: TopbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: user } = useUser();
  const supabase = createClient();

  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const selectedMonth = searchParams.get('mes') || defaultMonth;

  const monthOptions = useMemo(() => generateMonthOptions(), []);

  const handleMonthChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set('mes', value);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

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
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-[rgba(255,255,255,0.06)] bg-[#0E0E0C] px-4 md:px-6">
      {/* Mobile hamburger */}
      <button
        onClick={onMenuClick}
        className="md:hidden rounded-md p-2 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Month selector */}
      <Select value={selectedMonth} onValueChange={handleMonthChange}>
        <SelectTrigger className="border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.03)] text-[#F0EFE8] hover:bg-[rgba(255,255,255,0.05)]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-[#141412] border-[rgba(255,255,255,0.06)]">
          {monthOptions.map((opt) => (
            <SelectItem
              key={opt.value}
              value={opt.value}
              className="text-[#F0EFE8] focus:bg-[rgba(255,255,255,0.05)] focus:text-[#F0EFE8]"
            >
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
        <DropdownMenuContent align="end" className="bg-[#141412] border-[rgba(255,255,255,0.06)] min-w-[180px]">
          <DropdownMenuLabel className="text-[#8A877D]">
            {user?.email || user?.whatsapp || 'Mi cuenta'}
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-[rgba(255,255,255,0.06)]" />
          <DropdownMenuItem
            className="text-[#D85A30] focus:text-[#D85A30] cursor-pointer"
            onClick={handleSignOut}
          >
            <LogOut className="h-4 w-4" />
            Cerrar sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
