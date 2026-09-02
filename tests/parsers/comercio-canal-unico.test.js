import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * EL COMERCIO SE ESCRIBE IGUAL VENGA POR DONDE VENGA.
 *
 * El arreglo del prefijo de pasarela toca DOS puntos —`parsearCorreoBancario` (correo) y
 * `guardarTransaccion` (captura de pantalla, registro manual, import Excel)— y su valor entero
 * depende de que los dos lleguen al MISMO string: `buscarReglaComercio` compara por igualdad
 * exacta en minúsculas, así que dos canales que escriban distinto dejan la regla del usuario
 * sin efecto según por dónde entró el gasto. Es el defecto original con otra ropa.
 *
 * Este archivo existe porque una revisión adversarial mostró que los tests unitarios no podían
 * verlo: llamaban a `canonizarComercio` directo, nunca a través de la cadena real, y no tocaban
 * `services/transactions.js` ni una línea. Con una mutación de cuatro palabras en
 * `normalizarComercio` los 36 tests seguían en verde y los dos canales divergían.
 */

const capturado = { insert: null, reglaPedida: null, upsert: null };

// Chain permisiva: cualquier cadena de filtros resuelve a vacío. Sólo interesan dos cosas —
// qué `comercio` se le pide a la tabla de reglas y qué `comercio` termina en el insert.
function chain(tabla) {
  const self = {
    select: () => self, eq: (col, val) => { if (tabla === 'reglas_comercio' && col === 'comercio_pattern') capturado.reglaPedida = val; return self; },
    gte: () => self, limit: () => self, order: () => self, range: () => self, not: () => self,
    single: () => Promise.resolve({ data: capturado.insert, error: capturado.insert ? null : { code: 'PGRST116' } }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    insert: (fila) => { capturado.insert = { ...fila }; return self; },
    upsert: (fila) => { capturado.upsert = { ...fila }; return Promise.resolve({ data: null, error: null }); },
    update: () => self, delete: () => self,
    then: (res) => res({ data: [], error: null, count: 0 }),
  };
  return self;
}

require('../../lib/db').supabase.from = vi.fn(chain);

const { guardarTransaccion } = require('../../services/transactions');
const { parsearCorreoBancario } = require('../../services/parsers');
const mockCreate = globalThis.__mockOpenAICreate;

const USUARIO = '00000000-0000-4000-8000-000000000001';

async function porCaptura(comercioCrudo) {
  capturado.insert = null; capturado.reglaPedida = null;
  await guardarTransaccion(USUARIO, {
    tipo: 'gasto', monto: 97, moneda: 'PEN', comercio: comercioCrudo,
    categoria: 'Alimentación', subcategoria: 'snacks', fecha: '2026-08-23',
    // esGmail salta el dedup y el conteo de activación: acá sólo interesa el nombre.
    esGmail: true,
  });
  return capturado;
}

async function porCorreo(comercioQueDevuelveElModelo, textoDelCorreo) {
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({
      tipo: 'gasto', monto: 97, moneda: 'PEN', comercio: comercioQueDevuelveElModelo,
      categoria: 'Alimentación', subcategoria: 'snacks', banco: 'BCP',
      metodo_pago: 'Credito', fecha: '2026-08-23', descripcion_original: 'consumo',
    }) } }],
  });
  const r = await parsearCorreoBancario(textoDelCorreo, 'Consumo con tu Tarjeta BCP');
  return r.comercio;
}

const CORREO = (m) => 'Hola Favio Alejandro, Realizaste un consumo de S/ 97.00 con tu Tarjeta ' +
  'de Crédito BCP en ' + m + '. Por tu seguridad, te enviamos los datos de tu operación. ' +
  'Tarjeta terminada en 4821 Monto S/ 97.00';

