// ¿Hay alguna fila con `is_test_user` que no sea un fixture declarado?
//
// El escenario que esto vigila no es hipotético, es el que casi ocurre el 13-ago-2026. Los
// harness que le pegan a producción siembran usuarios con `whatsapp = '519' + 8 dígitos AL
// AZAR`, o sea el espacio exacto de los celulares peruanos reales, y los borran al terminar.
// Hasta ese día el borrado no se verificaba: `del()` no miraba el status y el chequeo final era
// un `console.log`, así que una fila podía quedar viva sin que nadie se enterara.
//
// Lo que pasa si queda viva, y por qué el daño lo paga un tercero:
//
//   1. La persona dueña de ese número le escribe a Neto alguna vez.
//   2. `obtenerOCrearUsuario` (helpers/db-helpers.js) busca por número y ADOPTA la fila.
//   3. Esa persona hereda `is_test_user = true`.
//   4. `enviarWhatsapp` (lib/whatsapp.js) deja de llamar a Meta para ella: el bot le queda
//      MUDO. Registra sus gastos y no le contesta nunca.
//   5. `merge_and_link` propaga la marca con un OR (migraciones 046, 047, 059, 066), así que
//      un merge la vuelve permanente.
//
// Y desde `afca4ee` el aviso al admin también saltea `is_test_user`, o sea que el detector que
// podría haberlo delatado tampoco habla. El modo de falla es silencio total: no hay error, no
// hay log, y no hay usuario que reclame porque el usuario no recibe nada.
//
// LISTA BLANCA a propósito, al revés que los `watchPatterns` de railway.json. Allá el peligro
// es dejar de desplegar algo en silencio, así que el default es incluir. Acá el peligro es
// exactamente una fila marcada que nadie declaró, así que el default es GRITAR: un fixture
// nuevo rompe este guard hasta que alguien lo escriba abajo, y esa fricción es el punto.
//
// Read-only. Va detrás de la barrera de qa-guard igual que los demás probes: las lecturas pasan
// libres, y el día que alguien le agregue un "y de paso limpia las filas" ya está puesta.
//
// Correr:  node qa-e2e/qa-usuarios-marcados.mjs   (desde app/)
//   exit 0 = solo fixtures declarados
//   exit 1 = hay una fila marcada sin declarar  → ver el veredicto
//   exit 2 = no se pudo determinar (credenciales, red)

import 'dotenv/config';
import { clienteGuardado } from './lib/qa-guard.mjs';

// Los fixtures declarados, por valor EXACTO de `whatsapp`. No es un patrón: un `^5199999999\d$`
// también matchea un número que el generador del harness puede sacar al azar (`519` + 8
// dígitos cubre ese rango), o sea que el patrón que parece más cómodo es justo el que deja
// pasar al huérfano que esto busca.
const FIXTURES = new Set([
  'qa-test-dashboard',   // Camila Rojas — dashboard con datos, ver reference_neto_qa_test_user
  'qa-test-free',        // QA Free — fixture del muro
  '51900000003',         // QA Tercero
  '51999999995',         // Sofía QA Edge
  '51999999996',         // Diego QA Trial
  '51999999997',         // Andrea QA Pro
  '51999999998',         // Carlos QA
  '51999999999',         // Lucía QA
]);

const supabase = clienteGuardado(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log(JSON.stringify({ veredicto: 'INDETERMINADO', motivo: 'faltan SUPABASE_URL/SUPABASE_KEY' }));
    return 2;
  }

  const { data, error } = await supabase
    .from('usuarios')
    .select('id, whatsapp, nombre, plan, supabase_auth_id, created_at')
    .eq('is_test_user', true);

  // No lanza: sin mirar `error`, un timeout se lee igual que "no hay ninguna fila marcada", que
  // es justo el PASS que este guard no puede permitirse dar por accidente.
  if (error) {
    console.log(JSON.stringify({ veredicto: 'INDETERMINADO', motivo: 'query usuarios: ' + error.message }));
    return 2;
  }

  const intrusos = (data || []).filter((u) => !FIXTURES.has(String(u.whatsapp)));

  if (intrusos.length === 0) {
    console.log(JSON.stringify({
      veredicto: 'OK', marcados: (data || []).length, fixturesDeclarados: FIXTURES.size,
    }, null, 2));
    return 0;
  }

  console.log(JSON.stringify({
    veredicto: 'FILA MARCADA SIN DECLARAR',
    queSignifica: 'Una fila con is_test_user que no es un fixture conocido. Si su `whatsapp` es un '
      + 'celular plausible, lo mas probable es que sea un usuario efimero que un harness no borro. '
      + 'Mientras exista, la persona dueña de ese numero queda MUDA si le escribe a Neto.',
    queHacer: '1) Confirmar que no es una persona real (mirar transacciones y created_at). '
      + '2) Si es basura de harness, borrar la fila. 3) Si es un fixture nuevo y legitimo, '
      + 'declararlo en FIXTURES de este archivo. NUNCA quitar el guard.',
    intrusos: intrusos.map((u) => ({
      id: u.id, whatsapp: u.whatsapp, nombre: u.nombre, plan: u.plan,
      tieneCuentaWeb: !!u.supabase_auth_id, created_at: u.created_at,
    })),
  }, null, 2));
  return 1;
}

// `process.exit()` con el cliente de Supabase abierto revienta libuv en Windows y se lleva el
// exit code (un exit(2) sale 127). Se devuelve el código y se sale por `exitCode`.
main()
  .then((c) => { process.exitCode = c; })
  .catch((e) => { console.log(JSON.stringify({ veredicto: 'INDETERMINADO', motivo: e.message })); process.exitCode = 2; });
