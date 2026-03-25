'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ArrowRight, Receipt, Target, FileBarChart, CreditCard, Settings } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { formatCurrency, formatFecha } from '@/lib/utils';
import { getCategoriaEmoji } from '@/lib/constants';

const PAGES = [
  { name: 'Dashboard', path: '/dashboard', icon: FileBarChart, keywords: 'inicio resumen overview kpi' },
  { name: 'Transacciones', path: '/dashboard/transacciones', icon: Receipt, keywords: 'gastos ingresos pagos movimientos' },
  { name: 'Presupuestos', path: '/dashboard/presupuestos', icon: Target, keywords: 'limites budget categoria' },
  { name: 'Reporte PDF', path: '/dashboard/reportes', icon: FileBarChart, keywords: 'reporte score pdf grafico descargar exportar' },
  { name: 'Suscripciones', path: '/dashboard/suscripciones', icon: CreditCard, keywords: 'netflix spotify subscription' },
  { name: 'Metas de ahorro', path: '/dashboard/metas', icon: Target, keywords: 'meta ahorro objetivo savings goal' },
  { name: 'Configuracion', path: '/dashboard/configuracion', icon: Settings, keywords: 'perfil plan cuenta gmail' },
];

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const router = useRouter();

  const { data: user } = useUser();
  const { data: transactions = [] } = useTransactions({ usuarioId: user?.id });

  // Keyboard shortcut: Ctrl+K / Cmd+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(true);
        setQuery('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const navigate = useCallback((path: string) => {
    setOpen(false);
    router.push(path);
  }, [router]);

  const results = useMemo(() => {
    if (!query.trim()) return { pages: PAGES.slice(0, 4), transactions: [] };

    const q = query.toLowerCase().trim();

    // Filter pages
    const pages = PAGES.filter(
      (p) => p.name.toLowerCase().includes(q) || p.keywords.includes(q)
    );

    // Search transactions
    const txResults = transactions
      .filter(
        (t) =>
          t.comercio?.toLowerCase().includes(q) ||
          t.categoria?.toLowerCase().includes(q) ||
          t.subcategoria?.toLowerCase().includes(q) ||
          t.descripcion_original?.toLowerCase().includes(q)
      )
      .slice(0, 5);

    return { pages, transactions: txResults };
  }, [query, transactions]);

  return (
    <>
      {/* Search trigger — mobile icon */}
      <button
        onClick={() => { setOpen(true); setQuery(''); }}
        className="md:hidden rounded-md p-1.5 text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
      >
        <Search className="h-4 w-4" />
      </button>

      {/* Search trigger — desktop pill */}
      <button
        onClick={() => { setOpen(true); setQuery(''); }}
        className="hidden md:flex items-center gap-2 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] px-3 py-1.5 text-xs text-[#8A877D] hover:bg-[rgba(255,255,255,0.05)] hover:text-[#C8C6BC] transition-colors"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Buscar...</span>
        <kbd className="ml-4 rounded bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 text-[10px] font-mono">
          Ctrl K
        </kbd>
      </button>

      {/* Command palette dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#1A1A18] border-[rgba(255,255,255,0.08)] p-0 sm:max-w-lg gap-0 overflow-hidden">
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-[rgba(255,255,255,0.06)] px-4 py-3">
            <Search className="h-4 w-4 text-[#8A877D] shrink-0" />
            <input
              type="text"
              placeholder="Buscar transacciones, paginas..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-transparent text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none"
              autoFocus
            />
            <kbd className="rounded bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 text-[10px] text-[#8A877D] font-mono">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[360px] overflow-y-auto">
            {/* Pages */}
            {results.pages.length > 0 && (
              <div className="px-2 py-2">
                <p className="px-2 pb-1 text-[10px] font-medium text-[#8A877D] uppercase tracking-wider">Paginas</p>
                {results.pages.map((page) => {
                  const Icon = page.icon;
                  return (
                    <button
                      key={page.path}
                      onClick={() => navigate(page.path)}
                      className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors group"
                    >
                      <Icon className="h-4 w-4 text-[#8A877D] group-hover:text-[#1D9E75]" />
                      <span className="text-sm text-[#C8C6BC] group-hover:text-[#F0EFE8] flex-1">{page.name}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-[#8A877D] opacity-0 group-hover:opacity-100" />
                    </button>
                  );
                })}
              </div>
            )}

            {/* Transactions */}
            {results.transactions.length > 0 && (
              <div className="px-2 py-2 border-t border-[rgba(255,255,255,0.04)]">
                <p className="px-2 pb-1 text-[10px] font-medium text-[#8A877D] uppercase tracking-wider">Transacciones</p>
                {results.transactions.map((tx) => (
                  <button
                    key={tx.id}
                    onClick={() => navigate('/dashboard/transacciones')}
                    className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors group"
                  >
                    <span className="text-sm shrink-0">{getCategoriaEmoji(tx.categoria)}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#C8C6BC] truncate">{tx.comercio || tx.descripcion_original || tx.subcategoria}</p>
                      <p className="text-[10px] text-[#8A877D]">{formatFecha(tx.fecha)} · {tx.categoria}</p>
                    </div>
                    <span
                      className="text-xs font-medium tabular-nums shrink-0"
                      style={{ color: tx.tipo === 'ingreso' ? '#1D9E75' : '#D85A30' }}
                    >
                      {tx.tipo === 'ingreso' ? '+' : '-'}{formatCurrency(tx.monto_pen)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* No results */}
            {query.trim() && results.pages.length === 0 && results.transactions.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-[#8A877D]">Sin resultados para &quot;{query}&quot;</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
