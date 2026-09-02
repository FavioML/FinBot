import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  canonizarComercio,
  esPasarelaSola,
  extraerComercioPasarela,
  parsearCorreoBancario,
} = require('../../services/parsers');

const mockCreate = globalThis.__mockOpenAICreate;

/**
 * EL PREFIJO DE PASARELA SE COME AL COMERCIO.
 *
 * Reportado por Favio el 02-sep-2026 sobre un correo real de BCP: "IZI*BARBANEGRA" llegaba a
 * Neto como "IZI". Medido en producción el mismo día, el campo salía en TRES grafías distintas
 * para el mismo IZI ("IZI CARPPONE BARBERIA", "IZI*PLAZA DEL SOL", "IZI"), porque lo decide
 * entero un LLM al que el prompt le pedía dos cosas incompatibles a la vez: "quitar asteriscos"
 * y "nombre limpio sin códigos".
 *
 * Lo que hace daño no es la fealdad del nombre: `buscarReglaComercio` compara por IGUALDAD
 * exacta en minúsculas y el detector de recurrentes agrupa por `comercio.toLowerCase()`, así
 * que con la grafía bailando la corrección manual del usuario no se pega y un mismo local se
 * parte en dos grupos. Verificado en prod: 7 visitas a la misma barbería, S/60 cada una,
 * repartidas entre "IZI CARPPONE BARBERIA" y "Carppone Barberia".
 */

describe('esPasarelaSola', () => {
  it('reconoce el caso degenerado: sólo el prefijo', () => {
    expect(esPasarelaSola('IZI')).toBe(true);
    expect(esPasarelaSola('izi')).toBe(true);
    expect(esPasarelaSola('IZI*')).toBe(true);
    expect(esPasarelaSola(' NIUBIZ ')).toBe(true);
  });

  it('NO marca un comercio que apenas empieza con el prefijo', () => {
    expect(esPasarelaSola('IZI*BARBANEGRA')).toBe(false);
    expect(esPasarelaSola('IZI CARPPONE BARBERIA')).toBe(false);
    // Un comercio real cuyo nombre arranca con las mismas letras no es la pasarela.
    expect(esPasarelaSola('IZIPAYASO')).toBe(false);
  });

  it('no se cae con vacíos', () => {
    expect(esPasarelaSola(null)).toBe(false);
    expect(esPasarelaSola('')).toBe(false);
  });
});