describe('el mismo comercio crudo cae en la misma grafía por los dos canales', () => {
  beforeEach(() => { mockCreate.mockReset(); });

  // Las tres formas en que el modelo devolvía "IZI*BARBANEGRA", más el string crudo que llega
  // por una captura de pantalla. Los cuatro tienen que terminar en lo mismo.
  it('correo y captura escriben el mismo nombre', async () => {
    const delCorreo = [];
    for (const forma of ['IZI', 'IZI*BARBANEGRA', 'IZI BARBANEGRA', 'IZI* Barbanegra']) {
      delCorreo.push(await porCorreo(forma, CORREO('IZI*BARBANEGRA')));
    }
    const { insert } = await porCaptura('IZI*BARBANEGRA');
    const todas = new Set([...delCorreo, insert.comercio].map(x => x.toLowerCase()));
    expect([...todas]).toEqual(['barbanegra']);
  });

  it('lo mismo con un prefijo de dos letras, que es el que más fácil se escapa', async () => {
    const delCorreo = await porCorreo('VN ESTACION SUR', CORREO('VN*ESTACION SUR'));
    const { insert } = await porCaptura('VN*ESTACION SUR');
    expect(delCorreo.toLowerCase()).toBe(insert.comercio.toLowerCase());
    expect(insert.comercio).toBe('ESTACION SUR');
  });

  it('la regla del usuario se busca por el nombre ya canónico', async () => {
    // Si acá se pidiera "izi*barbanegra", la regla que el usuario corrigió sobre una fila
    // canónica nunca dispararía — que es exactamente el síntoma reportado.
    const { reglaPedida } = await porCaptura('IZI*BARBANEGRA');
    expect(reglaPedida).toBe('barbanegra');
  });

  it('un comercio que NO es de pasarela pasa igual por los dos', async () => {
    const delCorreo = await porCorreo('Plaza Vea', 'Consumo en SPSA PLAZA VEA por S/ 45.50');
    const { insert } = await porCaptura('Plaza Vea');
    expect(delCorreo).toBe('Plaza Vea');
    expect(insert.comercio).toBe('Plaza Vea');
  });

  it('la pasarela cobrándose a sí misma NO pierde su nombre por ningún canal', async () => {
    // "NIUBIZ PERU" es un gasto real de los usuarios que son negocio (la comisión del POS).
    // Con el separador de espacio pelando siempre, quedaba en "PERU" y se fusionaba con
    // "IZIPAY PERU" y "DLOCAL PERU" en un solo comercio inventado.
    const delCorreo = await porCorreo('NIUBIZ PERU', 'Cargo de NIUBIZ PERU SAC por S/ 35.00 comision mensual');
    const { insert } = await porCaptura('NIUBIZ PERU');
    expect(delCorreo).toBe('NIUBIZ PERU');
    expect(insert.comercio).toBe('NIUBIZ PERU');
  });
});

describe('el asterisco del modelo también alcanza, si el correo lo perdió', () => {
  beforeEach(() => { mockCreate.mockReset(); });

  it('pela igual cuando el texto del correo ya no trae la forma PASARELA*COMERCIO', async () => {
    // El strip de tags de `extraerTexto` puede dejar "IZI BARBANEGRA" si el banco parte el
    // nombre en dos elementos HTML. Ahí el rescate no encuentra nada y lo único que queda es
    // el asterisco de la respuesta del modelo. Este caso es el que separa a `canonizarComercio`
    // de ser redundante con el rescate: sin él, un `normalizarComercio` que borre asteriscos
    // deja el prefijo puesto y el gasto se guarda como "IZI BARBANEGRA".
    const r = await porCorreo('IZI*BARBANEGRA', 'Consumo de S/ 97.00 con tu tarjeta BCP en IZI BARBANEGRA. Gracias.');
    expect(r).toBe('BARBANEGRA');
  });
});

