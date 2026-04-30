'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useUser } from './use-user';
import { IS_DEMO } from '@/lib/demo/is-demo';

interface NpsEligibility {
  eligible: boolean;
  existingId?: string;
}

const DAYS_BEFORE_FIRST_PROMPT = 7;
const DAYS_AFTER_DISMISS = 90;

export function useNpsEligibility() {
  const { data: user } = useUser();

  return useQuery<NpsEligibility>({
    queryKey: ['nps-eligibility', user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<NpsEligibility> => {
      // No NPS prompts in demo mode
      if (IS_DEMO) return { eligible: false };
      if (!user?.id || !user.created_at) return { eligible: false };

      const daysSinceReg =
        (Date.now() - new Date(user.created_at).getTime()) / 86400000;
      if (daysSinceReg < DAYS_BEFORE_FIRST_PROMPT) return { eligible: false };

      const supabase = createClient();
      const { data: events, error } = await supabase
        .from('survey_events')
        .select('id, responded_at, dismissed_at')
        .eq('user_id', user.id)
        .eq('event_type', 'nps_inapp')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) return { eligible: false };

      const last = events?.[0];
      if (!last) return { eligible: true };
      // Already answered → never show again
      if (last.responded_at) return { eligible: false };
      if (last.dismissed_at) {
        const daysSinceDismiss =
          (Date.now() - new Date(last.dismissed_at).getTime()) / 86400000;
        if (daysSinceDismiss < DAYS_AFTER_DISMISS) return { eligible: false };
        return { eligible: true };
      }
      // Pending row exists (created but not responded/dismissed) — keep showing same row
      return { eligible: true, existingId: last.id };
    },
    staleTime: 1000 * 60 * 60, // 1h
    retry: 0,
  });
}
