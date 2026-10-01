import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extraerNombreDelAlta, motivoNombreNoDicho } = require('../../lib/nombres');

/**
 * Clase 7 de "respuestas malas del día 0" (30-sep-2026). Los dos corpus de abajo son REALES:
 * los mensajes con que las 49 altas de WhatsApp del 03-ago al 30-sep respondieron "¿Cómo te
 * llamas?" (`conversaciones`, rol `neto`, "¡Listo, *…"), y el nombre que quedó guardado.
 * Los nombres reales fijan los FALSOS RECHAZOS de la guarda: si alguien agrega una palabra a
 * las listas de `lib/nombres.js` y se come un nombre de verdad, cae acá.
 */

// [lo que escribió, lo que tiene que quedar guardado]. Repetidos se dejan (Luis, Victor,
// Camila): son altas distintas.
const NOMBRES_REALES = [
  ['Sofia', 'Sofia'], ['Iván', 'Iván'], ['María Laura', 'María Laura'], ['Tatiana', 'Tatiana'],
  ['Vanessa', 'Vanessa'], ['Antony', 'Antony'], ['John', 'John'], ['Flavio', 'Flavio'],
  ['Andrés', 'Andrés'], ['José', 'José'], ['Joaquin', 'Joaquin'], ['Giancarlo', 'Giancarlo'],
  ['Danitza', 'Danitza'], ['Amorka', 'Amorka'], ['Gabriel', 'Gabriel'],
  ['Alberto Huarcaya Vilca', 'Alberto Huarcaya Vilca'],
  ['Mi nombre es Rubén Campo Verde.', 'Rubén Campo Verde'],
  ['Joseph', 'Joseph'], ['César', 'César'], ['Victor rivas', 'Victor Rivas'], ['Engels', 'Engels'],
  ['Daniel', 'Daniel'], ['Luis', 'Luis'], ['Christian', 'Christian'], ['Eli', 'Eli'], ['Jomar', 'Jomar'],
  ['Luis', 'Luis'], ['Arlly', 'Arlly'], ['Sergio', 'Sergio'], ['Giannina', 'Giannina'],
  ['JoseMiguel', 'Josemiguel'], ['Soy victor zegarra', 'Victor Zegarra'], ['Gerson', 'Gerson'],
  ['Raquel', 'Raquel'], ['Donna', 'Donna'], ['Victor', 'Victor'], ['Camilo', 'Camilo'],
  ['Fernando', 'Fernando'], ['alexis', 'Alexis'], ['Miriam', 'Miriam'], ['Camila', 'Camila'],
  ['Mila', 'Mila'], ['Juan pablo', 'Juan Pablo'], ['Jon', 'Jon'], ['camila', 'Camila'], ['Dana', 'Dana'],
];

// Las tres frases que HEAD guardó como nombre. "Debe…" es el mensaje real (llegó en ráfaga con
// un reenvío; el saludo dijo "¡Listo, *Debe*!").
const FRASES_REALES = ['Como funciona?', 'Quisiera registrarme', 'Debe estar en apuros económicos.'];

describe('alta: los 46 nombres reales se guardan igual que antes', () => {
  it('el corpus está completo (antivacuidad)', () => {
    expect(NOMBRES_REALES.length).toBe(46);
  });
  it.each(NOMBRES_REALES)('%s → %s', (msg, esperado) => {
    expect(extraerNombreDelAlta(msg)).toEqual({ nombre: esperado, motivo: null });
  });
});

describe('alta: las frases reales no se guardan', () => {
  it.each(FRASES_REALES)('%s', (msg) => {
    const r = extraerNombreDelAlta(msg);
    expect(r.nombre).toBeNull();
    expect(r.motivo).not.toBeNull();
  });
});

