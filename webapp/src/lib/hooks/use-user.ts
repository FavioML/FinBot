'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Usuario } from '@/lib/types';

export function useUser() {
  const supabase = createClient();

  return useQuery({
    queryKey: ['user'],
    queryFn: async (): Promise<Usuario | null> => {
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