describe('canonizarComercio', () => {
  it('pela el prefijo cuando el asterisco lo delata', () => {
    expect(canonizarComercio('IZI*BARBANEGRA')).toBe('BARBANEGRA');
    expect(canonizarComercio('IZI* Barbanegra')).toBe('Barbanegra');
    expect(canonizarComercio('IZI *BARBANEGRA')).toBe('BARBANEGRA');
  });

  it('NO pela por espacio sin que se lo pidan, aunque el token esté en la lista', () => {
    // El asterisco es la evidencia de que el token es prefijo. Sin él no se puede saber, y
    // pelar de más fusiona comercios distintos en uno: "NIUBIZ PERU", "IZIPAY SA" y
    // "DLOCAL PERU" caían todos en "PERU" cuando el espacio pelaba siempre. Es un gasto real
    // de los usuarios que son negocio: la pasarela cobrándoles su propio servicio.
    expect(canonizarComercio('NIUBIZ PERU')).toBe('NIUBIZ PERU');
    expect(canonizarComercio('IZIPAY SA')).toBe('IZIPAY SA');
    expect(canonizarComercio('DLC MOTORS')).toBe('DLC MOTORS');
    expect(canonizarComercio('IZI CARPPONE BARBERIA')).toBe('IZI CARPPONE BARBERIA');
  });

  it('pela por espacio sólo cuando el llamador declara que tiene la evidencia', () => {
    // La piden los dos que la tienen: el parser de correos (ve el "IZI*" en el texto) y el
    // backfill (sus 39 filas se revisaron a mano).
    const conEvidencia = { separadorEspacio: true };
    expect(canonizarComercio('IZI CARPPONE BARBERIA', conEvidencia)).toBe('CARPPONE BARBERIA');
    expect(canonizarComercio('Openpay Don Melchor Polim', conEvidencia)).toBe('Don Melchor Polim');
  });

  it('el caso degenerado tiene UNA sola forma, no seis', () => {
    // Devolverlo verbatim dejaba "IZI", "IZI*" y "IZI *" como tres grafías distintas del
    // mismo caso: el bug original sobreviviendo adentro de su propio arreglo.
    const formas = ['IZI', 'IZI*', 'IZI *', 'IZI**', 'izi*', 'IZI  '];
    const salidas = new Set(formas.map(f => canonizarComercio(f).toUpperCase()));
    expect([...salidas]).toEqual(['IZI']);
  });

  it('cubre las otras pasarelas peruanas y regionales', () => {
    expect(canonizarComercio('NIUBIZ*VETERINARIA SAN')).toBe('VETERINARIA SAN');
    expect(canonizarComercio('OPENPAY*Don Melchor Polim')).toBe('Don Melchor Polim');
    expect(canonizarComercio('DLC*PEDIDOSYA')).toBe('PEDIDOSYA');
    expect(canonizarComercio('MPO*SPOTIFY')).toBe('SPOTIFY');
  });

  it('pela el prefijo de DOS tokens de Culqi', () => {
    // Salió de mirar las filas reales, no de leer la sintaxis: Culqi manda "CULQI QR*<comercio>".
    // Pelando sólo "CULQI" quedaba "Qr*lenon", y "CULQI QR" a secas quedaba en "QR", que es peor
    // que el original — un prefijo a medio pelar es una CUARTA grafía, no un arreglo.
    expect(canonizarComercio('Culqi Qr*lenon')).toBe('lenon');
    expect(canonizarComercio('Culqi*Multitienda Carmen')).toBe('Multitienda Carmen');
    expect(canonizarComercio('CULQI QR')).toBe('CULQI');
    expect(canonizarComercio('CULQI QR*')).toBe('CULQI');
    expect(esPasarelaSola('CULQI QR')).toBe(true);
  });

  it('acepta prefijos cortos con asterisco', () => {
    expect(canonizarComercio('VN*ESTACION')).toBe('ESTACION');
  });

  it('NO pela un prefijo que sí es el comercio', () => {
    // La lista es cerrada a propósito: acá la primera mitad es la marca y pelarla
    // perdería justo la información que este arreglo viene a conservar.
    expect(canonizarComercio('APPLE*ICLOUD')).toBe('APPLE*ICLOUD');
    expect(canonizarComercio('AMZN*MKTPLACE')).toBe('AMZN*MKTPLACE');
  });

  it('devuelve el prefijo solo tal cual en vez de vaciar el campo', () => {
    // Pelarlo dejaría el comercio vacío. Un nombre pobre es recuperable; uno vacío rompe.
    // El rescate de este caso vive en el parser, que sí tiene el correo a mano.
    expect(canonizarComercio('IZI')).toBe('IZI');
  });

  it('deja en paz un comercio normal', () => {
    expect(canonizarComercio('Plaza Vea')).toBe('Plaza Vea');
    expect(canonizarComercio('Cineplanet Alcazar Tote')).toBe('Cineplanet Alcazar Tote');
    expect(canonizarComercio('  Netflix  ')).toBe('Netflix');
  });

  it('es idempotente', () => {
    const una = canonizarComercio('IZI*BARBANEGRA');
    expect(canonizarComercio(una)).toBe(una);
  });

  it('no se cae con entradas que no son string', () => {
    expect(canonizarComercio(null)).toBe(null);
    expect(canonizarComercio(undefined)).toBe(undefined);
    expect(canonizarComercio(42)).toBe(42);
  });
});

describe('extraerComercioPasarela', () => {
  // El texto llega de `extraerTexto` (gmail.js), que colapsa TODOS los espacios: después del
  // comercio no queda ninguna marca de fin de campo. Por eso el corte por terminador.
  it('corta en el punto de la frase de BCP', () => {
    const correo = 'Hola Favio, Realizaste un consumo de S/ 97.00 con tu Tarjeta de Crédito ' +
      'BCP en IZI*BARBANEGRA. Por tu seguridad, te enviamos los datos de tu operación.';
    expect(extraerComercioPasarela(correo)).toBe('BARBANEGRA');
  });

  it('corta en la palabra con la que sigue el aviso cuando no hay puntuación', () => {
    expect(extraerComercioPasarela('Empresa IZI*BOTICA PEPITO Tarjeta terminada en 4821'))
      .toBe('BOTICA PEPITO');
    expect(extraerComercioPasarela('IZI*QCHURROS Monto S/ 12.00')).toBe('QCHURROS');
    expect(extraerComercioPasarela('NIUBIZ*EL AGUAJAL Fecha 23/08/2026')).toBe('EL AGUAJAL');
  });

  it('no confunde la máscara de la tarjeta con un comercio', () => {
    // Los asteriscos de "****4821" no llevan letras detrás; el regex exige letra o dígito
    // pegado al asterisco y encima un prefijo de la lista.
    expect(extraerComercioPasarela('Tarjeta ****4821 por S/ 50.00')).toBe(null);
  });

  it('no se come palabras que son parte de la razón social', () => {
    // La lista de terminadores llevaba total, hora, banco, cuenta y empresa, y las cinco
    // aparecen adentro de nombres peruanos normales. Medido: quedaban en "IMPORTACIONES"
    // y "SUPER". Cortar de más pierde el nombre; cortar de menos deja cola y se ve feo.
    expect(extraerComercioPasarela('IZI*IMPORTACIONES TOTAL ARTEFACTOS Tarjeta terminada en 1'))
      .toBe('IMPORTACIONES TOTAL ARTEFACTOS');
    expect(extraerComercioPasarela('IZI*SUPER BANCO DE ALIMENTOS Monto S/ 5'))
      .toBe('SUPER BANCO DE ALIMENTOS');
    // Y "tarjeta" lleva \\b, así que no parte un comercio que venda tarjetas.
    expect(extraerComercioPasarela('IZI*TARJETAS DEL SUR Monto S/ 5')).toBe('TARJETAS DEL SUR');
  });

  it('lee nombres con tilde y con Ñ', () => {
    // El primer carácter exigía [A-Za-z0-9], así que el rescate se caía justo con nombres
    // peruanos y devolvía null — o sea, se guardaba "IZI" igual.
    expect(extraerComercioPasarela('Consumo en IZI*ÑAÑA MARKET. Tarjeta')).toBe('ÑAÑA MARKET');
    expect(extraerComercioPasarela('Consumo en IZI*ÓPTICA LUZ. Tarjeta')).toBe('ÓPTICA LUZ');
  });

  it('rechaza un código de operación seguido de prosa', () => {
    // El chequeo viejo pedía "alguna letra en cualquier posición" y se lo comía la prosa
    // que venía detrás del código: pasaba como comercio "4821 en tu".
    expect(extraerComercioPasarela('Se registro una operacion IZI*4821 en tu cuenta')).toBe(null);
  });

  it('devuelve null cuando no hay forma de pasarela', () => {
    expect(extraerComercioPasarela('Consumo en PLAZA VEA por S/ 45.50')).toBe(null);
    expect(extraerComercioPasarela('')).toBe(null);
    expect(extraerComercioPasarela(null)).toBe(null);
  });
});

