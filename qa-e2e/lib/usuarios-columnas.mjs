// De dónde salen las columnas de `usuarios`, y qué hace el merge con cada una.
//
// Vive acá —y no dentro del test— porque hay DOS preguntas y las dos necesitan estos mismos
// datos, contra fuentes distintas:
//
//   · `tests/merge-and-link-columnas.test.js` (hermético, corre en cada push): ¿el árbol es
//     coherente consigo mismo? Compara lo que declaran las migraciones contra lo que
//     `merge_and_link` enumera.
//   · `qa-e2e/qa-web-signup-merge.mjs` (contra prod): ¿el árbol describe la DB REAL? Compara
//     esta derivación contra el esquema vivo que publica PostgREST.
//
// La segunda existe porque la primera tiene un punto ciego con historial en este repo: una
// columna creada directamente en prod no deja archivo, así que el guard hermético no la ve.
// La 059 documenta un caso de exactamente eso (el "hotfix remoto" sin espejo local, drift D4).
//
// LO QUE ESTE PAR **NO** MIRA, y conviene saberlo antes de confiarle algo más: las dos preguntas
// son sobre las COLUMNAS. El CUERPO de `merge_and_link` se lee siempre del ARCHIVO — o sea que si
// alguien reemplaza la función desde la consola de Supabase, los dos guards siguen verdes sobre
// una función que ya no es la que corre. Medido el 2026-08-14 (D12): hoy coinciden. El md5 del
// cuerpo vivo, normalizando comentarios y espacios, da `25008b336740cdd0f72af0906c93ab66`, igual
// al del archivo 066. Para recomprobarlo en 30 segundos, sin infra nueva:
//
//   -- lado vivo (MCP de Supabase / SQL editor)
//   select md5(trim(regexp_replace(regexp_replace(prosrc,'--[^\n]*','','g'),'\s+',' ','g')))
//     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
//    where n.nspname='public' and p.proname='merge_and_link';
//
//   # lado árbol (desde app/) — usa migracionDelMerge() para no apuntar a un archivo viejo
//   node -e "const f=require('node:fs'),c=require('node:crypto');
//     const t=f.readFileSync('migrations/066_merge_preserva_bsuid.sql','utf8');
//     const i=t.indexOf('AS \$function\$'), j=t.lastIndexOf('\$function\$');
//     console.log(c.createHash('md5').update(t.slice(i+13,j).replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim()).digest('hex'))"
//
// No se automatizó a propósito: leer `pg_proc` desde un harness pide una credencial que hoy no
// existe en `.env` (`SUPABASE_KEY` va por PostgREST, que no expone catálogos) o un objeto nuevo
// en `public` para exponerlo. Superficie nueva en prod por un hallazgo INFO no se paga sola; la
// alternativa barata es este comando, y queda escrito para que la próxima sesión no lo re-derive.
//
// El motivo de fondo del par: `merge_and_link` fusiona `usuarios` columna por columna y después
// BORRA la fila del loser. Lo que la función no nombra, no se conserva: se destruye. Pasó con
// `trial_*` (B11, migración 059) y con `bsuid` (B13, migración 066).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRACIONES = join(import.meta.dirname, '..', '..', 'migrations');

