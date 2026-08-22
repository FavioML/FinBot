import { getServiceClient } from '@/lib/supabase/service';

/**
 * Resolución de un código de invitación a la vista pública que ve quien lo abre.
 *
 * Vive acá y no dentro de las rutas `api/.../invite/route.ts` porque tiene DOS consumidores,
 * y el que importa es el nuevo: las pantallas `/join/*` la llaman **en el servidor**, antes
 * de mandar el HTML. Las rutas de API la siguen exponiendo por GET para los harness de
 * `qa-e2e/` (`qa-invite-codes.mjs`, `qa-espacios-config.mjs`), que la consultan sin navegador.
 *
 * POR QUÉ UNA SOLA CONSULTA Y NO TRES
 *
 * Cada preview necesitaba tres lecturas encadenadas (la fila, su padre, el nombre del
 * creador o el conteo de participantes). Encadenadas, no independientes: cada una necesita
 * el id que devuelve la anterior, así que no se paralelizan. Medido contra producción el
 * 22-ago-2026, con la función de Vercel en `iad1` y Supabase en `sa-east-1`:
 *
 *   GET /api/version        (0 consultas)   ttfb 394-422ms, n=8   ← línea base de red
 *   GET /api/debts/invite   (3 consultas)   ttfb 846-2036ms, n=8
 *
 * O sea ~450-1600ms de puro ir y volver a la base, sobre una pantalla que alguien abre desde
 * WhatsApp. Los `select` con embed de PostgREST traen lo mismo en un viaje: el nombre del
 * creador sale por la FK, y los conteos por el agregado `(count)` en vez de un `head:true`
 * aparte. Lo que se colapsa es la LATENCIA, no la consulta — el resultado es idéntico, y
 * `qa-e2e/qa-invitaciones-equivalencia.mjs` lo comprobó campo por campo contra producción
 * sobre todos los códigos vivos antes de desplegar esto.
 *
 * Las cuatro devuelven `null` para código inexistente, y esa es toda la señal de error que
 * hay: quien abre un código muerto ve "invitación inválida o expirada", no un stack.
 *
 * OJO con `error`: supabase-js NO lanza. Si no se mira, una caída de la base se ve igual que
 * un código inexistente. Acá las dos terminan en `null` a propósito —la pantalla es la misma
 * y no hay nada mejor que ofrecerle a quien llegó— pero el `error` se registra para que la
 * diferencia exista en algún lado.
 */

/** El agregado `(count)` de PostgREST llega como `[{ count: n }]`, y como `[]` si no hay filas. */
function conteo(embed: unknown): number {
  const filas = embed as Array<{ count?: number }> | null | undefined;
  return filas?.[0]?.count ?? 0;
}

function nombreDe(embed: unknown, porDefecto: string): string {
  return (embed as { nombre?: string } | null | undefined)?.nombre || porDefecto;
}

function sinFila(donde: string, error: { message?: string } | null): null {
  if (error) console.error(`[invitaciones:${donde}]`, error.message);
  return null;
}

export interface VistaGasto {
  creador: string;
  descripcion: string;
  monto_total: number;
  moneda: string;
  fecha_limite: string | null;
  participante_nombre: string;
  monto_debe: number;
  monto_pagado: number;
  pagado: boolean;
  ya_confirmada: boolean;
}

