import { redirect } from 'next/navigation';

/**
 * La raíz no renderiza nada: rebota a /login.
 *
 * El rebote de verdad —y el forward de los parámetros de auth de Supabase a
 * /auth/callback— vive en `middleware.ts`, que ya corría en `/` para atrapar el `?ref`.
 * Esto es lo que queda cuando se le saca el trabajo: sin `searchParams` la ruta se
 * prerenderiza estática en vez de invocar una función serverless en cada visita
 * (hallazgo P′6: `X-Vercel-Cache: MISS` siempre, +150ms en caliente y +1.0s en frío).
 *
 * Sigue acá y no borrada porque en demo mode (`NEXT_PUBLIC_DEMO_MODE`) el middleware
 * sale antes de tocar cualquier regla de redirect, así que `/` llega hasta esta página.
 */
export default function Home() {
  redirect('/login');
}