describe('parsearCorreoBancario: el comercio no queda a criterio del modelo', () => {
  beforeEach(() => { mockCreate.mockReset(); });

  const responder = (comercio) => mockCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({
      tipo: 'gasto', monto: 97, moneda: 'PEN', comercio,
      categoria: 'Alimentación', subcategoria: 'snacks', banco: 'BCP',
      metodo_pago: 'Credito', fecha: '2026-08-23', descripcion_original: 'consumo',
    }) } }],
  });

  const CORREO_BCP = 'Hola Favio Alejandro, Realizaste un consumo de S/ 97.00 con tu Tarjeta ' +
    'de Crédito BCP en IZI*BARBANEGRA. Por tu seguridad, te enviamos los datos de tu operación. ' +
    'Tarjeta terminada en 4821 Monto S/ 97.00';

  it('rescata el nombre del correo cuando el modelo devuelve sólo la pasarela', async () => {
    // El caso reportado. En prod quedaron dos filas así, de dos usuarios distintos, y el
    // modelo les inventó categorías opuestas (Estacionamiento y Electrónico) desde un
    // nombre que no dice nada.
    responder('IZI');
    const r = await parsearCorreoBancario(CORREO_BCP, 'Consumo con tu Tarjeta BCP');
    expect(r.comercio).toBe('BARBANEGRA');
  });

  it('el correo le gana al modelo cuando el modelo empieza con la pasarela', async () => {
    // El texto original trae "IZI*BARBANEGRA"; el modelo devolvió su propia grafía. Manda
    // el correo, que es la fuente, y así las tres grafías del modelo dan lo mismo.
    responder('IZI* Barbanegra');
    const r = await parsearCorreoBancario(CORREO_BCP, 'Consumo con tu Tarjeta BCP');
    expect(r.comercio).toBe('BARBANEGRA');
  });

  it('llega a la MISMA grafía desde las tres formas que devolvía el modelo', async () => {
    // Es el invariante que hace que la regla del usuario se pegue: las tres tienen que
    // colapsar en un solo string, porque `buscarReglaComercio` compara por igualdad.
    const salidas = [];
    for (const forma of ['IZI', 'IZI*BARBANEGRA', 'IZI BARBANEGRA']) {
      responder(forma);
      salidas.push((await parsearCorreoBancario(CORREO_BCP, 'BCP')).comercio.toLowerCase());
    }
    expect(new Set(salidas).size).toBe(1);
  });

  it('el mapa de razones sociales sigue ganando (entra CON prefijo)', async () => {
    // COMERCIO_MAP tiene entradas como 'DLOCAL*NETFLIX'; canonizar antes las dejaría sin match.
    responder('DLOCAL*NETFLIX');
    const r = await parsearCorreoBancario('Consumo por $15.99 en DLOCAL*NETFLIX', 'BBVA');
    expect(r.comercio).toBe('Netflix');
  });

  it('no toca un comercio sin pasarela', async () => {
    responder('Plaza Vea');
    const r = await parsearCorreoBancario('Consumo en SPSA PLAZA VEA por S/ 45.50', 'BCP');
    expect(r.comercio).toBe('Plaza Vea');
  });

  it('si el correo tampoco tiene el nombre, se queda con el prefijo antes que con nada', async () => {
    responder('IZI');
    const r = await parsearCorreoBancario('Consumo de S/ 10.00 con tu tarjeta BCP.', 'BCP');
    expect(r.comercio).toBe('IZI');
  });
});
