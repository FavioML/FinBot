#!/usr/bin/env bash
#
# Backup diario de Neto: Postgres + archivos de Supabase Storage -> tar.gz
# cifrado con age -> Cloudflare R2.
#
# Corre igual en GitHub Actions (ubuntu) y en Git Bash (Windows). Lo unico que
# cambia es donde viven los binarios: PG_BIN / AGE_BIN.
#
# Variables requeridas:
#   SUPABASE_DB_URL             conexion al SESSION pooler (puerto 5432)
#   SUPABASE_URL                https://<ref>.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY   para bajar los archivos de Storage
#   AGE_PUBLIC_KEY              destinatario del cifrado (clave publica)
#   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
#
# Opcionales:
#   PG_BIN     directorio de pg_dump/psql (default: los del PATH)
#   AGE_BIN    ejecutable de age (default: age)
#   KEEP_LOCAL 1 = no borrar el directorio de trabajo (para depurar)
#
set -euo pipefail

PG_BIN="${PG_BIN:-}"
AGE_BIN="${AGE_BIN:-age}"
PSQL="${PG_BIN:+$PG_BIN/}psql"
PG_DUMP="${PG_BIN:+$PG_BIN/}pg_dump"

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for v in SUPABASE_DB_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY AGE_PUBLIC_KEY \
         R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  if [ -z "${!v:-}" ]; then echo "FALTA la variable $v" >&2; exit 2; fi
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DIA="$(date -u +%d)"
NOMBRE="neto-backup-${TS}"
TRABAJO="$(mktemp -d)"
SALIDA="${TRABAJO}/${NOMBRE}"
mkdir -p "${SALIDA}/storage"

limpiar() { [ "${KEEP_LOCAL:-0}" = "1" ] || rm -rf "${TRABAJO}"; }
trap limpiar EXIT

echo "==> Backup ${NOMBRE}"

# --- 1. Roles (solo referencia; Supabase recrea los suyos en un proyecto nuevo) --
echo "--> roles"
"$PSQL" "$SUPABASE_DB_URL" -Atq -o "${SALIDA}/roles.txt" -c \
  "select rolname || ' | login=' || rolcanlogin || ' | super=' || rolsuper
     from pg_roles where rolname not like 'pg\_%' order by 1;"

# --- 2. Schema public completo: DDL + datos en un solo dump ------------------
# Un dump combinado (no --schema-only + --data-only por separado) hace que
# pg_dump emita las FKs y los indices DESPUES de los COPY. Separarlos obliga a
# --disable-triggers, que en Supabase necesita superusuario que no tenemos.
echo "--> schema public (DDL + datos)"
"$PG_DUMP" "$SUPABASE_DB_URL" \
  --schema=public \
  --no-publications \
  --no-subscriptions \
  --quote-all-identifiers \
  -f "${SALIDA}/public.sql"

# --- 2b. DDL de auth/storage -------------------------------------------------
# En un restore hacia un proyecto Supabase nuevo esto NO se aplica: Supabase ya
# creo esas tablas. Va igual por dos razones: hace que el backup se pueda
# restaurar en un Postgres pelado (sin Supabase), y es contra esto que la
# prueba de restauracion levanta un destino fiel.
echo "--> DDL auth + storage + supabase_migrations (referencia)"
"$PG_DUMP" "$SUPABASE_DB_URL" \
  --schema-only --schema=auth --schema=storage --schema=supabase_migrations \
  --no-publications --no-subscriptions --quote-all-identifiers \
  -f "${SALIDA}/schema_supabase.sql"

# --- 3. Datos de schemas gestionados por Supabase ---------------------------
# Aca el DDL lo crea Supabase al levantar un proyecto nuevo: solo van los datos.
# Un pg_dump por tabla, concatenados en orden de dependencia, porque un
# --data-only con varias tablas no garantiza orden compatible con las FKs
# (identities referencia users) y no podemos desactivar triggers.
volcar_datos() {
  local destino="$1"; shift
  : > "$destino"
  for tabla in "$@"; do
    echo "    - ${tabla}"
    "$PG_DUMP" "$SUPABASE_DB_URL" --data-only --table="${tabla}" \
      --quote-all-identifiers >> "$destino"
  done
}

echo "--> datos auth + storage + migraciones"
volcar_datos "${SALIDA}/data_supabase.sql" \
  auth.users \
  auth.identities \
  storage.buckets \
  storage.objects \
  supabase_migrations.schema_migrations

