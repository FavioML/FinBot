-- 084_usuarios_origen.sql
--
-- DE DÓNDE VINO CADA ALTA. Hoy ninguna lo sabe.
--
-- Medido el 2026-09-09 (audit `memory/audits/2026-09-09_seo-adquisicion_neto.md`): ninguna de las
-- 48 altas de agosto se puede atribuir a un canal. No era falta de instrumentación sino una cadena
-- cortada en dos puntos, y el segundo era éste: los CTA de la landing ya inyectaban la posición en
-- el texto prellenado de WhatsApp (`[hero]`, `[navbar]`, `[sticky]`, `[final]`, `[pricing-free]`,
-- `[pricing-pro]`), ese mensaje llegaba al backend con la etiqueta adentro, y un grep sobre `app/`
-- no encontraba NINGUNA lectura de ella. Se escribía y se descartaba.
--
-- **Por qué estas dos columnas viven en `usuarios` y no en una tabla de eventos.** El alta de Neto
-- ocurre en WhatsApp, no en la web, así que el primer mensaje es el único punto donde una sesión
-- de la landing toca un alta. Es un dato de PRIMER TOQUE, uno por persona y para siempre: tiene la
-- misma cardinalidad y el mismo ciclo de vida que la fila del usuario. Una tabla aparte pagaría un
-- join en cada consulta de embudo para guardar lo mismo.
--
-- ORIGEN vs ORIGEN_CTA, que contestan preguntas distintas y por eso son dos columnas:
--
--   origen      de qué canal vino la persona: 'ig', 'chatgpt.com', 'google', 'tiktok', 'directo'…
--               Vocabulario ABIERTO a propósito: sale del `utm_source` real cuando existe y del
--               hostname del referrer cuando no, y un canal nuevo no puede depender de que alguien
--               se acuerde de agregarlo a un CHECK. Un canal que aparece como su propio hostname
--               es información; un alta rechazada por un CHECK desactualizado es una pérdida.
--   origen_cta  en qué botón hizo clic: 'hero', 'navbar', 'sticky', 'final', 'pricing-free'…
--               Dice dónde convierte la landing, que es otra decisión (de copy y de layout).
--
-- **Nullable, sin DEFAULT y sin backfill, las tres cosas a propósito.** Las 100+ filas que ya
-- existen no tienen origen y nunca van a tenerlo: inventarles un `'desconocido'` las volvería
-- indistinguibles de las altas futuras que de verdad lleguen sin pista, que es justo la
-- distinción que hace falta para leer si esto funcionó. NULL significa "esta fila es de antes de
-- que midiéramos"; 'directo' significa "medimos y no había pista". No son lo mismo.
--
-- El único CHECK es de LARGO, no de valor: el código ya sanea (minúsculas, juego de caracteres
-- acotado, tope de 40) y esto es red de contención para un caller futuro, no validación de
-- negocio. Un CHECK sobre el conjunto de valores haría fallar el UPDATE en silencio el día que
-- aparezca un canal nuevo — ver [[feedback_supabase_gotchas]], "RLS escribe en silencio".

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS origen text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS origen_cta text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_origen_largo_chk') THEN
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_origen_largo_chk
      CHECK (char_length(origen) <= 40 AND char_length(origen_cta) <= 40);
  END IF;
END $$;

-- Para el `GROUP BY origen` del embudo. Parcial: las filas sin origen (todas las de antes de esta
-- migración) no entran al índice y no hay ninguna consulta que las busque por acá.
CREATE INDEX IF NOT EXISTS idx_usuarios_origen ON usuarios (origen) WHERE origen IS NOT NULL;

-- El borrado de cuenta NO las toca, y es una decisión, no un olvido: 'ig' / 'google' / 'directo'
-- no identifican a nadie, así que no entran a la lista de la lápida (migración 073). Borrarlas
-- además reescribiría el reparto por canal de meses pasados cada vez que alguien se da de baja,
-- que es corromper una serie histórica para no guardar un dato que no es personal.

COMMENT ON COLUMN usuarios.origen IS
  'Canal de PRIMER TOQUE del alta, parseado del texto del primer mensaje de WhatsApp (lib/atribucion.js). Vocabulario abierto. NULL = alta anterior a la migración 084; ''directo'' = se midió y no había pista.';
COMMENT ON COLUMN usuarios.origen_cta IS
  'Posición del CTA de la landing desde el que llegó el alta (hero, navbar, sticky, final, pricing-free, pricing-pro). NULL = no vino por un CTA de la landing.';
