import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { verificarTokenActivacion } from '@/lib/activacion-token';
import ConfirmarActivacion from './confirmar-client';

// Interstitial de confirmación: solo se llega acá si YA había una sesión abierta
// cuando el usuario tocó el link de WhatsApp. La sesión abierta no prueba que sea
// la misma persona (teléfono compartido, el Google de otro), y vincular fusiona
// cuentas de forma irreversible, así que el consentimiento es explícito.
//
// Cuando no hay sesión — el caso normal — este archivo no se toca: el login con
// Google ES el acto explícito y /auth/callback vincula directo.

export const dynamic = 'force-dynamic';

function enmascarar(numero: string | null): string {
  if (!numero) return 'tu WhatsApp';
  const d = numero.replace(/\D/g, '');
  return d.length < 4 ? 'tu WhatsApp' : '••• ' + d.slice(-4);
}

export default async function ConfirmarActivacionPage() {
  const token = (await cookies()).get('neto_act')?.value;
  const payload = verificarTokenActivacion(token);
  if (!payload) redirect('/login?activacion=expirado');

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?activar=1');

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { data: fila } = await svc
    .from('usuarios')
    .select('id, nombre, whatsapp, supabase_auth_id')
    .eq('id', payload.uid)
    .maybeSingle();

  // La cuenta ya está activada: no hay nada que confirmar ni que romper.
  if (!fila || fila.supabase_auth_id) redirect('/dashboard');

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0E0E0C] px-6">
      <div className="glass-card w-full max-w-md rounded-2xl p-8">
        <h1 className="mb-2 text-2xl font-bold text-[#F0EFE8]">
          {fila.nombre ? `Activar la cuenta de ${fila.nombre.split(' ')[0]}` : 'Activar tu cuenta'}
        </h1>
        <p className="mb-6 text-sm text-[#8A877D]">
          Vas a vincular los gastos que registraste desde{' '}
          <span className="text-[#F0EFE8]">{enmascarar(fila.whatsapp)}</span> con la sesión de{' '}
          <span className="text-[#F0EFE8]">{user.email}</span>.
        </p>
        <p className="mb-8 text-sm text-[#8A877D]">
          Si esa no es tu cuenta, cierra sesión primero y vuelve a abrir el enlace desde tu WhatsApp.
        </p>
        <ConfirmarActivacion />
      </div>
    </main>
  );
}