# Estado de sesion. No se restaura (al cambiar el JWT secret del proyecto todo
# token queda invalido igual), pero se guarda para no excluir a ciegas.
echo "--> datos auth efimeros (no se restauran)"
volcar_datos "${SALIDA}/data_auth_efimero.sql" \
  auth.sessions \
  auth.refresh_tokens \
  auth.mfa_amr_claims \
  auth.flow_state \
  auth.one_time_tokens

# --- 4. Archivos de Supabase Storage ----------------------------------------
# Los comprobantes de pago Yape son archivos, no filas: un pg_dump solo guarda
# su metadata. Sin esto se pierde la evidencia de cobro.
echo "--> archivos de Storage"
# tr -d '\r': psql en Windows emite CRLF y el \r termina dentro del nombre del
# archivo y de la URL. En Linux es un no-op.
"$PSQL" "$SUPABASE_DB_URL" -Atq -F$'\t' -c \
  "select bucket_id, name from storage.objects order by bucket_id, name;" \
  | tr -d '\r' > "${TRABAJO}/objetos.tsv"

ARCHIVOS=0
while IFS=$'\t' read -r bucket nombre; do
  [ -n "${bucket:-}" ] || continue
  destino="${SALIDA}/storage/${bucket}/${nombre}"
  mkdir -p "$(dirname "$destino")"
  codigo=$(curl -sS -w '%{http_code}' -o "$destino" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    "${SUPABASE_URL}/storage/v1/object/${bucket}/${nombre}")
  if [ "$codigo" != "200" ]; then
    echo "ERROR bajando ${bucket}/${nombre}: HTTP ${codigo}" >&2
    exit 1
  fi
  ARCHIVOS=$((ARCHIVOS + 1))
done < "${TRABAJO}/objetos.tsv"
echo "    ${ARCHIVOS} archivos"

# --- 4b. Deteccion de esquemas nuevos ---------------------------------------
# El dump es --schema=public, asi que una tabla NUEVA en public entra sola.
# Un ESQUEMA nuevo, en cambio, quedaria fuera sin que nadie se entere. Esto
# obliga a que agregar un esquema sea una decision consciente: el backup falla
# hasta que alguien decida si va adentro (y lo agregue al dump) o no.
echo "--> esquemas"
CONOCIDOS="public,auth,storage,supabase_migrations,extensions,graphql,graphql_public,realtime,_realtime,vault,pgbouncer,cron,net,pgsodium,pgsodium_masks,supabase_functions,_analytics,_supavisor,pgtle,pg_toast,pg_catalog,information_schema"

DESCONOCIDOS="$("$PSQL" "$SUPABASE_DB_URL" -Atq -c "
select coalesce(string_agg(nspname, ', ' order by nspname), '')
from pg_namespace
where nspname not like 'pg\_%'
  and nspname <> all (string_to_array('${CONOCIDOS}', ','));" | tr -d '\r')"

if [ -n "$DESCONOCIDOS" ]; then
  echo "BACKUP RECHAZADO: hay esquemas que el backup no cubre: ${DESCONOCIDOS}" >&2
  echo "Decide si entran (agregalos a --schema en este script y a la lista de" >&2
  echo "conocidos) o si se excluyen a proposito. No los ignores en silencio." >&2
  exit 1
fi
echo "    ok: sin esquemas fuera del backup"

# --- 5. Manifiesto: la vara contra la que se verifica cualquier restore ------
echo "--> manifiesto"
"$PSQL" "$SUPABASE_DB_URL" -Atq -c "
with t as (
  select table_schema as sch, table_name as tbl,
         query_to_xml(format('select count(*) c from %I.%I', table_schema, table_name),
                      false, true, '')::text as x
  from information_schema.tables
  where table_type = 'BASE TABLE'
    and (table_schema = 'public'
         or (table_schema, table_name) in
             (('auth','users'),('auth','identities'),
              ('storage','buckets'),('storage','objects'),
              ('supabase_migrations','schema_migrations')))
)
select coalesce(json_object_agg(sch || '.' || tbl, (substring(x from '<c>(\d+)</c>'))::bigint), '{}'::json)
from t;" | tr -d '\r' > "${TRABAJO}/conteos.json"

