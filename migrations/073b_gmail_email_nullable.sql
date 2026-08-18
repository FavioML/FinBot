-- `gmail_cuentas.email` pasa a ser NULLABLE.
--
-- Sale de correr `borrar_cuenta_total` contra produccion dentro de una transaccion revertida:
-- 23502, `null value in column "email" of relation "gmail_cuentas"`. El borrado necesita
-- vaciar el correo (es dato personal y su unica funcion es el `login_hint`) y quedarse solo
-- con `email_hash`, que es lo que sostiene el cupo de los 100 de Google.
--
-- LA CONSECUENCIA QUE HAY QUE VER, porque abre justo el agujero que la 073 vino a tapar:
-- `emailGmailVinculado()` ordena por `created_at` y devuelve el `email` de la fila mas vieja.
-- Despues de un borrado esa fila tiene el correo en NULL, asi que la funcion devolveria null
-- y el gate de `routes/public.js` dejaria pasar CUALQUIER cuenta de Google — o sea, quemar
-- otro cupo permanente. Por eso el gate TIENE que leer `email_hash`, y no es opcional:
-- esta migracion sin el cambio de `gmail.js` + `routes/public.js` empeora las cosas.
--
-- El indice unico es sobre `(usuario_id, email)` y Postgres trata los NULL como distintos, o
-- sea que tras el borrado pueden convivir la lapida (email NULL + hash) y una reconexion
-- futura con su correo real. Es lo que se quiere: la lapida es la que recuerda el cupo.
ALTER TABLE public.gmail_cuentas ALTER COLUMN email DROP NOT NULL;

COMMENT ON COLUMN public.gmail_cuentas.email IS
  'El correo en claro. Se vacia en el borrado de cuenta; sobrevive email_hash. Solo alimenta el login_hint: para "ya gasto cupo" se mira email_hash. Ver migrations/073b.';
