-- ============================================================
-- Migración: Sistema de Deudas
-- Proyecto: Neto (Supabase project: zvorjqlubmfrjtkbhqcx)
-- ============================================================

-- Tabla principal de deudas
CREATE TABLE IF NOT EXISTS deudas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id uuid REFERENCES usuarios(id) ON DELETE CASCADE NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('debo', 'me_deben')),
  contraparte text NOT NULL,           -- nombre del acreedor o deudor
  monto_original numeric(10,2) NOT NULL CHECK (monto_original > 0),
  monto_pendiente numeric(10,2) NOT NULL CHECK (monto_pendiente >= 0),
  moneda text DEFAULT 'PEN' CHECK (moneda IN ('PEN', 'USD')),
  descripcion text,
  fecha_inicio date DEFAULT CURRENT_DATE,
  fecha_vencimiento date,
  estado text DEFAULT 'activa' CHECK (estado IN ('activa', 'pagada')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Tabla de abonos/pagos parciales
CREATE TABLE IF NOT EXISTS deuda_abonos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deuda_id uuid REFERENCES deudas(id) ON DELETE CASCADE NOT NULL,
  monto numeric(10,2) NOT NULL CHECK (monto > 0),
  fecha date DEFAULT CURRENT_DATE,
  nota text,
  created_at timestamptz DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_deudas_usuario ON deudas(usuario_id);
CREATE INDEX IF NOT EXISTS idx_deudas_estado ON deudas(estado);
CREATE INDEX IF NOT EXISTS idx_deuda_abonos_deuda ON deuda_abonos(deuda_id);

-- RLS
ALTER TABLE deudas ENABLE ROW LEVEL SECURITY;
ALTER TABLE deuda_abonos ENABLE ROW LEVEL SECURITY;

-- Policies para deudas (webapp usa supabase_auth_id, backend usa id directamente)
CREATE POLICY "usuarios_own_deudas" ON deudas
  USING (
    usuario_id IN (
      SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid()
    )
  );

CREATE POLICY "usuarios_own_deuda_abonos" ON deuda_abonos
  USING (
    deuda_id IN (
      SELECT d.id FROM deudas d
      JOIN usuarios u ON u.id = d.usuario_id
      WHERE u.supabase_auth_id = auth.uid()
    )
  );
