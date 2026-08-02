#!/usr/bin/env bash
#
# Prueba de restauracion real: baja un backup de R2, lo descifra, lo restaura
# en un Postgres desechable y verifica que lo restaurado sea igual al origen.
#
# Un backup que nunca se restauro no es un backup, es un archivo. Esto es lo
# que convierte una cosa en la otra, y por eso corre solo en el workflow
# semanal ademas de a mano.
#
# Uso:
#   scripts/backup/restore-verify.sh                  # el mas reciente de daily/
#   scripts/backup/restore-verify.sh daily/neto-backup-2026....tar.gz.age
#
# Variables:
#   AGE_KEY_FILE   archivo con la clave PRIVADA age (default ~/.config/neto/age-key.txt)
#   PG_BIN         directorio de los binarios de Postgres 17
#   AGE_BIN        ejecutable de age
#   R2_*           credenciales de R2
#
set -euo pipefail

PG_BIN="${PG_BIN:-}"
AGE_BIN="${AGE_BIN:-age}"
AGE_KEY_FILE="${AGE_KEY_FILE:-$HOME/.config/neto/age-key.txt}"
INITDB="${PG_BIN:+$PG_BIN/}initdb"
PG_CTL="${PG_BIN:+$PG_BIN/}pg_ctl"
PSQL="${PG_BIN:+$PG_BIN/}psql"

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OBJETO="${1:-}"

# En Git Bash los binarios de Postgres son .exe nativos y no entienden rutas
# estilo /c/...; en Linux esto es identidad.
ruta_nativa() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

[ -f "$AGE_KEY_FILE" ] || { echo "No encuentro la clave privada en $AGE_KEY_FILE" >&2; exit 2; }

TRABAJO="$(mktemp -d)"
PGDATA_DIR="${TRABAJO}/pgdata"
PUERTO=0
FALLAS=0

limpiar() {
  if [ "$PUERTO" != "0" ]; then
    "$PG_CTL" -D "$(ruta_nativa "$PGDATA_DIR")" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TRABAJO" 2>/dev/null || true
}
trap limpiar EXIT

fallo() { echo "  FALLA: $*"; FALLAS=$((FALLAS + 1)); }
ok()    { echo "  ok: $*"; }

# --- 1. Traer el backup -----------------------------------------------------
echo "==> 1/7 Descargando de R2"
if [ -z "$OBJETO" ]; then
  OBJETO="$(node "${AQUI}/r2.mjs" list daily/ | grep 'tar.gz.age' | sort | tail -1 | awk '{print $NF}')"
  [ -n "$OBJETO" ] || { echo "No hay backups en daily/" >&2; exit 1; }
fi
echo "    objeto: ${OBJETO}"
node "${AQUI}/r2.mjs" get "$OBJETO" "${TRABAJO}/b.age" >/dev/null

# --- 2. Descifrar y extraer -------------------------------------------------
echo "==> 2/7 Descifrando"
"$AGE_BIN" -d -i "$AGE_KEY_FILE" -o "${TRABAJO}/b.tar.gz" "${TRABAJO}/b.age"
tar xzf "${TRABAJO}/b.tar.gz" -C "$TRABAJO"
BK="$(find "$TRABAJO" -maxdepth 1 -type d -name 'neto-backup-*' | head -1)"
[ -n "$BK" ] || { echo "El tar no contiene un directorio neto-backup-*" >&2; exit 1; }
ok "extraido $(basename "$BK")"

# --- 3. Integridad del artefacto contra el manifiesto ------------------------
echo "==> 3/7 Verificando sha256 de cada archivo contra el manifiesto"
node - "$BK" <<'NODE' || exit 1
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const bk = process.argv[2];
const man = JSON.parse(fs.readFileSync(path.join(bk, 'MANIFEST.json'), 'utf8'));
const vistos = new Set();
let malos = 0;
const caminar = (dir, base = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) { caminar(path.join(dir, e.name), rel); continue; }
    if (rel === 'MANIFEST.json') continue;
    vistos.add(rel);
    const real = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, e.name))).digest('hex');
    if (man.sha256[rel] !== real) { console.log(`  FALLA: sha256 no coincide en ${rel}`); malos++; }
  }
};
caminar(bk);
for (const esperado of Object.keys(man.sha256)) {
  if (!vistos.has(esperado)) { console.log(`  FALLA: falta el archivo ${esperado}`); malos++; }
}
if (malos) { console.log(`  ${malos} archivo(s) con problemas`); process.exit(1); }
console.log(`  ok: ${vistos.size} archivos integros`);
NODE

