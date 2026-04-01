'use client';

import { useState, useRef, useEffect } from 'react';
import { Bell, Check, X, AlertTriangle, Trophy, Target, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useUser } from '@/lib/hooks/use-user';
import { useNotifications, useNotificationMutations, type Notificacion } from '@/lib/hooks/use-notifications';

const TIPO_CONFIG: Record<string, { icon: typeof Bell; color: string; bg: string }> = {
  deuda_vence: { icon: AlertTriangle, color: '#D85A30', bg: 'rgba(216,90,48,0.12)' },
  milestone: { icon: Trophy, color: '#EF9F27', bg: 'rgba(239,159,39,0.12)' },
  meta_completada: { icon: Target, color: '#1D9E75', bg: 'rgba(29,158,117,0.12)' },
  recordatorio: { icon: Bell, color: '#C8C6BC', bg: 'rgba(255,255,255,0.06)' },
  sistema: { icon: Zap, color: '#C8C6BC', bg: 'rgba(255,255,255,0.06)' },
};

function timeAgo(dateStr: string): string {
  const now = new Date();
  const d = new Date(dateStr);
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}sem`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { data: user } = useUser();
  const { data, isLoading } = useNotifications(user?.id);
  const { markRead } = useNotificationMutations();

  const unreadCount = data?.unreadCount || 0;
  const notifications = data?.notifications || [];

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  function handleMarkAllRead() {
    markRead.mutate({ markAll: true });
  }

  function handleMarkOneRead(id: string) {
    markRead.mutate({ ids: [id] });
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(!open)}
        className="relative rounded-lg p-2 text-[#8A877D] hover:text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.04)] transition-all"
        aria-label="Notificaciones"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <motion.span
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#D85A30] px-1 text-[9px] font-bold text-white"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </motion.span>
        )}
      </button>

      {/* Dropdown panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute right-0 top-full mt-2 w-80 max-h-[400px] overflow-y-auto rounded-xl border border-[rgba(255,255,255,0.06)] bg-[#1A1A17] shadow-2xl shadow-black/40 z-50"
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[rgba(255,255,255,0.06)]">
              <span className="text-sm font-medium text-[#C8C6BC]">Notificaciones</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="text-[10px] text-[#1D9E75] hover:text-[#1D9E75]/80 transition-colors flex items-center gap-1"
                  >
                    <Check className="h-3 w-3" />
                    Marcar todas
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="text-[#8A877D] hover:text-[#C8C6BC] transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Notifications list */}
            {isLoading ? (
              <div className="px-4 py-8 text-center">
                <span className="text-xs text-[#8A877D]">Cargando...</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Bell className="h-8 w-8 text-[#8A877D] mx-auto mb-2 opacity-30" />
                <p className="text-xs text-[#8A877D]">Sin notificaciones</p>
              </div>
            ) : (
              <div className="divide-y divide-[rgba(255,255,255,0.04)]">
                {notifications.map((notif: Notificacion) => {
                  const config = TIPO_CONFIG[notif.tipo] || TIPO_CONFIG.sistema;
                  const Icon = config.icon;

                  return (
                    <button
                      key={notif.id}
                      onClick={() => {
                        if (!notif.leida) handleMarkOneRead(notif.id);
                      }}
                      className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-[rgba(255,255,255,0.03)] transition-colors ${
                        !notif.leida ? 'bg-[rgba(29,158,117,0.04)]' : ''
                      }`}
                    >
                      <div
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5"
                        style={{ backgroundColor: config.bg }}
                      >
                        <Icon className="h-4 w-4" style={{ color: config.color }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={`text-xs font-medium ${!notif.leida ? 'text-[#F0EFE8]' : 'text-[#C8C6BC]'}`}>
                          {notif.titulo}
                        </p>
                        <p className="text-[10px] text-[#8A877D] mt-0.5 line-clamp-2">
                          {notif.mensaje}
                        </p>
                      </div>
                      <span className="text-[9px] text-[#8A877D] shrink-0 mt-0.5">
                        {timeAgo(notif.fecha)}
                      </span>
                      {!notif.leida && (
                        <span className="h-2 w-2 rounded-full bg-[#1D9E75] shrink-0 mt-1.5" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