describe('el override del correo no puede traer OTRO comercio', () => {
  beforeEach(() => { mockCreate.mockReset(); });

  it('un correo que menciona dos pasarelas no pisa la que cobró', async () => {
    // El defecto más grave de la segunda revisión adversarial, y lo introdujo el propio
    // arreglo: al buscar en el texto sin atarse a la pasarela del modelo, un correo con un
    // cargo de NIUBIZ y una mención de un consumo anterior en IZI guardaba "BARBANEGRA".
    // No es un nombre feo: es un gasto atribuido a un negocio que no lo cobró.
    const r = await porCorreo('NIUBIZ PERU',
      'Cargo de NIUBIZ PERU por S/ 35.00 comision mensual del POS. ' +
      'Tu consumo anterior fue en IZI*BARBANEGRA. Gracias.');
    expect(r).toBe('NIUBIZ PERU');
  });

  it('tampoco pisa cuando el nombre del correo es otro comercio de la MISMA pasarela', async () => {
    // Si el modelo trajo un nombre, sólo se lo reemplaza por el mismo comercio escrito de otra
    // forma. Acá el correo menciona un IZI distinto del que el modelo leyó: manda el modelo.
    const r = await porCorreo('IZI CARPPONE BARBERIA',
      'Consumo en IZI*OTRA TIENDA por S/ 20.00. Tarjeta terminada en 4821');
    expect(r).toBe('IZI CARPPONE BARBERIA');
  });

  it('sí lo reemplaza cuando es el mismo comercio recortado por el banco', async () => {
    // BCP corta el nombre a 23 caracteres, así que la grafía del modelo y la del correo
    // pueden diferir por el final sin dejar de ser el mismo local.
    const r = await porCorreo('IZI SERVICIOS PSICOLOG',
      'Consumo en IZI*SERVICIOS PSICOLOGICOS. Tarjeta terminada en 4821');
    expect(r).toBe('SERVICIOS PSICOLOGICOS');
  });
});

describe('la regla que crea el BACKEND también usa el patrón canónico', () => {
  it('guardarReglaComercio canoniza lo que tipeó la persona', async () => {
    // Dos de sus tres call-sites le pasan texto del usuario ("todo lo de X va en Y", o el
    // nombre en una corrección), no la fila guardada. Quien copia el nombre tal como lo ve en
    // la app de su banco escribe "IZI*BARBANEGRA", y esa regla nacía muerta: el runtime ya no
    // guarda esa forma, así que `buscarReglaComercio` —igualdad exacta— no la encuentra nunca.
    capturado.upsert = null;
    const { guardarReglaComercio } = require('../../services/transactions');
    await guardarReglaComercio(USUARIO, 'IZI*BARBANEGRA', 'Alimentación', 'restaurante');
    expect(capturado.upsert.comercio_pattern).toBe('barbanegra');
  });
});

