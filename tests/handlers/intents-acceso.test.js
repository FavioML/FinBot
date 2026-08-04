import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const acceso = require('../../handlers/intents-acceso');
const { listIntents } = require('../../handlers/intent-registry');

// Este archivo existe por un solo motivo: que un intent NUEVO no pueda filtrarse gratis.
//
// El muro de lectura (post-trial) se aplica en un chokepoint que consulta
// `requiereLectura(intencion)`. Con una sola lista — la de lo bloqueado — cualquier
// intent de consulta que se agregue después queda abierto EN SILENCIO, y eso no se
// detecta mirando producción: se ve como un usuario contento que nunca paga.
//
// La red es exigir clasificación explícita: todo intent registrado tiene que estar en
// LECTURA (se cobra) o en LIBRES (escritura, conversión o servicio). Si agregas un intent
// y este test falla, la respuesta correcta NO es agregarlo a LIBRES por inercia — es
// preguntarte si tu intent LEE la data que el usuario acumuló.

describe('clasificación de acceso de intents (muro post-trial)', () => {
  const registrados = listIntents();

  it('el registry carga intents (si esto falla, el resto del archivo miente)', () => {
    expect(registrados.length).toBeGreaterThan(50);
  });

  it('todo intent registrado está clasificado como lectura o libre', () => {
    const sinClasificar = registrados.filter(
      (i) => !acceso.INTENTS_LECTURA.has(i) && !acceso.INTENTS_LIBRES.has(i)
    );
    expect(sinClasificar).toEqual([]);
  });

  it('ningún intent está en las dos listas', () => {
    const enAmbas = registrados.filter(
      (i) => acceso.INTENTS_LECTURA.has(i) && acceso.INTENTS_LIBRES.has(i)
    );
    expect(enAmbas).toEqual([]);
  });

  it('no hay intents fantasma en las listas (nombres que ya no existen)', () => {
    const vivos = new Set(registrados);
    const fantasma = [...acceso.INTENTS_LECTURA, ...acceso.INTENTS_LIBRES].filter((i) => !vivos.has(i));
    expect(fantasma).toEqual([]);
  });

  // La promesa que no se negocia: Neto nunca deja de registrar gastos. Si alguien mueve
  // uno de estos a LECTURA, rompe el compromiso del sprint de activación.
  it('registrar y corregir gastos NUNCA requiere plan', () => {
    for (const i of [
      'registrar_manual', 'corregir_categoria', 'corregir_monto_moneda', 'editar_monto',
      'editar_fecha', 'editar_comercio', 'eliminar_transaccion', 'deshacer_ultimo',
      'restaurar_eliminado', 'marcar_como_ingreso', 'dividir_gasto', 'duplicar_gasto',
      'ver_ultima_transaccion',
      // Un gasto que cae en un espacio compartido sigue siendo un gasto. Estuvo del
      // lado de LECTURA junto al resto del módulo, o sea que el muro cortaba una
      // ESCRITURA (hallazgo M11). Las 6 lecturas de Espacios siguen cobrándose.
      'registrar_gasto_espacio',
    ]) {
      expect(acceso.requiereLectura(i), i + ' debería seguir libre en el muro').toBe(false);
    }
  });

  // El otro lado de M11, explícito para que no se lo lleve puesto un barrido futuro:
  // se movió UN intent, no el módulo. Consultar el balance de un espacio se paga.
  it('las lecturas de Espacios siguen detrás del muro', () => {
    for (const i of ['ver_espacios', 'ver_balance_espacio', 'liquidar_espacio',
                     'crear_espacio', 'invitar_espacio', 'unirse_espacio']) {
      expect(acceso.requiereLectura(i), i + ' debería seguir cobrándose').toBe(true);
    }
  });

  // Cerrarle a quien está en el muro el camino de pagar sería absurdo.
  it('los caminos de conversión y soporte siguen abiertos', () => {
    for (const i of ['ver_premium', 'ver_referidos', 'estado_cuenta', 'ver_dashboard',
                     'hablar_con_humano', 'ayuda', 'saludo']) {
      expect(acceso.requiereLectura(i), i + ' no puede quedar detrás del muro').toBe(false);
    }
  });

  it('las consultas agregadas sí requieren plan', () => {
    for (const i of ['listar_gastos_mes', 'ver_total_gastado', 'listar_gastos_categoria',
                     'ver_reporte', 'exportar_datos', 'ver_suscripciones', 'comparar_meses',
                     'consulta_financiera', 'ver_presupuesto', 'ver_metas', 'ver_deudas']) {
      expect(acceso.requiereLectura(i), i + ' debería estar detrás del muro').toBe(true);
    }
  });
});

describe('comandos / de lectura', () => {
  it('reconoce los comandos de consulta, con y sin argumentos', () => {
    for (const c of ['/mes', '/semana', '/resumen', '/reporte', '/reporte julio',
                     '/presupuesto', '/presupuesto 500 comida', '/escanear', '/pendientes',
                     '/categorias']) {
      expect(acceso.comandoRequiereLectura(c), c).toBe(true);
    }
  });

  // Espejo del test de intents fantasma: si alguien saca un comando de COMANDOS_LECTURA, el
  // caso de arriba lo caza — pero solo si el comando estaba enumerado ahí. Este cierra el
  // otro lado: todo lo que esté en el Set tiene que estar fijado por el test, así que agregar
  // uno obliga a listarlo. Sin esto, `/pendientes` vivió sin cobertura.
  it('todos los comandos de COMANDOS_LECTURA están fijados en este test', () => {
    const fijados = new Set(['/mes', '/semana', '/resumen', '/reporte', '/presupuesto',
                             '/escanear', '/pendientes', '/categorias']);
    const sinFijar = [...acceso.COMANDOS_LECTURA].filter((c) => !fijados.has(c));
    expect(sinFijar).toEqual([]);
  });

  it('deja pasar los de servicio, conversión y escritura', () => {
    for (const c of ['/premium', '/ayuda', '/referir', '/silenciar', '/soporte', '/dashboard',
                     '/conectar', '/manual', '/bancos', 'hola', '']) {
      expect(acceso.comandoRequiereLectura(c), c).toBe(false);
    }
  });

  // El saludo da el total del mes y el conteo de movimientos: ES el número que se decidió
  // dejar del lado gratis (la señal de que la data sigue creciendo). Si alguien lo mete en
  // COMANDOS_LECTURA, el usuario en el muro pierde su único motivo para seguir anotando.
  it('el saludo no es una lectura bloqueada', () => {
    expect(acceso.COMANDOS_LECTURA.has('hola')).toBe(false);
  });
});
