'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_NOTIFICATIONS } from '@/lib/demo/mock-data';

export interface Notificacion {
  id: string;
  usuario_id: string;
  tipo: string; // 'deuda_vence' | 'milestone' | 'meta_completada' | 'recordatorio' | 'sistema'
  titulo: string;
  mensaje: string;
  datos: Record<string, unknown>;
  leida: boolean;
  fecha: string;
  created_at: string;
}

interface InboxResponse {
  notifications: Notificacion[];
  unreadCount: number;
}

export function useNotifications(userId?: string) {
  return useQuery<InboxResponse>({
    queryKey: ['notifications-inbox', userId],
    queryFn: async () => {
      if (IS_DEMO) return DEMO_NOTIFICATIONS;
      const res = await fetch('/api/notifications/inbox');
      if (!res.ok) throw new Error('Failed to fetch notifications');
      return res.json();
    },
    enabled: IS_DEMO || !!userId,
    refetchInterval: IS_DEMO ? false : 60000,
  });
}

export function useNotificationMutations() {
  const queryClient = useQueryClient();

  const markRead = useMutation({
    mutationFn: async (data: { ids?: string[]; markAll?: boolean }) => {
      if (IS_DEMO) return { ok: true };
      const res = await fetch('/api/notifications/inbox', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to mark as read');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications-inbox'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (IS_DEMO) return { ok: true, id };
      const res = await fetch(`/api/notifications/inbox?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete notification');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications-inbox'] }),
  });

  return { markRead, remove };
}