ARCH_ESPERADOS=$(node -e "
const m = require('fs').readFileSync(process.argv[1] + '/MANIFEST.json', 'utf8');
console.log(JSON.parse(m).archivos_storage);" "$BK")
ARCH_REALES=$(find "${BK}/storage" -type f | wc -l | tr -d ' ')
if [ "$ARCH_ESPERADOS" = "$ARCH_REALES" ]; then ok "${ARCH_REALES} archivos de storage presentes"
else fallo "storage: manifiesto dice ${ARCH_ESPERADOS}, hay ${ARCH_REALES}"; fi

# --- 4. Postgres desechable -------------------------------------------------
echo "==> 4/7 Levantando Postgres 17 desechable"
for p in $(seq 54330 54360); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PUERTO=$p; break; fi
done
[ "$PUERTO" != "0" ] || { echo "No hay puerto libre" >&2; exit 1; }

mkdir -p "$PGDATA_DIR"
echo "postgres" > "${TRABAJO}/pw.txt"
"$INITDB" -D "$(ruta_nativa "$PGDATA_DIR")" -U postgres --auth=trust -E UTF8 --no-locale \
  --pwfile="$(ruta_nativa "${TRABAJO}/pw.txt")" >/dev/null 2>&1
"$PG_CTL" -D "$(ruta_nativa "$PGDATA_DIR")" -o "-p ${PUERTO} -k \"\" -c listen_addresses=127.0.0.1" \
  -l "$(ruta_nativa "${TRABAJO}/pg.log")" -w start >/dev/null
DEST="postgresql://postgres@127.0.0.1:${PUERTO}/postgres"
ok "escuchando en 127.0.0.1:${PUERTO}"

# --- 5. Restaurar -----------------------------------------------------------
echo "==> 5/7 Restaurando"
aplicar() {
  local etiqueta="$1" archivo="$2"
  local errores
  errores="$("$PSQL" "$DEST" -v ON_ERROR_STOP=1 -q -f "$(ruta_nativa "$archivo")" 2>&1 >/dev/null)" || {
    echo "  FALLA al aplicar ${etiqueta}:"; echo "$errores" | head -20; FALLAS=$((FALLAS + 1)); return 1;
  }
  [ -z "$errores" ] || { echo "  avisos en ${etiqueta}:"; echo "$errores" | head -5; }
  ok "aplicado ${etiqueta}"
}

# Los roles de Supabase: sin ellos los GRANT de public.sql fallan. Un proyecto
# Supabase nuevo ya los trae; aca hay que crearlos a mano.
"$PSQL" "$DEST" -q -v ON_ERROR_STOP=1 <<'SQL'
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role dashboard_user nologin;
create role supabase_admin superuser login;
create role supabase_auth_admin login createrole;
create role supabase_storage_admin login createrole;
create role supabase_realtime_admin nologin;
create role supabase_replication_admin login replication;
create role supabase_read_only_user login bypassrls;
create role supabase_etl_admin login;
create role supabase_privileged_role nologin;
grant anon, authenticated, service_role to authenticator;
drop schema if exists public cascade;
SQL
ok "roles de Supabase creados"

# Orden obligatorio: auth/storage primero, porque 14 policies de public
# referencian auth.uid() y CREATE POLICY falla si la funcion no existe.
aplicar "schema_supabase.sql (auth + storage)" "${BK}/schema_supabase.sql"
aplicar "public.sql (DDL + datos)"             "${BK}/public.sql"
aplicar "data_supabase.sql (auth/storage/migraciones)" "${BK}/data_supabase.sql"

# --- 6. Conteo fila por fila contra el manifiesto ---------------------------
echo "==> 6/7 Comparando filas restauradas contra el manifiesto"
"$PSQL" "$DEST" -Atq -c "
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
from t;" | tr -d '\r' > "${TRABAJO}/restaurado.json"

node - "$BK" "${TRABAJO}/restaurado.json" <<'NODE' || FALLAS=$((FALLAS + 1))
const fs = require('fs'), path = require('path');
const man = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'MANIFEST.json'), 'utf8'));
const rest = JSON.parse(fs.readFileSync(process.argv[3], 'utf8').trim());
const origen = man.filas_por_tabla;
let malas = 0, filas = 0;
for (const [tabla, n] of Object.entries(origen).sort()) {
  const r = rest[tabla];
  if (r === undefined) { console.log(`  FALLA: ${tabla} no existe en el restore (origen ${n})`); malas++; continue; }
  if (r !== n) { console.log(`  FALLA: ${tabla} origen=${n} restaurado=${r}`); malas++; continue; }
  filas += n;
}
const extra = Object.keys(rest).filter((t) => !(t in origen));
if (extra.length) console.log(`  aviso: tablas en destino que no estaban en el manifiesto: ${extra.join(', ')}`);
if (malas) { console.log(`  ${malas} tabla(s) con diferencia`); process.exit(1); }
console.log(`  ok: ${Object.keys(origen).length} tablas, ${filas} filas identicas al origen`);
NODE

