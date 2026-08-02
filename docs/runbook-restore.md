# Runbook: backup y restauración de la base de Neto

Qué respalda, dónde está, y cómo devolver Neto a la vida.

Última restauración de prueba verificada: **2026-08-02** (41 tablas, 11 554 filas,
13 comprobantes, RLS y policies intactas).

---

## 1. Lo que necesitas tener a mano

| Cosa | Dónde vive | Si se pierde |
|---|---|---|
| Clave privada `age` | Gestor de contraseñas de Favio + copia offline | **Todos los backups quedan ilegibles. No hay recuperación.** |
| Credenciales R2 | Secrets del repo + `~/.config/neto/backup.env` | Se genera un token nuevo en Cloudflare |
| Password de la base | Secrets del repo | Se resetea en el dashboard de Supabase |

La clave privada es el único elemento sin plan B. Todo lo demás se regenera.

---

## 2. Qué hay dentro de un backup

Cada objeto en R2 es un `.tar.gz` cifrado con `age` que contiene:

| Archivo | Qué es | ¿Se restaura? |
|---|---|---|
| `public.sql` | Los 36 tablas de la app: DDL + datos + RLS + policies + funciones | Sí, siempre |
| `data_supabase.sql` | Datos de `auth.users`, `auth.identities`, `storage.buckets`, `storage.objects`, `supabase_migrations` | Sí, siempre |
| `schema_supabase.sql` | DDL de `auth`/`storage`/`supabase_migrations` | Solo si el destino **no** es Supabase |
| `data_auth_efimero.sql` | Sesiones, refresh tokens, MFA, flow state | No. Al cambiar el JWT secret todos los tokens mueren igual |
| `storage/comprobantes/…` | Los comprobantes de pago Yape (archivos reales) | Sí, con `scripts/backup/restore-storage.sh` |
| `roles.txt` | Inventario de roles del origen, como referencia | No se aplica |
| `MANIFEST.json` | Conteo de filas por tabla + sha256 de cada archivo | Es contra esto que se verifica todo |

**`public.sql` lleva DDL y datos juntos a propósito.** Así `pg_dump` emite las FKs
y los índices *después* de los `COPY`. Separarlos obligaría a `--disable-triggers`,
que en Supabase necesita superusuario que no tenemos.

---

## 3. Restaurar en una emergencia

### Paso 0: no toques el proyecto roto

Si Supabase todavía responde, saca un backup manual **antes** de cualquier otra cosa:

```bash
cd /c/Vortik.dev/products/neto/app && set -a && . ~/.config/neto/backup.env && set +a && export AGE_PUBLIC_KEY=age1t38efyfp55sfl7q98vdp8m4dh5qth04kltz8ttagyxxyv0uqsvqq9kd5xq PG_BIN="$HOME/.local/pg/pgsql/bin" AGE_BIN="$HOME/.local/bin/age.exe" && bash scripts/backup/backup.sh
```

### Paso 1: elegir y bajar el backup

```bash
node scripts/backup/r2.mjs list daily/
```

```bash
node scripts/backup/r2.mjs get daily/neto-backup-AAAAMMDDTHHMMSSZ.tar.gz.age /tmp/b.age
```

### Paso 2: descifrar

```bash
age -d -i ~/.config/neto/age-key.txt -o /tmp/b.tar.gz /tmp/b.age && tar xzf /tmp/b.tar.gz -C /tmp
```

Si `age` dice `no identity matched any of the recipients`, tienes la clave equivocada.
No hay forma de forzarlo.

### Paso 3: crear el proyecto Supabase nuevo

Región **sa-east-1** (la misma, por latencia desde Perú). Anota el nuevo ref.
Espera a que quede `ACTIVE_HEALTHY`.

### Paso 4: aplicar

Con el **Session pooler** del proyecto nuevo (no la conexión directa):

```bash
psql "$NUEVO_DB_URL" -v ON_ERROR_STOP=1 -c 'drop schema if exists public cascade;'
```

```bash
psql "$NUEVO_DB_URL" -v ON_ERROR_STOP=1 -f /tmp/neto-backup-*/public.sql
```

```bash
psql "$NUEVO_DB_URL" -v ON_ERROR_STOP=1 -f /tmp/neto-backup-*/data_supabase.sql
```