describe('cuándo el correo puede pisar al modelo, y cuándo no', () => {
  beforeEach(() => { mockCreate.mockReset(); });

  // Los seis casos de abajo salieron de tres revisiones adversariales, medidos uno por uno.
  // La regla que los une: ante la duda NO se reemplaza. Quedarse con el nombre del modelo
  // arrastra como mucho el prefijo; reemplazar mal atribuye el gasto a otro negocio.

  it('dos sucursales numeradas no son el mismo local', async () => {
    // "GRIFO PRIMAX 1" y "GRIFO PRIMAX 12": una clave es prefijo de la otra en las DOS
    // direcciones. Sin la guarda de largo se daban por el mismo comercio.
    expect(await porCorreo('IZI*GRIFO PRIMAX 1', 'Consumo en IZI*GRIFO PRIMAX 12. Tarjeta'))
      .toBe('GRIFO PRIMAX 1');
    expect(await porCorreo('IZI*GRIFO PRIMAX 12', 'Consumo en IZI*GRIFO PRIMAX 1. Tarjeta'))
      .toBe('GRIFO PRIMAX 12');
  });

  it('un nombre corto no autoriza a quedarse con cualquier candidato que empiece igual', async () => {
    // Con "EL" o "MERCADO" el prefijo matchea medio mundo. Sólo un nombre largo como para
    // venir recortado por el banco (23 caracteres) puede aceptar un candidato que lo extienda.
    expect(await porCorreo('IZI*EL', 'Consumo en IZI*EL AGUAJAL. Tarjeta')).toBe('EL');
    expect(await porCorreo('IZI*MERCADO', 'Consumo en IZI*SUPERMERCADO SAN JOSE por S/ 20.00'))
      .toBe('MERCADO');
  });

  it('sí acepta el candidato que extiende cuando el recorte del banco es plausible', async () => {
    // "IZI SERVICIOS PSICOLOG" mide 22: es la firma del corte a 23 caracteres de BCP.
    expect(await porCorreo('IZI SERVICIOS PSICOLOG', 'Consumo en IZI*SERVICIOS PSICOLOGICOS. Tarjeta'))
      .toBe('SERVICIOS PSICOLOGICOS');
  });

  it('el fragmento cortado del correo no pisa el nombre entero del modelo', async () => {
    // El corte por puntuación deja prefijos ("REST." → "REST"), y un prefijo del correo no
    // puede ganarle al nombre completo que trajo el modelo.
    expect(await porCorreo('IZI*RESTAURANT EL PARAISO', 'Consumo en IZI*REST. EL PARAISO. Tarjeta'))
      .toBe('RESTAURANT EL PARAISO');
    expect(await porCorreo('IZI*TIENDA SURCO', 'Consumo en IZI*TIENDA (SURCO). Tarjeta'))
      .toBe('TIENDA SURCO');
  });

  it('reconoce la misma pasarela nombrada de dos formas', async () => {
    // IZI/IZIPAY y MPAGO/MERCADOPAGO son la misma empresa, y el modelo devuelve cualquiera de
    // las dos. Atar la búsqueda a la pasarela del modelo perdía estos rescates y guardaba el
    // prefijo puesto, o sea la grafía del bug original.
    expect(await porCorreo('IZI BARBANEGRA', 'Consumo en IZIPAY*BARBANEGRA. Tarjeta')).toBe('BARBANEGRA');
    expect(await porCorreo('MPAGO TIENDA FELIZ', 'Consumo en MERCADOPAGO*TIENDA FELIZ. Tarjeta'))
      .toBe('TIENDA FELIZ');
  });

  it('con el modelo mudo y DOS comercios en el correo, no elige', async () => {
    // Sin nombre del modelo no hay con qué desempatar. Se prefiere el nombre pobre ("IZI") a
    // uno inventado. Si el correo repite el MISMO comercio, sí lo toma.
    expect(await porCorreo('IZI', 'Consumo en IZI*TIENDA VIEJA y en IZI*BARBANEGRA. Tarjeta')).toBe('IZI');
    expect(await porCorreo('IZI', 'Consumo en IZI*BARBANEGRA. Empresa IZI*BARBANEGRA Tarjeta 4821'))
      .toBe('BARBANEGRA');
  });

  it('extender por el FINAL no es lo mismo que contener en el medio', async () => {
    // Con un nombre largo (>=22, o sea recorte plausible) la contención sí se evalúa, y ahí
    // `includes` en vez de `startsWith` vuelve a traer otro comercio: "MERCADO CENTRAL DE
    // LIMA" está adentro de "SUPERMERCADO CENTRAL DE LIMA" sin ser el mismo local. El banco
    // recorta por el FINAL, nunca por el principio: por eso la dirección importa.
    expect(await porCorreo('IZI*MERCADO CENTRAL DE LIMA',
      'Consumo en IZI*SUPERMERCADO CENTRAL DE LIMA. Tarjeta')).toBe('MERCADO CENTRAL DE LIMA');
  });

  it('el largo del prefijo no cambia si el nombre parece recortado', async () => {
    // El umbral se medía sobre el string CON prefijo y era un piso, así que el MISMO nombre de
    // 14 caracteres pasaba o no según qué pasarela lo antecediera: con "PAGOEFECTIVO*" el total
    // llegaba a 27 y la guarda se abría. Es una BANDA, no un piso: un string más largo que el
    // corte del banco PRUEBA que el banco no cortó, porque si hubiera cortado mediría 23.
    const CORREO = 'Consumo en IZI*GRIFO PRIMAX 12. Tarjeta terminada en 4821';
    for (const modelo of ['IZI*GRIFO PRIMAX 1', 'NIUBIZ*GRIFO PRIMAX 1',
      'MERCADOPAGO*GRIFO PRIMAX 1', 'PAGOEFECTIVO*GRIFO PRIMAX 1']) {
      expect(await porCorreo(modelo, CORREO)).toBe('GRIFO PRIMAX 1');
    }
  });

  it('con el modelo mudo, el cargo bajo OTRO nombre de la misma pasarela también cuenta', async () => {
    // La búsqueda estaba atada a la pasarela que dijo el modelo, y en el caso degenerado ése es
    // su único dato, o sea el menos confiable. El `` impide que IZI matchee dentro de IZIPAY,
    // así que se veía un candidato solo —el consumo viejo—, la guarda de ambigüedad no se
    // enteraba, y se guardaba el comercio que NO cobró.
    expect(await porCorreo('IZI',
      'Realizaste un consumo en IZIPAY*BARBANEGRA. Tu consumo anterior fue en IZI*TIENDA VIEJA. Tarjeta'))
      .toBe('IZI');
  });

  it('ningún criterio de desempate: repetirse más no gana', async () => {
    // "gana el que se repite más" suena razonable (BCP nombra el comercio del cargo dos veces),
    // deja los otros tests en verde, y guarda el consumo viejo cuando el cargo se nombra una vez
    // y la mención dos. Y hay una segunda mitad: la captura no puede tragarse la mención
    // siguiente, o el tercer comercio no se ve y los dos candidatos que quedan son iguales.
    expect(await porCorreo('IZI',
      'Consumo en IZI*TIENDA VIEJA. Empresa IZI*TIENDA VIEJA. Antes IZI*BARBANEGRA. Tarjeta'))
      .toBe('IZI');
  });

  it('el monto en soles corta el nombre', async () => {
    // Las tres alternativas de moneda llevaban `\b` al final y no cortaban NUNCA: después de
    // "/" o "$" viene un espacio, y dos caracteres no-palabra seguidos no forman borde.
    expect(await porCorreo('IZI', 'Consumo en IZI*BODEGA LUCHO S/ 20.00 hoy')).toBe('BODEGA LUCHO');
    expect(await porCorreo('IZI', 'Consumo en IZI*BODEGA LUCHO US$ 5.00 hoy')).toBe('BODEGA LUCHO');
  });
});

