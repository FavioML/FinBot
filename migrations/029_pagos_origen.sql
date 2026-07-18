-- 029_pagos_origen.sql
-- Upgrade Pro desde la webapp: distinguir el canal de origen de cada solicitud de pago
-- ('whatsapp' | 'webapp') y acelerar la cola de pendientes.
--
-- Nota: la tabla `pagos` se creó fuera de control de versiones (Supabase SQL editor),
-- así que aquí solo aplicamos cambios aditivos idempotentes.

ALTER TABLE pagos ADD COLUMN IF NOT EXISTS origen text DEFAULT 'whatsapp';

CREATE INDEX IF NOT EXISTS idx_pagos_usuario_estado ON pagos (usuario_id, estado);