# Estructura de public, para que el restore compare contra el origen y no
# contra numeros escritos a mano. Asi el dia que haya 40 tablas y 30 policies
# la verificacion sigue siendo exacta sin tocar nada.
"$PSQL" "$SUPABASE_DB_URL" -Atq -c "
select json_build_object(
  'tablas',      (select count(*) from pg_tables where schemaname='public'),
  'tablas_rls',  (select count(*) from pg_tables where schemaname='public' and rowsecurity),
  'policies',    (select count(*) from pg_policies where schemaname='public'),
  'funciones',   (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
  'triggers',    (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
                    join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and not t.tgisinternal),
  'indices',     (select count(*) from pg_indexes where schemaname='public'),
  'vistas',      (select count(*) from pg_views where schemaname='public')
);" | tr -d '\r' > "${TRABAJO}/estructura.json"

node - "$SALIDA" "$TS" "$ARCHIVOS" "${TRABAJO}/conteos.json" "${TRABAJO}/estructura.json" <<'NODE'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [salida, ts, archivos, conteosPath, estructuraPath] = process.argv.slice(2);
const conteos = JSON.parse(fs.readFileSync(conteosPath, 'utf8').trim());
const estructura = JSON.parse(fs.readFileSync(estructuraPath, 'utf8').trim());

const sha = {};
const caminar = (dir, base = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) caminar(abs, rel);
    else if (rel !== 'MANIFEST.json') {
      sha[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  }
};
caminar(salida);

fs.writeFileSync(path.join(salida, 'MANIFEST.json'), JSON.stringify({
  proyecto: 'neto',
  supabase_ref: 'zvorjqlubmfrjtkbhqcx',
  creado_utc: ts,
  pg_version_origen: process.env.PG_VERSION_ORIGEN || null,
  filas_por_tabla: conteos,
  total_filas: Object.values(conteos).reduce((a, b) => a + b, 0),
  archivos_storage: Number(archivos),
  estructura_public: estructura,
  sha256: sha,
}, null, 2) + '\n');
console.log(`    ${Object.keys(conteos).length} tablas, ${Object.values(conteos).reduce((a,b)=>a+b,0)} filas`);
console.log(`    public: ${estructura.tablas} tablas (${estructura.tablas_rls} con RLS), `
  + `${estructura.policies} policies, ${estructura.funciones} funciones, ${estructura.triggers} triggers`);
NODE

# --- 5b. Guardas antes de cifrar --------------------------------------------
# Una vez cifrado nadie sin la clave privada puede mirar adentro, asi que la
# unica oportunidad de detectar un dump vacio o truncado es ahora. Estas
# comprobaciones son las que corren todos los dias en CI; la restauracion
# completa se verifica aparte, donde si esta la clave privada.
echo "--> guardas de contenido"
node - "$SALIDA" <<'NODE'
const fs = require('fs'), path = require('path');
const salida = process.argv[2];
const man = JSON.parse(fs.readFileSync(path.join(salida, 'MANIFEST.json'), 'utf8'));
const filas = man.filas_por_tabla;

// Tablas sin las cuales el backup no sirve de nada, con un piso deliberado.
// Si el negocio crece estos numeros se suben; si BAJAN es que algo se rompio.
const MINIMOS = {
  'public.usuarios': 50,
  'public.transacciones': 1000,
  'auth.users': 30,
  'auth.identities': 30,
  'storage.objects': 1,
  'supabase_migrations.schema_migrations': 50,
};

const problemas = [];
for (const [tabla, minimo] of Object.entries(MINIMOS)) {
  const n = filas[tabla];
  if (n === undefined) problemas.push(`${tabla} no aparece en el manifiesto`);
  else if (n < minimo) problemas.push(`${tabla} tiene ${n} filas, se esperaban >= ${minimo}`);
}

// Los archivos bajados tienen que ser exactamente los que dice storage.objects.
if (man.archivos_storage !== filas['storage.objects']) {
  problemas.push(`storage: ${filas['storage.objects']} objetos en la DB pero ${man.archivos_storage} archivos bajados`);
}

// Un .sql de pocos bytes es un dump fallido que igual devolvio exit 0.
for (const [archivo, minBytes] of [['public.sql', 100000], ['data_supabase.sql', 10000], ['schema_supabase.sql', 10000]]) {
  const bytes = fs.statSync(path.join(salida, archivo)).size;
  if (bytes < minBytes) problemas.push(`${archivo} pesa ${bytes} bytes, se esperaban >= ${minBytes}`);
}

// Que los datos esten de verdad dentro del .sql, no solo el esquema.
const publicSql = fs.readFileSync(path.join(salida, 'public.sql'), 'utf8');
if (!/^COPY "public"\."transacciones"/m.test(publicSql)) problemas.push('public.sql no contiene los datos de transacciones');
if (!/CREATE POLICY/.test(publicSql)) problemas.push('public.sql no contiene policies de RLS');

if (problemas.length) {
  console.error('BACKUP RECHAZADO:');
  for (const p of problemas) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`    ok: ${Object.keys(MINIMOS).length} tablas criticas sobre el minimo, RLS y datos presentes`);

// Avisos: NO tumban el backup. Una tabla sin RLS es un problema de seguridad,
// pero quedarse sin respaldo del dia por eso seria peor. Sale en la
// notificacion para que se vea el mismo dia.
const avisos = [];
const est = man.estructura_public;
if (est.tablas !== est.tablas_rls) {
  avisos.push(`${est.tablas - est.tablas_rls} tabla(s) de public SIN RLS`);
}
if (est.tablas_rls > 0 && est.policies === 0) {
  avisos.push('RLS activo pero sin ninguna policy: la base quedaria cerrada a todos');
}
for (const a of avisos) console.log(`    AVISO: ${a}`);

// Resumen que lee el workflow para armar la notificacion de Telegram.
if (process.env.RESUMEN_OUT) {
  fs.writeFileSync(process.env.RESUMEN_OUT, JSON.stringify({
    tablas: Object.keys(filas).length,
    filas: man.total_filas,
    archivos: man.archivos_storage,
    estructura: est,
    avisos,
  }) + '\n');
}
NODE

# --- 6. Empaquetar, cifrar, subir -------------------------------------------
echo "--> empaquetando y cifrando"
tar -czf "${TRABAJO}/${NOMBRE}.tar.gz" -C "${TRABAJO}" "${NOMBRE}"
"$AGE_BIN" -r "$AGE_PUBLIC_KEY" -o "${TRABAJO}/${NOMBRE}.tar.gz.age" "${TRABAJO}/${NOMBRE}.tar.gz"
rm -f "${TRABAJO}/${NOMBRE}.tar.gz"

PESO=$(wc -c < "${TRABAJO}/${NOMBRE}.tar.gz.age")

# Que el archivo cifrado NO sea legible es parte del backup, no un detalle.
if head -c 200 "${TRABAJO}/${NOMBRE}.tar.gz.age" | grep -qa "CREATE TABLE\|COPY \|postgres"; then
  echo "ABORTADO: el archivo cifrado contiene texto plano reconocible" >&2
  exit 1
fi

echo "--> subiendo a R2 (${PESO} bytes)"
node "${AQUI}/r2.mjs" put "daily/${NOMBRE}.tar.gz.age" "${TRABAJO}/${NOMBRE}.tar.gz.age"

# Copia mensual el dia 1, con retencion propia mas larga (lifecycle de R2).
if [ "$DIA" = "01" ]; then
  echo "--> copia mensual"
  node "${AQUI}/r2.mjs" put "monthly/${NOMBRE}.tar.gz.age" "${TRABAJO}/${NOMBRE}.tar.gz.age"
fi

# --- 7. Retencion -----------------------------------------------------------
echo "--> retencion"
node "${AQUI}/r2.mjs" prune | tee "${TRABAJO}/prune.txt"

# Completar el resumen con lo que solo se sabe al final.
if [ -n "${RESUMEN_OUT:-}" ] && [ -f "${RESUMEN_OUT}" ]; then
  RETENIDOS="$(sed -n 's/^daily\/: \([0-9]*\) quedan.*/\1/p' "${TRABAJO}/prune.txt")"
  node -e "
    const fs = require('fs');
    const r = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    r.objeto = process.argv[2];
    r.peso = Number(process.argv[3]);
    r.retenidos = Number(process.argv[4] || 0);
    fs.writeFileSync(process.argv[1], JSON.stringify(r) + '\n');
  " "$RESUMEN_OUT" "daily/${NOMBRE}.tar.gz.age" "$PESO" "${RETENIDOS:-0}"
fi

echo "OK ${NOMBRE}.tar.gz.age (${PESO} bytes, ${ARCHIVOS} archivos de storage)"
