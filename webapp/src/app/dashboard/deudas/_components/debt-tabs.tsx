'use client';

import { Users } from 'lucide-react';

export type Tab = 'debo' | 'me_deben' | 'pagadas' | 'compartidos';

/** Barra de tabs + toggle "Agrupar por persona". */
export function DebtTabs({
  tab,
  onTabChange,
  tabList,
  showGroupToggle,
  vistaAgrupada,
  onToggleAgrupada,
}: {
  tab: Tab;
  onTabChange: (t: Tab) => void;
  tabList: { key: Tab; label: string; count: number }[];
  showGroupToggle: boolean;
  vistaAgrupada: boolean;
  onToggleAgrupada: () => void;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="overflow-x-auto max-w-full -mx-1 px-1">
        <div className="flex gap-1 p-1 bg-[rgba(255,255,255,0.03)] rounded-xl border border-[rgba(255,255,255,0.06)] w-max min-w-0">
          {tabList.map((t) => (
            <button
              key={t.key}
              onClick={() => onTabChange(t.key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                tab === t.key ? 'bg-[#1D9E75] text-white shadow' : 'text-[#8A877D] hover:text-[#C8C6BC]'
              }`}
            >
              {t.label}
              {t.count > 0 && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  tab === t.key ? 'bg-white/20' : 'bg-[rgba(255,255,255,0.08)]'
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      {showGroupToggle && (
        <button
          onClick={onToggleAgrupada}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            vistaAgrupada
              ? 'bg-[rgba(29,158,117,0.12)] text-[#1D9E75] ring-1 ring-[#1D9E75]/30'
              : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D] hover:text-[#C8C6BC]'
          }`}
        >
          <Users className="h-3.5 w-3.5" />
          Agrupar por persona
        </button>
      )}
    </div>
  );
}