// Las 29 columnas que NINGÚN archivo de migrations/ declara. Congelada de verdad — solo cambia si
// alguien BORRA una columna vieja, y entonces el guard se pone rojo y hay que venir a decirlo acá.
//
// Acá decía "las 29 columnas anteriores a migrations/", y para TRES de ellas es falso (medido el
// 2026-08-14 contra `supabase_migrations.schema_migrations`, D12). Estas nacieron DESPUÉS de la
// 001 y no tienen archivo porque se aplicaron por la consola, quedando solo en el ledger remoto:
//
//   · is_test_user                              → `add_is_test_user_to_usuarios`      (20260506194606)
//   · esperando_comprobante, comprobante_solicitado_at
//                                               → `pro_payment_flow_pagos_and_flags`  (20260603163552)
//
// Importa por una razón concreta: quien "limpie" esta lista comparando fechas con migrations/ va
// a concluir que sobran y las va a sacar. No sobran — son exactamente el drift que esta lista
// existe para absorber, y sacarlas las deja sin clasificar en el merge (B11/B13 por tercera vez).
//
// Para recontarlas:
//   select column_name from information_schema.columns
//   where table_schema='public' and table_name='usuarios' order by ordinal_position;
export const BASE = [
  'id', 'whatsapp', 'nombre', 'created_at',
  'gmail_access_token', 'gmail_refresh_token', 'gmail_token_expiry',
  'email', 'onboarding_completado', 'onboarding_paso',
  'plan', 'reporte_usos_mes', 'reporte_reset_mes',
  'pago_pendiente', 'pago_referencia',
  'premium_desde', 'premium_vence', 'ref_code',
  'reporte_gmail_modo', 'recordatorios_activos', 'supabase_auth_id',
  'estado_pago', 'tipo_plan', 'fecha_pago', 'fecha_vencimiento', 'aprobado_gcc',
  'is_test_user', 'esperando_comprobante', 'comprobante_solicitado_at',
];

// Las columnas que el merge NO fusiona a propósito, cada una con su motivo. Es una declaración,
// no una absolución: si mañana una empieza a importar, el motivo escrito acá es lo que hay que
// contradecir.
//
// Leelas con la asimetría presente: el survivor es SIEMPRE la fila web (los dos call-sites lo
// eligen por `supabase_auth_id`) y el loser es la de WhatsApp, que se BORRA. "No fusionar"
// significa "se conserva lo del survivor y se pierde lo del loser".
export const NO_SE_FUSIONAN = {
  id: 'la PK del survivor: es la identidad que sobrevive, no un dato a fusionar.',
  supabase_auth_id:
    'el survivor se elige POR esta columna en los dos call-sites (webhook.js del OTP inverso y ' +
    'bind-activation.ts), así que ya tiene la buena; y si el loser tuviera OTRA, la función ' +
    'devuelve "conflict" antes de tocar nada.',
  pago_pendiente:
    'estado TRANSITORIO de un pago Yape en vuelo por WhatsApp (lib/pro-payment.js). El merge ' +
    'ocurre en el alta, no a mitad de un pago; y el RESULTADO del pago sí viaja, porque ' +
    'estado_pago / premium_* sí se fusionan.',
  pago_referencia: 'ídem pago_pendiente: referencia del pago en vuelo, no estado comercial.',
  esperando_comprobante:
    'ídem: flag de "te pedí la foto del Yape", vive minutos. Si algún día el flujo de pago ' +
    'puede cruzarse con un merge, este motivo deja de ser cierto.',
  comprobante_solicitado_at: 'ídem esperando_comprobante: es su timestamp.',
  referido_dscto_pct:
    'el 50% del referido se otorga sobre la fila que EXISTE al vincular el referido ' +
    '(services/referrals.js), y el vínculo es posterior al alta. No se fusiona hoy.',
  referido_dscto_vence: 'ídem referido_dscto_pct: es su fecha.',
  tour_visto:
    'cosmético y de la webapp: el tour se muestra en el dashboard, o sea sobre el survivor, que ' +
    'es justo la fila que tiene el valor bueno.',
  nombre_intentos:
    'contador del alta por WhatsApp (migración 051). Después del merge el alta ya terminó ' +
    '(onboarding_completado = true, en la misma sentencia), así que no vuelve a leerse.',
  activacion_nudge_at:
    'marca de "ya le mandé el empujón de activación". El merge SIGNIFICA que la activación se ' +
    'completó, así que el nudge no vuelve a evaluarse para esta persona.',
};

