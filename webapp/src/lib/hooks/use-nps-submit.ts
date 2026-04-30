'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useUser } from './use-user';
import type { NpsResponseData } from '@/lib/types-admin';

export function useNpsSubmit() {
  const { data: user } = useUser();
  const queryClient = useQueryClient();

  const respond = useMutation({
    mutationFn: async (response: NpsResponseData) => {
      if (!user?.id) throw new Error('No user');
      const supabase = createClient();

      // Look for an existing pending row (created via dismiss flow or otherwise)
      const { data: existing } = await supabase
        .from('survey_events')
        .select('id')
        .eq('user_id', user.id)
        .eq('event_type', 'nps_inapp')
        .is('responded_at', null)
        .is('dismissed_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const now = new Date().toISOString();
      const cleaned: NpsResponseData = {
        ease: response.ease,
        usefulness: response.usefulness,
        recommend: response.recommend,
        comment: response.comment?.trim() ? response.comment.trim() : null,
      };

      if (existing?.id) {
        const { error } = await supabase
          .from('survey_events')
          .update({
            responded_at: now,
            sent_at: now,
            response_data: cleaned,
          })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('survey_events').insert({
          user_id: user.id,
          event_type: 'nps_inapp',
          channel: 'webapp',
          triggered_at: now,
          sent_at: now,
          responded_at: now,
          response_data: cleaned,
        });
        // 23505 = unique violation (already responded in another tab) — ignore silently
        if (error && error.code !== '23505') throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nps-eligibility'] });
    },
  });

  const dismiss = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('No user');
      const supabase = createClient();

      const { data: existing } = await supabase
        .from('survey_events')
        .select('id')
        .eq('user_id', user.id)
        .eq('event_type', 'nps_inapp')
        .is('responded_at', null)
        .is('dismissed_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const now = new Date().toISOString();
      if (existing?.id) {
        const { error } = await supabase
          .from('survey_events')
          .update({ dismissed_at: now })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('survey_events').insert({
          user_id: user.id,
          event_type: 'nps_inapp',
          channel: 'webapp',
          triggered_at: now,
          sent_at: now,
          dismissed_at: now,
        });
        if (error && error.code !== '23505') throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nps-eligibility'] });
    },
  });

  return { respond, dismiss };
}
