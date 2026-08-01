import Image from 'next/image';
import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { verificarTokenActivacion } from '@/lib/activacion-token';
import EntrarActivacion from './activar-client';

// Página de llegada del link que Neto manda por WhatsApp tras el primer gasto.
//
// Antes esto redirigía al /login normal, y ahí la persona se encontraba con una
// landing de captación: "Neto lee tus correos bancarios, sin anotar nada" — la
// promesa de otro producto, justo para quien acaba de anotar a mano —, un botón
// "Empezar por WhatsApp" (de donde venía) y un "crea tu cuenta" que invitaba a
// pensar que iba a empezar de cero. Su cuenta ya existe y tiene sus gastos
// adentro; esta página lo confirma antes de pedirle nada.
//
// Todo se resuelve del lado del servidor con el uid firmado en el token: sin
// sesión no hay forma de leer esto de otra manera. Se muestran montos y
// comercios y el número enmascarado — quien tiene el link ya tuvo acceso al
// teléfono, así que no revela nada que no estuviera en el mismo chat.

export const dynamic = 'force-dynamic';

const MAX_GASTOS = 3;

function enmascarar(numero: string | null): string | null {
  if (!numero) return null;
  const d = numero.replace(/\D/g, '');
  return d.length < 4 ? null : '••• ' + d.slice(-4);
}

function montoSoles(tx: { monto_pen: number | null; monto: number | null }): string {
  const valor = tx.monto_pen ?? tx.monto ?? 0;
  return 'S/' + Number(valor).toFixed(2);
}

export default async function ActivarPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  const payload = verificarTokenActivacion(t);
  // Firma inválida o vencido. No se distingue cuál de los dos: el siguiente gasto
  // que registre trae un link nuevo, así que la salida es la misma.
  if (!payload) redirect('/login?activacion=expirado');

  // Con sesión abierta NO se vincula desde acá. Esa sesión puede ser de otra
  // persona (teléfono compartido) y merge_and_link borra la fila perdedora, así
  // que la confirmación es explícita. Ver activar/confirmar/page.tsx.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect('/activar/confirmar');

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { data: fila } = await svc
    .from('usuarios')
    .select('id, nombre, whatsapp, supabase_auth_id')
    .eq('id', payload.uid)
    .maybeSingle();

  // El token es de un solo uso por construcción: activada la cuenta, queda inerte.
  if (!fila) redirect('/login?activacion=expirado');
  if (fila.supabase_auth_id) redirect('/login');

  const { data: gastos } = await svc
    .from('transacciones')
    .select('comercio, categoria, monto, monto_pen')
    .eq('usuario_id', fila.id)
    .eq('tipo', 'gasto')
    .order('fecha', { ascending: false })
    .limit(MAX_GASTOS);

  const { count: total } = await svc
    .from('transacciones')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', fila.id);

  const primerNombre = fila.nombre ? fila.nombre.split(' ')[0] : null;
  const cuantos = total ?? 0;
  const titular = cuantos === 1
    ? 'tu primer gasto te está esperando'
    : `tus ${cuantos} gastos te están esperando`;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0E0E0C] px-6 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <Image
            src="/neto-logo.png"
            alt="NETO"
            width={48}
            height={48}
            priority
            className="h-12 w-12 object-contain"
          />
          <span className="text-sm text-[#8A877D]">Tu cuenta de Neto ya existe</span>
        </div>

        <h1 className="mb-2 text-3xl font-bold leading-tight text-[#F0EFE8]">
          {primerNombre ? `${primerNombre}, ${titular}` : titular.charAt(0).toUpperCase() + titular.slice(1)}
        </h1>
        <p className="mb-7 text-[#8A877D]">
          {cuantos === 1 ? 'Entra y lo ves' : 'Entra y los ves'} en gráficos, con presupuestos y tu historial completo.
        </p>

        {gastos && gastos.length > 0 && (
          <div className="glass-card mb-7 rounded-2xl p-4">
            {gastos.map((g, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2 text-sm"
                style={i < gastos.length - 1 ? { borderBottom: '0.5px solid rgba(240,239,232,0.08)' } : undefined}
              >
                <span className="text-[#8A877D]">{g.comercio || g.categoria || 'Gasto'}</span>
                <span className="text-[#F0EFE8]">{montoSoles(g)}</span>
              </div>
            ))}
            {cuantos > gastos.length && (
              <p className="pt-3 text-xs text-[#8A877D]">y {cuantos - gastos.length} más</p>
            )}
          </div>
        )}

        <EntrarActivacion whatsappEnmascarado={enmascarar(fila.whatsapp)} />
      </div>
    </main>
  );
}