describe('la guarda que cierra la clase entera', () => {
  beforeEach(() => { mockCreate.mockReset(); });

  it('con DOS comercios en el correo no se reemplaza nada, tenga o no nombre el modelo', async () => {
    // Tres revisiones adversariales encontraron el mismo defecto con distinta ropa: "el correo
    // tenía otra mención y el matcher se quedó con ésa". Perseguirlos de a uno tapaba el caso
    // medido y dejaba el siguiente abierto. La guarda es global: si el correo nombra dos
    // comercios distintos, manda el modelo.
    const DOS = 'Consumo en IZI*BARBANEGRA. Tu consumo anterior fue en IZI*TIENDA VIEJA. Tarjeta';
    expect(await porCorreo('IZI', DOS)).toBe('IZI');
    expect(await porCorreo('IZI CARPPONE BARBERIA', DOS)).toBe('IZI CARPPONE BARBERIA');
    expect(await porCorreo('IZI SERVICIOS PSICOLOG', DOS)).toBe('IZI SERVICIOS PSICOLOG');
    // Y con la forma con asterisco no cuesta nada: el nombre ya sale canónico igual.
    expect(await porCorreo('IZI*BARBANEGRA', DOS)).toBe('BARBANEGRA');
  });

  it('el mismo comercio nombrado dos veces NO es ambiguo', async () => {
    // BCP lo pone en la frase y otra vez en el campo "Empresa". Las dos menciones dan la misma
    // clave, así que el rescate sigue funcionando en el correo real.
    expect(await porCorreo('IZI',
      'Realizaste un consumo en IZI*BARBANEGRA. Empresa IZI*BARBANEGRA Tarjeta terminada en 4821'))
      .toBe('BARBANEGRA');
  });
});
