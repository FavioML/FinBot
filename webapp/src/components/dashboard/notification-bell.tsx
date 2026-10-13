'use client';

import { useState, useRef, useEffect } from 'react';
import { Bell, Check, X, AlertTriangle, Trophy, Target, Zap, ShieldAlert, Star, Users, TrendingDown, Receipt } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/lib/hooks/use-user';
import { useNotifications, useNotificationMutations, type Notificacion } from '@/lib/hooks/use-notifications';
import { track, EVENTS } from '@/lib/analytics';

/**
 * Icono y color por familia de notificación. Es puramente cosmético: un `tipo` que no esté
 * acá cae al fallback `sistema` más abajo, así que agregar un emisor nuevo en el backend
 * nunca rompe la campana — solo la deja genérica.
 *
 * `alerta_fugas` y `pro` estuvieron meses cayendo a ese fallback (35 y 2 filas en prod)
 * porque el backend los emitía y esta tabla nunca se enteró. La fuente de verdad de qué
 * tipos existen es `tipoInApp` en las llamadas a `notificarUsuario` (backend
 * lib/notify-user.js); si agregas uno nuevo y quieres que se vea distinto, agrégalo acá.
 */
const TIPO_CONFIG: Record<string, { icon: typeof Bell; color: string; bg: string }> = {
  deuda_vence: { icon: AlertTriangle, color: 'var(--negative)', bg: 'color-mix(in srgb, var(--negative) 12%, transparent)' },
  // El resumen semanal (backend `checkResumenDeudasSemanal`). Comparte la familia de deudas
  // pero NO el triángulo de alerta: un repaso de lo pendiente no es una alerta, y con el mismo
  // icono las dos filas del lunes se ven como el mismo aviso repetido.
  deuda_resumen: { icon: Receipt, color: 'var(--negative)', bg: 'color-mix(in srgb, var(--negative) 12%, transparent)' },
  milestone: { icon: Trophy, color: 'var(--warning)', bg: 'color-mix(in srgb, var(--warning) 12%, transparent)' },
  meta_completada: { icon: Target, color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 12%, transparent)' },
  recordatorio: { icon: Bell, color: 'var(--foreground-soft)', bg: 'color-mix(in srgb, var(--foreground) 6%, transparent)' },
  sistema: { icon: Zap, color: 'var(--foreground-soft)', bg: 'color-mix(in srgb, var(--foreground) 6%, transparent)' },
  alerta: { icon: ShieldAlert, color: 'var(--negative)', bg: 'color-mix(in srgb, var(--negative) 15%, transparent)' },
  alerta_fugas: { icon: TrendingDown, color: 'var(--negative)', bg: 'color-mix(in srgb, var(--negative) 12%, transparent)' },
  pro: { icon: Star, color: 'var(--warning)', bg: 'color-mix(in srgb, var(--warning) 12%, transparent)' },
  espacio: { icon: Users, color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 12%, transparent)' },
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
  const router = useRouter();
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

  /**
   * Abrir la campana no emitía ningún evento, y esa era la mitad que faltaba del embudo.
   * `notificaciones.leida` se escribe al hacer CLIC, así que un aviso sin clic podía ser
   * "nunca abrió la campana" o "la abrió y no le importó" — dos problemas con arreglos
   * OPUESTOS (canal vs. ruido) que el dato no separaba.
   *
   * Se manda UN evento por apertura con el inventario del panel, no uno por fila: hoy son ~23
   * avisos por usuario activo al mes, así que una impresión por notificación convertiría el
   * embudo en el mismo ruido que viene a medir.
   *
   * **`total` y `tipos` NO se derivan de `notifications`.** Esa lista viene capada en 20 por la
   * API (el panel no pagina), así que hasta el 2026-08-27 el campo que mide el RUIDO saturaba
   * justo en el único usuario del muestreo con volumen real — hay aperturas en PostHog con
   * `total: 20, no_leidas: 22`, y 20 es un número lo bastante plausible como para que nadie lo
   * mirara dos veces. Los exactos los calcula el servidor (`lib/notificaciones-resumen.ts`);
   * `listados` es aparte y sí es el largo de la lista, para poder ver el corte desde el dato.
   *
   * **`total: null` tiene DOS orígenes y se distinguen por `listados`.** Si el resumen falló
   * pero la lista llegó, `listados > 0`. Si se abrió la campana antes de que cargara nada
   * —`data` todavía es `undefined`— salen `listados: 0` y `no_leidas: 0`. Al usuario sin
   * avisos no se lo confunde con ninguno de los dos: ese trae `total: 0`, no `null`.
   *
   * **Nada de PII acá.** Van `tipo` y conteos; nunca `titulo`, `mensaje` ni `datos`, que llevan
   * nombres, montos y categorías. Es la regla del docblock de `track()`. Y nunca un `...spread`:
   * lo que viaja tiene que estar escrito acá para poder mirarlo.
   */
  function handleToggle() {
    const abriendo = !open;
    setOpen(abriendo);
    if (!abriendo) return;
    track(EVENTS.NOTIFICATIONS_OPENED, {
      // Exactos, del servidor. `null` = no se pudo medir; nunca 0 por un fallo silencioso.
      total: data?.total ?? null,
      no_leidas: unreadCount,
      // Cuáles había, para saber qué tipo se ignora sistemáticamente.
      tipos: data?.tipos ?? null,
      // Cuántos se llegaron a renderizar. Si vuelve a ser igual a `total` en un usuario con
      // volumen, el cap volvió.
      listados: notifications.length,
    });
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={handleToggle}
        className="relative rounded-lg p-2 text-muted-foreground hover:text-foreground-soft hover:bg-foreground/4 transition-all"
        aria-label="Notificaciones"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <motion.span
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-negative px-1 text-badge font-bold text-negative-foreground"
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
            className="absolute right-0 top-full mt-2 w-80 max-h-[400px] overflow-y-auto rounded-xl border border-border bg-surface-elevated shadow-2xl shadow-scrim/60 z-50"
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-sm font-medium text-foreground-soft">Notificaciones</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="text-xs text-primary-ink hover:text-primary-ink/80 transition-colors flex items-center gap-1"
                  >
                    <Check className="h-3 w-3" />
                    Marcar todas
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="text-muted-foreground hover:text-foreground-soft transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Notifications list */}
            {isLoading ? (
              <div className="px-4 py-8 text-center">
                <span className="text-xs text-muted-foreground">Cargando...</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Bell className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-30" />
                <p className="text-xs text-muted-foreground">Sin notificaciones</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {notifications.map((notif: Notificacion) => {
                  const config = TIPO_CONFIG[notif.tipo] || TIPO_CONFIG.sistema;
                  const Icon = config.icon;

                  return (
                    <button
                      key={notif.id}
                      onClick={() => {
                        // El otro extremo del embudo. `tipo` y si estaba sin leer, nada mas:
                        // `titulo` y `mensaje` llevan nombres, montos y categorias.
                        track(EVENTS.NOTIFICATION_CLICKED, {
                          tipo: notif.tipo,
                          estaba_no_leida: !notif.leida,
                        });
                        if (!notif.leida) handleMarkOneRead(notif.id);
                        const link = (notif.datos as Record<string, unknown>)?.link;
                        if (typeof link === 'string') {
                          setOpen(false);
                          router.push(link);
                        }
                      }}
                      className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-foreground/3 transition-colors cursor-pointer ${
                        !notif.leida ? 'bg-primary/4' : ''
                      }`}
                    >
                      <div
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5"
                        style={{ backgroundColor: config.bg }}
                      >
                        <Icon className="h-4 w-4" style={{ color: config.color }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={`text-xs font-medium ${!notif.leida ? 'text-foreground' : 'text-foreground-soft'}`}>
                          {notif.titulo}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {notif.mensaje}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
                        {timeAgo(notif.fecha)}
                      </span>
                      {!notif.leida && (
                        <span className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1.5" />
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
