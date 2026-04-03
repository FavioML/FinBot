import { createClient, SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _serviceClient: SupabaseClient<any, 'public', any> | null = null;

/** Lazy-initialized Supabase service-role client (avoids build-time crash when env vars are missing) */
export function getServiceClient() {
  if (!_serviceClient) {
    _serviceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _serviceClient;
}
