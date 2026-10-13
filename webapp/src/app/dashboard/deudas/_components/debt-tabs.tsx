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
        <div className="flex gap-1 p-1 bg-foreground/3 rounded-xl border border-border w-max min-w-0">
          {tabList.map((t) => (
            <button
              key={t.key}
              onClick={() => onTabChange(t.key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                tab === t.key ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground-soft'
              }`}
            >
              {t.label}
              {t.count > 0 && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  tab === t.key ? 'bg-foreground/20' : 'bg-foreground/8'
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
              ? 'bg-primary/12 text-primary-ink ring-1 ring-primary/30'
              : 'bg-foreground/4 text-muted-foreground hover:text-foreground-soft'
          }`}
        >
          <Users className="h-3.5 w-3.5" />
          Agrupar por persona
        </button>
      )}
    </div>
  );
}
