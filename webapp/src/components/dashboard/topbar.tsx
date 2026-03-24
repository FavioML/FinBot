'use client';

import { Menu } from 'lucide-react';

interface TopbarProps {
  onMenuClick: () => void;
}

export function Topbar({ onMenuClick }: TopbarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center px-4 md:hidden">
      <button
        onClick={onMenuClick}
        className="rounded-md p-2 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
      >
        <Menu className="h-5 w-5" />
      </button>
    </header>
  );
}