describe('alta: el ataque a la guarda (nombres que tienen que pasar)', () => {
  it.each([
    ['Ana María', 'Ana María'],
    ['soy Ana', 'Ana'],
    ['Me llamo Ana María', 'Ana María'],
    ['Hola, soy Ana', 'Ana'],
    ['Buenas noches, me llamo Juan Carlos', 'Juan Carlos'],
    ['Inés', 'Inés'],
    ['Ñañez', 'Ñañez'],
    ['Pepe', 'Pepe'],
    ['Chino', 'Chino'],
    ['María de los Ángeles', 'María De Los Ángeles'],
    ['Ana La Rosa', 'Ana La Rosa'],
    ['Edgar', 'Edgar'],
    ['Omar', 'Omar'],
    ['Jaime', 'Jaime'],
    ['Yaír', 'Yaír'],
    // La regex vieja no tenía ancla: el "es" de "Ines" la hacía guardar "Garcia".
    ['Ines Garcia', 'Ines Garcia'],
    ['Mercedes Lopez', 'Mercedes Lopez'],
    ['Domingo', 'Domingo'],
    ['Máximo', 'Máximo'],
    ['Giancarlo', 'Giancarlo'],
    ['Carla', 'Carla'],
    ['Soy Delia', 'Delia'],
    // Falsos rechazos que encontró la revisión adversarial (01-oct-2026)
    ['Hola Neto, soy Ana', 'Ana'],
    ['Hola neto soy Ana', 'Ana'],
    ['Holaa, soy Ana', 'Ana'],
    ['Gracias, soy Ana', 'Ana'],
    ['Un gusto, soy Ana', 'Ana'],
    ['Encantada, soy Ana', 'Ana'],
    ['Mi nombre: Ana', 'Ana'],
    ['Nombre: Ana', 'Ana'],
    ['Me llamo: Ana', 'Ana'],
    ['Me llamo Ana\nquiero registrar mis gastos', 'Ana'],
    ['Llámame Ana', 'Ana'],
    ["O'Brien", "O'brien"],
    ['Carlos Lo', 'Carlos Lo'],
    ['Jo', 'Jo'],
    ['Ng', 'Ng'],
    ['De la Cruz', 'De La Cruz'],
    ['Ana 😊', 'Ana'],
    ['Me llamo Ana y quiero registrarme', 'Ana'],
    // Segunda revisión adversarial (01-oct-2026)
    ['¡Hola! Soy Ana', 'Ana'],
    ['¡Hola! Me llamo Ana', 'Ana'],
    ['Qué tal, soy Ana', 'Ana'],
    // el apóstrofo curvo de iOS ya no parte el nombre en "o" + "brien"; se guarda como se escribió
    ["O’Brien", "O’brien"],
    ['Ana ❤️', 'Ana'],
    ['Ana 👋🏽', 'Ana'],
    ['Ana 🇵🇪', 'Ana'],
    ['De los Santos', 'De Los Santos'],
    ['Soy Ana, quiero registrarme', 'Ana'],
  ])('%s → %s', (msg, esperado) => {
    expect(extraerNombreDelAlta(msg).nombre).toBe(esperado);
  });
});

describe('alta: el ataque a la guarda (frases que no tienen que pasar)', () => {
  it.each([
    'Cómo funciona',
    '¿Qué es esto?',
    'Quiero registrar mis gastos',
    'Para qué sirve',
    'Hola',
    'Buenas noches',
    'Gracias',
    'Registrarme',
    'Le enviamos el apoyo y luego lo podemos visitar.',
    'Esto lo quiero usar para mi negocio',
    'Necesito ayuda',
    'Mi esposo y yo',
    'ana@gmail.com',
    'https://neto.pe',
    // Sin ancla, el "soy" a mitad de frase se volvía nombre.
    'Debe estar en apuros, soy pobre',
    // Pasaban en el primer ataque (01-oct-2026) y se agregaron a las listas.
    'Soy de Lima', 'Soy nuevo', 'Hola soy nuevo', 'Soy yo', 'Listo', 'Precio', 'Bueno',
    'Empecemos', 'Registrame', 'Prueba', 'Máximo el sábado', 'Vía yape o plin.',
    // Pasaban en la revisión adversarial (01-oct-2026)
    'Holaa, soy', 'Holaa', 'Holis', 'Ola', 'Saludos', 'Jajaja', 'Xd',
    'Soy la dueña', 'Soy profesora', 'Soy mamá', 'Mi nombre es secreto', 'Vengo de TikTok',
    'Crear cuenta', 'Menu', 'Gratis', 'Okk', 'Nadie',
    // Lo que el recorte de cortesía NO puede dejar al descubierto
    'Dale vamos', 'Que sea pronto.', 'Ok gracias', 'Ana, y tú?',
    // Matan mutaciones que sobrevivían: sin INFINITIVO_CLITICO, sin el chequeo de "?", y con
    // MAX_PALABRAS de 50 (siete palabras sin ninguna funcional).
    'Inscribirme', 'Mariela?', 'Juan Carlos Pedro Luis Miguel Ángel Rosa',
    // Matan las mutaciones vivas de la segunda batería (01-oct-2026): saludo de chat después del
    // nombre, teclazos, cortesía sin puntuación que deja al descubierto el resto, una
    // presentación a mitad de frase (sin ancla), y nombre + ciudad con coma.
    'Ana holaa', 'Hmm', 'Aaa', 'Bueno pues', 'Ayer le dije que soy Carlos', 'Carlos, Lima',
    // Segunda revisión (01-oct-2026): la cortesía solo se quita delante de una presentación, así
    // que "Ok, entendido" va entero. El costo, elegido: "Ok, Ana" y "Ana, gracias" repreguntan.
    'Ok, entendido', 'Excelente, gracias', 'Hola buenos días, disculpe la hora', 'Hola, consulta rápida',
    'Gracias! Excelente servicio', 'Listo, siguiente paso', 'Buenas tardes, disculpe',
    'Ok, Ana', 'Ana, gracias', 'Mucho gusto, Ana',
    'De acuerdo', 'Ok, de acuerdo', 'De nada', 'Del Callao',
    'Yo soy la dueña', 'Yo soy de Lima', 'Soy del Callao', 'Me dicen la flaca', 'Mi nombre de usuario',
    'Ana jajaja', 'Ahh', 'Uff', 'Ajá', 'Okis', 'A ver', 'Igual',
    // Tercera revisión (01-oct-2026): una pregunta con presentación adentro, el "?" se perdía al
    // cortar. Desde ahí, cualquier "?" repregunta, también con un nombre real delante (costo).
    '¿Qué nombre pongo?', 'Que nombre quieres?', 'Si, nombre completo?', 'Nombre y apellido?',
    'Nombre completo?', 'Mi nombre completo?', 'Nombre real?',
    'Que nombre bonito tienes', 'Un nombre falso', 'Que soy tonto',
    'Hola, qué tal? Soy Ana', 'Me llamo Ana. ¿Cómo funciona?',
    // descripciones de varias palabras después de la presentación
    'Soy Ana la de ventas', 'Soy Juan el de la bodega', 'Soy Ana mamá de dos',
    'Soy Rosa emprendedora', 'Soy Luis estudiante', 'Soy Pedro desde Arequipa',
    // cortesía sin coma: matan sacar "mucho" o "gracias" de las listas
    'Mucho gusto', 'Mucho gusto!', 'Ana gracias', 'Soy Ana gracias',
    'Llámame mañana', 'Mi nombre es raro', 'Ana pe', 'Soy Ana nomás',
    // matan: "nombre" sin dos puntos como presentación, y "que" de vuelta en la cortesía
    'Nombre falso', 'Que soy capaz',
  ])('%s', (msg) => {
    expect(extraerNombreDelAlta(msg).nombre).toBeNull();
  });
});