# --- 7. Que los datos sirvan, no solo que esten -----------------------------
echo "==> 7/7 Chequeos de integridad sobre lo restaurado"
verificar() {
  local etiqueta="$1" sql="$2" esperado="$3"
  local real
  real="$("$PSQL" "$DEST" -Atq -c "$sql" | tr -d '\r')"
  if [ "$real" = "$esperado" ]; then ok "${etiqueta} = ${real}"
  else fallo "${etiqueta}: esperaba ${esperado}, obtuve ${real}"; fi
}

# Las FKs se aplicaron despues de los COPY: si una fila colgara, esto no seria 0.
verificar "transacciones huerfanas (sin usuario)" \
  "select count(*) from public.transacciones t left join public.usuarios u on u.id=t.usuario_id where u.id is null;" "0"
verificar "usuarios con auth roto (supabase_auth_id sin auth.users)" \
  "select count(*) from public.usuarios u where u.supabase_auth_id is not null and not exists (select 1 from auth.users a where a.id=u.supabase_auth_id);" "0"
verificar "identities sin user" \
  "select count(*) from auth.identities i left join auth.users u on u.id=i.user_id where u.id is null;" "0"
verificar "objetos de storage sin bucket" \
  "select count(*) from storage.objects o left join storage.buckets b on b.id=o.bucket_id where b.id is null;" "0"

# RLS y policies: si se perdieran, el restore "funciona" pero deja la base abierta.
RLS_ON="$("$PSQL" "$DEST" -Atq -c "select count(*) from pg_tables where schemaname='public' and rowsecurity;" | tr -d '\r')"
POLICIES="$("$PSQL" "$DEST" -Atq -c "select count(*) from pg_policies where schemaname='public';" | tr -d '\r')"
FUNCS="$("$PSQL" "$DEST" -Atq -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';" | tr -d '\r')"
echo "  RLS activo en ${RLS_ON} tablas, ${POLICIES} policies, ${FUNCS} funciones"
[ "$RLS_ON" -ge 36 ] || fallo "se esperaban al menos 36 tablas con RLS, hay ${RLS_ON}"
[ "$POLICIES" -ge 24 ] || fallo "se esperaban al menos 24 policies, hay ${POLICIES}"

# Una consulta de negocio de verdad, no un count.
echo "  muestra de datos restaurados:"
"$PSQL" "$DEST" -q -c "select to_char(sum(monto),'FM999999990.00') as total_pen, count(*) as tx, count(distinct usuario_id) as usuarios from public.transacciones;"

# Los archivos de storage: que sean JPEG de verdad, no ceros.
MALOS_JPG=0
while IFS= read -r f; do
  head -c 3 "$f" | grep -qa $'\xff\xd8\xff' || MALOS_JPG=$((MALOS_JPG + 1))
done < <(find "${BK}/storage" -type f -name '*.jpg')
if [ "$MALOS_JPG" = "0" ]; then ok "todos los comprobantes son JPEG validos"
else fallo "${MALOS_JPG} comprobante(s) no son JPEG"; fi

echo
if [ "$FALLAS" = "0" ]; then
  echo "RESTAURACION VERIFICADA: el backup ${OBJETO} se restaura completo y consistente."
else
  echo "RESTAURACION CON ${FALLAS} FALLA(S) — el backup NO es confiable."
  exit 1
fi