export async function vistaInvitacionGasto(code: string): Promise<VistaGasto | null> {
  const { data, error } = await getServiceClient()
    .from('gasto_participantes')
    .select(
      'nombre, monto_debe, monto_pagado, pagado, usuario_id, gastos_compartidos(descripcion, monto_total, moneda, fecha_limite, usuarios(nombre))'
    )
    .eq('invite_code', code)
    .maybeSingle();

  // El gasto padre es NOT NULL por FK, pero el embed devuelve `null` ahí si la fila se borró
  // entre medio: sin este corte la pantalla mostraría una invitación sin gasto.
  if (error || !data?.gastos_compartidos) return sinFila('gasto', error);
  // Sin tipos generados del esquema, supabase-js infiere TODO embed como arreglo. Los de
  // tipo "a-uno" llegan como objeto (comprobado contra PostgREST), de ahí el cast.
  const gasto = data.gastos_compartidos as unknown as {
    descripcion: string;
    monto_total: number;
    moneda: string;
    fecha_limite: string | null;
    usuarios: { nombre: string } | null;
  };

  return {
    creador: nombreDe(gasto.usuarios, 'Alguien'),
    descripcion: gasto.descripcion,
    monto_total: Number(gasto.monto_total),
    moneda: gasto.moneda,
    fecha_limite: gasto.fecha_limite,
    participante_nombre: data.nombre,
    monto_debe: Number(data.monto_debe),
    monto_pagado: Number(data.monto_pagado),
    pagado: data.pagado,
    ya_confirmada: !!data.usuario_id,
  };
}

export interface VistaDeuda {
  acreedor: string;
  contraparte: string;
  monto_original: number;
  monto_pendiente: number;
  moneda: string;
  descripcion: string | null;
  estado: string;
  ya_confirmada: boolean;
}

export async function vistaInvitacionDeuda(code: string): Promise<VistaDeuda | null> {
  // `vinculadas` cuenta las deudas que apuntan a ÉSTA (`deuda_vinculada_id`), que es el
  // testigo de que alguien ya la confirmó del otro lado. Es una FK de `deudas` a sí misma,
  // así que PostgREST exige el hint de la columna: sin `!deuda_vinculada_id` no resuelve.
  const { data, error } = await getServiceClient()
    .from('deudas')
    .select(
      'contraparte, monto_original, monto_pendiente, moneda, descripcion, estado, usuarios(nombre), vinculadas:deudas!deuda_vinculada_id(count)'
    )
    .eq('invite_code', code)
    .maybeSingle();

  if (error || !data) return sinFila('deuda', error);

  return {
    acreedor: nombreDe(data.usuarios, 'Alguien'),
    contraparte: data.contraparte,
    monto_original: Number(data.monto_original),
    monto_pendiente: Number(data.monto_pendiente),
    moneda: data.moneda,
    descripcion: data.descripcion,
    estado: data.estado,
    ya_confirmada: conteo(data.vinculadas) > 0,
  };
}

export interface VistaMeta {
  nombre: string;
  icono: string;
  monto_objetivo: number;
  monto_actual: number;
  porcentaje: number;
  creador: string;
  participantes: number;
}

export async function vistaInvitacionMeta(code: string): Promise<VistaMeta | null> {
  const { data, error } = await getServiceClient()
    .from('metas_ahorro')
    .select('nombre, icono, monto_objetivo, monto_actual, usuarios(nombre), meta_participantes(count)')
    .eq('invite_code', code)
    .eq('colaborativa', true)
    .maybeSingle();

  if (error || !data) return sinFila('meta', error);

  const objetivo = Number(data.monto_objetivo);
  const actual = Number(data.monto_actual);
  return {
    nombre: data.nombre,
    icono: data.icono,
    monto_objetivo: objetivo,
    monto_actual: actual,
    porcentaje: objetivo > 0 ? Math.round((actual / objetivo) * 100) : 0,
    creador: nombreDe(data.usuarios, 'Anonimo'),
    participantes: conteo(data.meta_participantes),
  };
}

export interface VistaEspacio {
  id: string;
  name: string;
  type: string;
  creator: string;
  members_count: number;
}

export async function vistaInvitacionEspacio(code: string): Promise<VistaEspacio | null> {
  const { data, error } = await getServiceClient()
    .from('shared_spaces')
    .select('id, name, type, usuarios(nombre), space_members(count)')
    // El código del espacio se guarda en mayúsculas; los otros tres distinguen may/min.
    // Esta normalización estaba en la ruta y se mantiene tal cual.
    .eq('invite_code', code.toUpperCase())
    .maybeSingle();

  if (error || !data) return sinFila('espacio', error);

  return {
    id: data.id,
    name: data.name,
    type: data.type,
    creator: nombreDe(data.usuarios, 'Alguien'),
    members_count: conteo(data.space_members),
  };
}