`schema_supabase.sql` **no se aplica** acá: Supabase ya creó `auth` y `storage` al
crear el proyecto. Solo se usa si restauras en un Postgres pelado.

### Paso 5: los comprobantes

```bash
bash scripts/backup/restore-storage.sh /tmp/neto-backup-AAAAMMDDTHHMMSSZ
```

### Paso 6: repuntar la app

Cambiar en Railway (backend) y Vercel (webapp): `SUPABASE_URL` y `SUPABASE_KEY`
al ref nuevo. Regenerar las API keys desde el dashboard del proyecto nuevo.

Verificar los tres:

```bash
curl -I https://neto.pe/ && curl -I https://app.neto.pe/ && curl -I https://api.neto.pe/health
```

### Paso 7: avisar

Los usuarios van a tener que volver a iniciar sesión en app.neto.pe: las sesiones
no se restauran porque el JWT secret del proyecto nuevo es otro. Los datos están
completos; solo cambia que hay que loguearse de nuevo.

---

## 4. Probar la restauración sin tocar producción

Esto es lo que convierte un archivo en un backup. Levanta un Postgres 17
desechable, restaura todo y compara fila por fila contra el manifiesto:

```bash
cd /c/Vortik.dev/products/neto/app && set -a && . ~/.config/neto/backup.env && set +a && export PG_BIN="$HOME/.local/pg/pgsql/bin" AGE_BIN="$HOME/.local/bin/age.exe" && bash scripts/backup/restore-verify.sh
```

Termina en `RESTAURACION VERIFICADA` o falla con el detalle. No borra ni modifica
nada en producción ni en R2: solo lee.

**Corre esto una vez al mes.** No corre en GitHub Actions a propósito: necesitaría
la clave privada en la nube, y eso anularía el punto del cifrado asimétrico.

---

## 5. Por qué está armado así

**GitHub Actions y no Railway.** Si el backup viviera en la misma cuenta que la app,
una factura impaga o un borrado accidental en Railway se llevaría la app y sus
respaldos a la vez. Actions es un dominio de falla distinto. Además el repo es
público, así que los minutos son gratis e ilimitados.

**Cifrado asimétrico (`age`) y no simétrico.** GitHub solo conoce la clave pública.
Si mañana se filtran los secrets del repo o el token de R2, el atacante se lleva
blobs que no puede abrir. Con GPG simétrico el secreto que cifra es el mismo que
descifra, y ese secreto tendría que estar en Actions.

**El precio de esa decisión:** la verificación de restauración no puede correr en CI.
Por eso es mensual y manual, y por eso el workflow diario tiene guardas que sí
funcionan sin la clave privada (conteos mínimos por tabla, tamaño del `.sql`,
presencia de `COPY` y `CREATE POLICY`, comparación de peso contra la mediana).

**Session pooler y no conexión directa.** El host directo de Supabase es solo IPv6
y los runners de GitHub son solo IPv4. El pooler de transacciones (6543) tampoco
sirve: no soporta `pg_dump`. Tiene que ser el de sesión, puerto 5432.

**Retención con piso.** El prune borra lo más viejo de 30 días, pero **nunca deja
menos de 7 backups**. Sin ese piso, si el backup dejara de subir, el prune iría
vaciando el bucket por antigüedad justo cuando hace falta restaurar. Cubierto por
`tests/backup-prune.test.js`.

**`auth.users` y los comprobantes van incluidos.** Sin `auth.users` restauras las
transacciones pero nadie puede entrar a la webapp. Los comprobantes son archivos,
no filas: un `pg_dump` solo guarda su metadata, y sin ellos se pierde la evidencia
de cobro.

---

## 6. Qué NO cubre esto

- **Edge Functions y configuración del proyecto** (providers de auth, plantillas de
  correo, secrets de Supabase). Se reconfiguran a mano en el proyecto nuevo.
- **Point-in-time recovery.** El backup es diario. En el peor caso se pierden hasta
  24 h de transacciones. Con el plan Free de Supabase no hay PITR de ningún tipo.
- **Borrados lógicos recientes.** Si alguien borra datos y se nota a los 40 días,
  el backup diario ya no lo tiene. Para eso está la copia mensual (`monthly/`,
  365 días) y el trigger de auditoría de la migración 055.
