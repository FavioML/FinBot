'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SurveyConversationMessage,
  SurveyEvent,
  SurveyStats,
} from '@/lib/types-admin';

interface AdminSurveysFilters {
  event_type?: string;
  from?: string;
}

interface AdminSurveysResponse {
  events: SurveyEvent[];
  stats: SurveyStats;
  // Ventana del listado: total real de eventos mostrables y si la ventana los cubre todos.
  total: number;
  hasMore: boolean;
}

export function useAdminSurveys(filters?: AdminSurveysFilters) {
  return useQuery<AdminSurveysResponse>({
    queryKey: ['admin', 'surveys', filters ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.event_type) params.set('event_type', filters.event_type);
      if (filters?.from) params.set('from', filters.from);
      const qs = params.toString();
      const res = await fetch(`/api/admin/surveys${qs ? `?${qs}` : ''}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load surveys');
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}

interface ConversationResponse {
  messages: SurveyConversationMessage[];
  event: { id: string; user_id: string; sent_at: string | null };
}

export function useSurveyConversation(eventId: string | null) {
  return useQuery<ConversationResponse>({
    queryKey: ['admin', 'surveys', eventId, 'conversation'],
    enabled: !!eventId,
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/surveys/${eventId}/conversation`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error('Failed to load conversation');
      return res.json();
    },
    staleTime: 1000 * 60,
  });
}

export function useMarkSurveyRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/surveys/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_read' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'No se pudo marcar como leído');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'surveys'] });
    },
  });
}