describe('renombre: el nombre tiene que estar escrito y pedido', () => {
  it.each([
    // [nombre del modelo, mensaje] reales de producción que HEAD guardó
    ['Nvf', 'Esto lo quiero usar para mi negocio de consultoría. Lo podemos personalizar?'],
    ['Nvf', 'Mis categorías de gastos son de empresa'],
    ['Hola', 'hola, puedes cambiarme de nombre?'],
    ['Lkm.84', 'lkm.84'],
    // ataques: escrito pero no pedido, escrito adentro de otra palabra
    ['Negocio', 'Esto lo quiero usar para mi negocio'],
    ['Ana', 'gasté 20 esta semana'],
    ['Ana', 'cuánto gasté en la semana'],
    // Revisión adversarial (01-oct-2026): pedía el cambio sin dar el nombre, o el nombre estaba
    // escrito sin que se lo pidiera
    ['Holaa', 'holaa, puedes cambiarme de nombre?'],
    ['Oye', 'oye, cámbiame el nombre'],
    ['Causa', 'causa, cámbiame el nombre'],
    ['Nombre', 'cambia mi nombre'],
    ['Cambia', 'cambia mi nombre'],
    ['Mal', 'me llamaste mal'],
    ['Disculpa', 'disculpa, me llamaste mal'],
    ['Distinto', 'llámame distinto'],
    ['Juan', 'dime cuánto le debo a Juan'],
    ['Wong', 'dime cuánto gasté en Wong'],
    ['Pedro', 'recuérdame llamar a Pedro'],
    ['Luis', 'mi hijo se llama Luis'],
    ['Juan', 'no me llamo Juan'],
    ['Ana', 'no me llames Ana'],
    ['Ana', 'prefiero que no me digas Ana'],
    ['Viaje', 'el nombre de mi meta es Viaje'],
    ['Casa', 'quiero cambiar el nombre de mi meta a Casa'],
    ['Familia', 'cambia el nombre de mi espacio a Familia'],
    ['Viaje Cusco', 'renombra mi meta, ponle de nombre Viaje Cusco'],
    // Matan la comparación por subcadena: "ana" está adentro de "mariana" y de "anabel"
    ['Ana', 'llámame Mariana'],
    ['Ana', 'dime Anabel'],
    // Segunda revisión (01-oct-2026): negaciones que no van pegadas, y disparadores ambiguos
    ['Ana', 'nunca me llames Ana'],
    ['Ana', 'jamás me digas Ana'],
    ['Ana', 'no quiero que me llames Ana'],
    ['Ana', 'ya no quiero que me digas Ana'],
    ['Ana', 'odio que me digas Ana'],
    ['Ana', 'deja de llamarme Ana'],
    ['Ana', 'no vuelvas a llamarme Ana'],
    ['Ana', 'por qué me llamas Ana?'],
    ['Ana', 'no soy Ana'],
    ['Spotify', 'ponme Spotify'],
    ['Casa', 'cámbiale el nombre a Casa'],
    ['Viaje', 'cambia el nombre a Viaje'],
    ['Jajaja', 'jajaja'],
    ['Juan', 'mi nombre es Juan pero no lo cambies'],
    // Tercera revisión (01-oct-2026): otra cláusula niega o cambia de tema, o es una pregunta
    ['Juan', 'mi nombre es Juan, no lo cambies'],
    ['Ana', 'llámame Ana. Es broma'],
    ['Ana', 'llámame Ana! no, mejor no'],
    ['Pedro', 'llámame Pedro. No, mejor Juan'],
    ['Ana', 'si fuera mujer, me llamo Ana'],
    ['Pro', '¿soy Pro?'],
    ['Ana', 'me llamo Ana? jaja'],
    ['Carlos', 'Dime Carlos, cuánto gasté'],
    ['Resumen', 'dime resumen'],
    ['Mañana', 'llámame mañana'],
    ['La Atención', 'me llamó la atención'],
    ['Ana Plis', 'llámame Ana plis'],
    // el nombre del modelo es el comienzo de otra palabra, y el resto es una palabra de cortesía
    ['Lu', 'llámame Lupe'],
  ])('%s ← "%s" se descarta', (nombre, msg) => {
    expect(motivoNombreNoDicho(nombre, msg)).not.toBeNull();
  });

  it.each([
    ['Annie', 'soy Annie'],
    ['Annie', 'Annie'],
    ['Ana', 'llámame Ana'],
    ['Ana María', 'Llamame Ana María'],
    ['María', 'me llamo maria'],
    ['José', 'mi nombre es Jose'],
    ['Pepe', 'dime Pepe'],
    ['Juan', 'cámbiame el nombre a Juan'],
    ['Jose Luis Cordero Araujo', 'Me llamo JOSE LUIS CORDERO ARAUJO'],
    ['Ana', 'me dicen Ana'],
    ['Ana', 'me puedes decir Ana'],
    ['Ana', 'call me Ana'],
    ['Ana', 'my name is Ana'],
    ['Pedro', 'no me llamo Juan, me llamo Pedro'],
    ['Ana', 'llámame Ana por favor'],
    ['Ana', 'Me puedes llamar Ana'],
    ['Ana', 'quiero que me llames Ana'],
    ['Ana', 'prefiero que me digas Ana'],
    ['Ana', 'mi nombre real es Ana'],
    ['Ana', 'actualiza mi nombre: Ana'],
    ['Ana', 'Hola, ¿me puedes llamar Ana?'],
    // Segunda revisión: la corrección más natural lleva un "No," delante
    ['Pedro', 'No, me llamo Pedro'],
    ['Pedro', 'no, soy Pedro'],
    ['Pedro', 'No, llámame Pedro'],
    ['Pedro', 'no no, me llamo Pedro'],
    ['Ana', "llámame 'Ana'"],
    ["O'Brien", 'call me O’Brien'],
    ['Ana', 'quisiera que me llamaras Ana'],
    ['Juan', 'cambia mi nombre a Juan'],
    // Tercera revisión: pedidos legítimos que la forma de cláusula rechazaba
    ['Ana', 'hola neto llámame Ana'],
    ['Ana', 'llámame Ana porfavor'],
    ['Ana', 'llámame Ana xfa'],
    ['Ana', 'llámame Ana pe'],
    ['Ana', 'dime Ana nomás'],
    ['Ana', 'desde ahora llámame Ana'],
    ['Ana', 'a partir de hoy llámame Ana'],
    ['Ana', 'llámame Ana de ahora en adelante'],
    ['Ana', 'me gustaría que me llames Ana'],
    ['Ana', 'solo dime Ana'],
    ['Ana', 'Sí, llámame Ana. Gracias'],
    // Mata la comparación sin normalizar: el mensaje ES el nombre, con otra caja y sin tildes
    ['Ana María', 'ana maria'],
  ])('%s ← "%s" se acepta', (nombre, msg) => {
    expect(motivoNombreNoDicho(nombre, msg)).toBeNull();
  });
});
