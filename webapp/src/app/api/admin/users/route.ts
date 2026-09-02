import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { requireAdminUser, type UserTxStatsRow } from '@/lib/admin';
import {
  isRevenueUser,
  necesitaIndicePagos,
  tienePagoConPlata,
} from '@/lib/admin-revenue';
import { cargarPagosConPlata } from '@/lib/admin-revenue-db';
import { indexarGmail } from '@/lib/gmail-conectado';

export const dynamic = 'force-dynamic';

interface UserActivityRow {
  user_id: string;
  tx_14d: number;
  tx_30d: number;
  first_tx_at: string | null;
  last_tx_at: string | null;
  last_activity_at: string | null;
}

export async function GET() {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getServiceClient();

  // Las tres lecturas son independientes, así que van juntas.
  //
  // La de counts era el cuello de botella real del panel: llamaba a
  // `count_transactions_by_user`, una RPC que NUNCA existió en esta base (verificado contra
  // pg_proc), así que el fallback "por si acaso" no era un fallback, era el único camino:
  // una query por usuario, 84 roundtrips secuenciales por cada carga de pantalla. Ahora es
  // una sola RPC agregada (migración 039), que además no puede truncarse a 1000 filas
  // porque devuelve una fila por usuario, no una por transacción.
  const [
    { data: usuarios, error },
    { data: txStats },
    { data: activity },
    { data: authList },
    { data: gmailCuentas, error: errGmail },
  ] = await Promise.all([
    db
      .from('usuarios')
      .select(
        'id, whatsapp, is_test_user, cuenta_borrada_at, nombre, email, plan, trial_estado, trial_vence, onboarding_completado, gmail_access_token, created_at, premium_vence, premium_desde, supabase_auth_id, estado_pago, tipo_plan, fecha_pago, pago_pendiente',
      )
      .order('created_at', { ascending: false }),
    db.rpc('admin_user_tx_stats'),
    // Ventanas de actividad (14d/30d) + primera/ultima tx por usuario (migracion 042). Agrega en
    // SQL, una fila por usuario. Alimenta los segmentos de la pagina admin/users.
    db.rpc('admin_user_activity'),
    db.auth.admin.listUsers({ perPage: 1000 }),
    // La OTRA mitad de "tiene Gmail". La columna `usuarios.gmail_access_token` del select de
    // arriba es el almacén legacy; el actual es esta tabla, y el panel leía solo el viejo.
    // Ver `lib/gmail-conectado.ts` para por qué la unión no es opcional.
    db.from('gmail_cuentas').select('usuario_id, activa, auth_error_at'),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // **Falla cerrado, y no es paranoia de estilo.** supabase-js no lanza: con el error
  // descartado, `gmailCuentas` llega `null`, la unión se queda con la mitad legacy y la
  // pantalla pinta apagados a los que SÍ tienen Gmail. Es el mismo síntoma que este cambio
  // vino a arreglar, servido en verde por un fallo transitorio y sin una línea que lo diga.
  if (errGmail) {
    return NextResponse.json(
      { error: `No se pudo leer gmail_cuentas: ${errGmail.message}` },
      { status: 500 },
    );
  }
  // PostgREST corta en 1000 filas SIN error, igual que con `usuarios`. `gmail_cuentas` crece
  // monótonamente (sus filas sobreviven al borrado de cuenta: ahí vive el `email_hash` que
  // protege el cupo de Google), así que el techo se alcanza solo con el tiempo. Truncada, la
  // unión pierde conexiones indeterminadas y la pantalla vuelve a pintar apagados a usuarios
  // que sí tienen Gmail: el bug original, servido en silencio.
  if ((gmailCuentas || []).length >= 1000) {
    return NextResponse.json(
      { error: 'La lectura de `gmail_cuentas` llegó al techo de 1000 filas de PostgREST: el estado de Gmail saldría incompleto. Hay que paginar.' },
      { status: 500 },
    );
  }

  // Se normaliza UNA vez. Además de quitar los cinco `usuarios || []` repetidos, deja el
  // argumento de `cargarPagosConPlata` como un identificador pelado, que es lo que el guard de
  // call-sites puede verificar: con una expresión ahí no hay forma de saber por texto si la
  // población se acotó, y acotarla es el bug que ese guard existe para atrapar.
  const filas = usuarios || [];

  const gmail = indexarGmail(filas, gmailCuentas || []);

  // ¿A quién le entró plata alguna vez? Es lo que separa "Pro pagado" de "Pro cortesía" en la
  // etiqueta, y no se puede derivar de la fila de `usuarios`: los tres caminos que regalan Pro
  // escriben `plan='premium'` + `estado_pago='pagado'`, o sea lo mismo que un pago real.
  //
  // Va DESPUÉS del `Promise.all` y no adentro porque depende de `usuarios`: la lista de ids
  // sale de `idsParaIndicePagos`. El cargador falla cerrado (lanza), y acá eso se traduce al
  // mismo `{error}` con el que responde el resto de la ruta.
  let pagosConPlata;
  try {
    pagosConPlata = await cargarPagosConPlata(filas);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const countMap: Record<string, number> = {};
  for (const row of (txStats as UserTxStatsRow[] | null) || []) {
    countMap[row.usuario_id] = Number(row.tx_count);
  }

  const activityMap: Record<string, UserActivityRow> = {};
  for (const row of (activity as UserActivityRow[] | null) || []) {
    activityMap[row.user_id] = row;
  }

  // Auth provider (google / magic link) para los usuarios que llegaron por la webapp.
  const providerMap: Record<string, string> = {};
  for (const au of authList?.users || []) {
    providerMap[au.id] = au.app_metadata?.provider || au.app_metadata?.providers?.[0] || 'unknown';
  }

  const result = filas.map((u) => {
    // Determine canal: whatsapp (no webapp), google, magic_link (email)
    let canal: 'whatsapp' | 'google' | 'magic_link' = 'whatsapp';
    if (u.supabase_auth_id) {
      const provider = providerMap[u.supabase_auth_id] || 'unknown';
      canal = provider === 'google' ? 'google' : 'magic_link';
    }

    const act = activityMap[u.id];

    return {
      id: u.id,
      whatsapp: u.whatsapp,
      nombre: u.nombre,
      email: u.email,
      plan: u.plan || 'free',
      // Las DOS columnas del estado comercial. Se leían de la base desde siempre (están en el
      // select de arriba) y morían acá sin salir en la respuesta, así que el panel no tenía
      // con qué distinguir a quien está PROBANDO de quien PAGA — durante el trial `plan` vale
      // 'premium' a propósito (migración 052). Sin ellas, `admin-user-segments` clasifica todo
      // trial como Pro pagado y todo muro como "sin estrenar".
      trial_estado: u.trial_estado ?? null,
      trial_vence: u.trial_vence ?? null,
      estado_pago: u.estado_pago,
      tipo_plan: u.tipo_plan,
      fecha_pago: u.fecha_pago,
      premium_vence: u.premium_vence,
      premium_desde: u.premium_desde,
      pago_pendiente: u.pago_pendiente,
      /**
       * ¿Le entró plata alguna vez? Alimenta el estado `pro_cortesia` del badge. Se manda
       * derivado y no como columna porque no existe columna: ver `esCortesia`.
       */
      // `tienePagoConPlata` y no una lectura directa del `Map`: esa función pasa por la guarda
      // del dominio, así que acotar la población acá REVIENTA en vez de contestar que nadie
      // pagó. Era el único lector del índice que se salteaba la guarda, y sin ella una lista
      // corta dejaba el panel pintando "Pro cortesía" sobre todos los clientes que pagan.
      //
      // `necesitaIndicePagos` delante porque el barrido es sobre TODOS los usuarios, y a quien
      // nunca tuvo Pro no se le preguntó nada: ahí la respuesta correcta es "no", no un throw.
      tiene_pago: necesitaIndicePagos(u) && tienePagoConPlata(u, pagosConPlata),
      onboarding_completado: u.onboarding_completado,
      // Unión de las dos fuentes (ver `lib/gmail-conectado.ts`). Antes era
      // `!!u.gmail_access_token` a secas, o sea solo el almacén legacy.
      tiene_gmail: gmail.conectados.has(u.id),
      /** Conectado pero con la autorización caída: hay que pedirle que reconecte. */
      gmail_caido: gmail.caidos.has(u.id),
      tiene_webapp: !!u.supabase_auth_id,
      canal,
      transacciones: countMap[u.id] || 0,
      created_at: u.created_at,
      // Actividad (migracion 042) para segmentar en la pagina admin/users. Operacion los ignora.
      tx_14d: act ? Number(act.tx_14d) : 0,
      tx_30d: act ? Number(act.tx_30d) : 0,
      first_tx_at: act?.first_tx_at ?? null,
      last_tx_at: act?.last_tx_at ?? null,
      last_activity_at: act?.last_activity_at ?? null,
      // Cuenta interna (fundador / QA / harness): la pagina de analisis la excluye de los
      // segmentos. Misma definicion que isRevenueUser, para que la lista y el MRR no marquen
      // distinto al mismo usuario.
      is_internal: !isRevenueUser(u),
      // Se traía en el select y no salía en la respuesta, así que la pantalla de operación
      // mostraba a quien pidió borrar su cuenta como cliente activo con `premium_vence` en
      // 2027. El plan NO se toca (quien pagó conserva su Pro si vuelve): lo que se arregla es
      // que la lista lo diga.
      cuenta_borrada_at: u.cuenta_borrada_at ?? null,
    };
  });

  return NextResponse.json({ ok: true, total: result.length, usuarios: result });
}

// Update user (plan, status, etc.)
export async function PUT(request: Request) {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { id, action, ...data } = body;

  if (!id || !action) {
    return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
  }

  switch (action) {
    case 'set_plan': {
      const plan = data.plan === 'premium' ? 'premium' : 'free';
      const updates: Record<string, unknown> = { plan };
      if (plan === 'premium') {
        // Set premium_vence to 30 days from now by default, or use provided date
        const vence = data.premium_vence || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        updates.premium_vence = vence;
        updates.estado_pago = 'pagado';
      } else {
        updates.premium_vence = null;
        updates.estado_pago = null;
      }
      const { error } = await getServiceClient().from('usuarios').update(updates).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'set_plan', plan });
    }

    case 'extend_premium': {
      const days = parseInt(data.days) || 30;
      // Get current premium_vence
      // admin-revenue:no-alimenta-metricas — lee UNA fila para sumarle días al vencimiento.
      // No es una métrica de ingreso: es la acción de extender Pro sobre un usuario puntual.
      const { data: user } = await getServiceClient().from('usuarios').select('premium_vence').eq('id', id).single();
      const base = user?.premium_vence ? new Date(user.premium_vence) : new Date();
      const newVence = new Date(base.getTime() + days * 86400000).toISOString().split('T')[0];
      const { error } = await getServiceClient().from('usuarios').update({
        premium_vence: newVence, plan: 'premium', estado_pago: 'pagado',
      }).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'extend_premium', premium_vence: newVence });
    }

    case 'deactivate': {
      // Deactivate: set plan to free, clear Gmail token, clear premium
      const { error } = await getServiceClient().from('usuarios').update({
        plan: 'free', premium_vence: null, estado_pago: null,
        gmail_access_token: null, gmail_refresh_token: null,
      }).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'deactivate' });
    }

    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}