/**
 * Los `ADD COLUMN` que las migraciones le hacen a `usuarios`.
 *
 * Se busca la SENTENCIA `ALTER TABLE usuarios ... ;` y después TODOS los `add column` que haya
 * dentro. La primera versión pedía `alter table usuarios add column <x>` de una, y se perdía la
 * forma multi-columna —`ALTER TABLE t ADD COLUMN a ..., ADD COLUMN b ...`, que este árbol ya usa
 * en las migraciones 006, 018 y 050— quedándose con la PRIMERA columna y sin ver el resto. Ese
 * es exactamente el punto ciego que este guard existe para no tener: una columna invisible es
 * una columna que nadie clasifica, o sea B11/B13 por tercera vez. Lo encontró la revisión
 * adversarial del diff, no yo.
 */
export function columnasQueAgrega(sql) {
  const sentencia = /alter\s+table\s+(?:public\.)?"?usuarios"?\b[\s\S]*?;/gi;
  const addColumn = /\badd\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
  const out = [];
  for (const s of sql.matchAll(sentencia)) {
    for (const c of s[0].matchAll(addColumn)) out.push(c[1].toLowerCase());
  }
  return out;
}

export function columnasDeMigraciones() {
  const encontradas = new Set();
  for (const archivo of readdirSync(MIGRACIONES).filter((n) => n.endsWith('.sql'))) {
    for (const c of columnasQueAgrega(readFileSync(join(MIGRACIONES, archivo), 'utf8'))) {
      encontradas.add(c);
    }
  }
  return encontradas;
}

/** El esquema de `usuarios` según el árbol: base congelada + lo que agregan las migraciones. */
export function columnasSegunElArbol() {
  return new Set([...BASE, ...columnasDeMigraciones()]);
}

/**
 * La migración VIGENTE de merge_and_link: la de número más alto que la define. Se busca así —y
 * no por nombre de archivo— porque la próxima vez que haya que tocar la función el archivo se
 * va a llamar de otra cosa, y un guard que apunta a un archivo viejo mide la función vieja.
 */
export function migracionDelMerge() {
  const candidatas = readdirSync(MIGRACIONES)
    .filter((n) => n.endsWith('.sql'))
    .filter((n) => /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.merge_and_link/i.test(readFileSync(join(MIGRACIONES, n), 'utf8')))
    .sort();
  return candidatas[candidatas.length - 1];
}

/**
 * Columnas que el UPDATE del survivor asigna. Recorre TODOS los `UPDATE public.usuarios SET ...
 * WHERE id = p_survivor` del SQL (hay dos: el grande y la normalización del plan) y une sus
 * asignaciones. Devuelve también cuántos bloques vio, para que el llamador pueda detectar que
 * el parser se quedó sin nada que leer en vez de concluir "no fusiona ninguna".
 */
export function columnasQueElMergeNombra(sql) {
  // Los comentarios se van primero: si no, una línea comentada como `-- bsuid = COALESCE(...)`
  // contaría como fusionada y el guard daría verde sobre código muerto.
  const limpio = sql.replace(/--[^\n]*/g, '');
  const bloques = [...limpio.matchAll(/UPDATE\s+public\.usuarios\s+SET\b([\s\S]*?)\bWHERE\s+id\s*=\s*p_survivor/gi)];
  const cols = new Set();
  for (const b of bloques) {
    for (const m of b[1].matchAll(/^[ \t]*([a-z_][a-z0-9_]*)[ \t]*=/gim)) cols.add(m[1].toLowerCase());
  }
  return { cols, bloques: bloques.length };
}

/** Lee el SQL de la migración vigente del merge y devuelve sus columnas + el nombre del archivo. */
export function mergeVigente() {
  const archivo = migracionDelMerge();
  if (!archivo) return { archivo: null, cols: new Set(), bloques: 0 };
  const { cols, bloques } = columnasQueElMergeNombra(readFileSync(join(MIGRACIONES, archivo), 'utf8'));
  return { archivo, cols, bloques };
}
