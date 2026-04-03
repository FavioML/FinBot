'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Usuario } from '@/lib/types';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_USER } from '@/lib/demo/mock-data';

export function useUser() {
  return useQuery({
    queryKey: ['user'],
    queryFn: async (): Promise<Usuario | null> => {
      if (IS_DEMO) return DEMO_USER;

      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      const { data } = await supabase
        .from('usuarios')
        .select('*')
        .eq('supabase_auth_id', user.id)
        .single();

      return data;
    },
  });
}
