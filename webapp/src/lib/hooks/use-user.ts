'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Usuario } from '@/lib/types';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_USER } from '@/lib/demo/mock-data';
import { useBootstrapGate } from '@/lib/hooks/use-dashboard-bootstrap';

export function useUser() {
  // Gate: en el dashboard, el bootstrap consolidado (/api/dashboard) siembra
  // ['user']. Sin el gate, este fetch directo ganaría la carrera y activaría el
  // waterfall de hooks gated por userId antes de que se siembren los dominios.
  // Fuera del shell no hay provider → gate=true → self-fetch normal.
  const gate = useBootstrapGate();
  return useQuery({
    queryKey: ['user'],
    enabled: IS_DEMO || gate,
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
