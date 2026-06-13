'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X } from 'lucide-react';
import { TransactionForm } from '@/components/dashboard/transaction-form';
import { useUser } from '@/lib/hooks/use-user';
import { useTransactions } from '@/lib/hooks/use-transactions';
import { getCategoriaEmoji } from '@/lib/constants';
import { useQueryClient } from '@tanstack/react-query';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { haptic } from '@/lib/haptics';

export function QuickAddButton() {
  const { data: user } = useUser();
  const { data: transactions = [] } = useTransactions({ usuarioId: user?.id });
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [tipo, setTipo] = useState<'gasto' | 'ingreso'>('gasto');
  const [showMenu, setShowMenu] = useState(false);

  // Listen for quick-add events from QuickActions bar
  const handleQuickAdd = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    setTipo(detail?.tipo || 'gasto');
    setShowMenu(false);
    setOpen(true);
  }, []);

  useEffect(() => {
    window.addEventListener('neto:quick-add', handleQuickAdd);
    return () => window.removeEventListener('neto:quick-add', handleQuickAdd);
  }, [handleQuickAdd]);

  // Build user categories from transactions
  const userCategorias = useMemo(() => {
    const catMap = new Map<string, Set<string>>();
    for (const t of transactions) {
      if (!catMap.has(t.categoria)) catMap.set(t.categoria, new Set());
      if (t.subcategoria && t.subcategoria !== 'null' && t.subcategoria !== 'sin_categoria') {
        catMap.get(t.categoria)!.add(t.subcategoria);
      }
    }
    return Array.from(catMap.entries()).map(([nombre, subs]) => ({
      nombre,
      emoji: getCategoriaEmoji(nombre),
      subs: Array.from(subs),
    }));
  }, [transactions]);

  const handleAdd = (t: 'gasto' | 'ingreso') => {
    haptic('tap');
    setTipo(t);
    setShowMenu(false);
    setOpen(true);
  };

  if (!user) return null;

  return (
    <>
      {/* Speed dial menu */}
      <AnimatePresence>
        {showMenu && (
          <>
            {/* Backdrop */}
            <motion.div
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowMenu(false)}
            />
            {/* Options */}
            <div className="fixed bottom-36 md:bottom-[5.5rem] right-5 z-50 flex flex-col items-end gap-2">
              <motion.button
                className="flex items-center gap-2 rounded-full bg-[#1D9E75] pl-4 pr-3 py-2.5 text-sm font-medium text-white shadow-lg"
                initial={{ opacity: 0, y: 16, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.9 }}
                transition={{ delay: 0.05 }}
                onClick={() => handleAdd('gasto')}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                Nuevo gasto
                <span className="text-base">💸</span>
              </motion.button>
              <motion.button
                className="flex items-center gap-2 rounded-full bg-[#1A1A18] border border-[#1D9E75]/30 pl-4 pr-3 py-2.5 text-sm font-medium text-[#1D9E75] shadow-lg"
                initial={{ opacity: 0, y: 16, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.9 }}
                transition={{ delay: 0 }}
                onClick={() => handleAdd('ingreso')}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                Nuevo ingreso
                <span className="text-base">💰</span>
              </motion.button>
            </div>
          </>
        )}
      </AnimatePresence>

      {/* FAB */}
      <Tooltip>
        <TooltipTrigger
          render={
            <motion.button
              onClick={() => {
                haptic('tap');
                setShowMenu(!showMenu);
              }}
              className="fixed bottom-20 md:bottom-6 right-5 md:right-6 z-50 flex h-14 w-14 md:h-12 md:w-12 items-center justify-center rounded-full bg-[#1D9E75] text-white shadow-lg shadow-[#1D9E75]/30 transition-colors hover:bg-[#1D9E75]/90"
              aria-label="Agregar transaccion"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1, rotate: showMenu ? 45 : 0 }}
              transition={{ delay: 0.6, type: 'spring', stiffness: 260, damping: 20 }}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
            />
          }
        >
          <Plus className="h-6 w-6" />
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8}>
          Agregar transaccion
        </TooltipContent>
      </Tooltip>

      {/* Transaction form dialog */}
      <TransactionForm
        open={open}
        onOpenChange={setOpen}
        tipo={tipo}
        onSuccess={() => {
          haptic('success');
          queryClient.invalidateQueries({ queryKey: ['transactions'] });
        }}
        userCategorias={userCategorias}
      />
    </>
  );
}
