'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
      const res = await fetch('/api/notifications/inbox');
      if (!res.ok) throw new Error('Failed to fetch notifications');
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 60000, // Poll every 60s
  });
}

export function useNotificationMutations() {
  const queryClient = useQueryClient();

  const markRead = useMutation({
    mutationFn: async (data: { ids?: string[]; markAll?: boolean }) => {
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
      const res = await fetch(`/api/notifications/inbox?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete notification');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications-inbox'] }),
  });

  return { markRead, remove };
}