// Delete user and all their data
export async function DELETE(request: Request) {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const db = getServiceClient();

  // Protección de pagadores: no borrar por accidente un cliente que ya pagó.
  // Los bots/free se borran sin fricción; para forzar un pagador, pasar ?force=1.
  const force = searchParams.get('force') === '1';
  if (!force) {
    // **Se evaluó acotar esto a `monto > 0` —el mismo filtro que define `esCortesia`— y se
    // decidió NO hacerlo.** El argumento a favor: `activarPro` registra los comps en `pagos`
    // con `monto: 0`, así que un `estado='aprobado'` a secas también matchea un regalo, y esta
    // protección terminaría frenando el borrado de una cuenta a la que solo se le regaló Pro.
    //
    // El argumento en contra pesa más, y es el que manda acá: `esCortesia` tiene un límite
    // conocido —un cobro real que no llegue a `pagos` se lee como cortesía— y en el panel eso
    // se ve, porque la fila sale con su badge violeta. En un DELETE irreversible no se ve
    // nada: se pierde la única barrera que separa a un pagador de un `?force=1` que nadie
    // pidió. Medido el 2026-09-01, en producción no hay una sola fila en S/0 (12 aprobadas,
    // ninguna en cero), o sea que el problema que el filtro resolvería todavía no existe.
    //
    // Proteger de más cuesta un click; proteger de menos cuesta los datos de un cliente.
    const { data: pagoAprobado } = await db
      .from('pagos')
      .select('id')
      .eq('usuario_id', id)
      .eq('estado', 'aprobado')
      .limit(1)
      .maybeSingle();
    if (pagoAprobado) {
      return NextResponse.json(
        {
          error: 'protected',
          message: 'Este usuario tiene un pago aprobado. Confirma para borrarlo de todas formas.',
          requiresForce: true,
        },
        { status: 409 },
      );
    }
  }

  // El borrado en cascada lo maneja la base (FK ON DELETE CASCADE, migración
  // cascade_delete_usuarios_fks). Antes esto se hacía a mano tabla por tabla y la lista
  // quedaba incompleta (errores, neto_scores, meta_aportes, espacios...), lo que reventaba
  // el borrado con "error al eliminar". Ahora basta con borrar el usuario.
  const { error } = await db.from('usuarios').delete().eq('id', id);
  if (error) {
    return NextResponse.json(
      { error: error.message, message: 'No se pudo eliminar. Revisa dependencias en la base.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, action: 'deleted' });
}
