import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El alta ya no tiene puerta de Gmail, y este archivo existe para que no vuelva a tenerla.
 *
 * Antes el paso 30 era el emisor REAL de la URL de OAuth: `/conectar` y `agregar_gmail` no
 * entregaban nada, dejaban al usuario en `onboarding_paso = 30` con un menú numerado de
 * bancos, y la URL salía cuando respondía. O sea que el estado de una capability de pago
 * vivía en la base ENTRE dos mensajes, y el gate del llamador ya había quedado atrás: por eso
 * los pasos 30 y 31 necesitaban cada uno su gate duplicado — alcanzaba con que el trial
 * venciera entre el comando y la respuesta para entregar un enlace que quema un cupo.
 *
 * Conectar es web-only. Los dos pasos se borraron, sus dos gates duplicados con ellos, y lo
 * que queda por verificar es lo contrario de antes: que la máquina de estados NO emita, NO
 * capture la respuesta, y NO deje encerrado a nadie que hubiera quedado a medias.
 */

// onboarding.js destructura sus dependencias al cargar, así que hay que parchear antes.
const updates = [];
const supabaseMock = {
  from: vi.fn(() => {
    const c = {};
    for (const m of ['select', 'eq', 'single', 'maybeSingle']) c[m] = vi.fn(() => c);
    // El `.select()` es la cláusula RETURNING que piden las escrituras del alta desde el ítem
    // 9D, y el `data` tiene que traer una fila: con `null` el handler lee "cero filas
    // afectadas" —la fila del usuario ya no existe— y contesta el mensaje de fallo en vez de
    // seguir el camino que este archivo mide.
    c.update = vi.fn((payload) => {
      updates.push(payload);
      const u = { eq: vi.fn(() => u), select: vi.fn(() => u), then: (ok, ko) => Promise.resolve({ data: [{ id: 'row-1' }], error: null }).then(ok, ko) };
      return u;
    });
    c.delete = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) }));
    return c;
  }),
};
require('../../lib/db').supabase = supabaseMock;

const generarUrlAutorizacion = vi.fn(() => 'https://oauth.example/start');
require('../../gmail').generarUrlAutorizacion = generarUrlAutorizacion;
require('../../gmail').obtenerCuentasGmail = vi.fn().mockResolvedValue([]);

const { manejarOnboarding } = require('../../handlers/onboarding');

/** Un Pro pagado: el perfil al que el paso 30 SÍ le entregaba el enlace. */
function proPagado(extra) {
  return {
    id: 'u1', nombre: 'Ana', plan: 'premium', trial_estado: 'convertido',
    onboarding_completado: true, ...extra,
  };
}

beforeEach(() => {
  generarUrlAutorizacion.mockClear();
  updates.length = 0;
});

describe('el alta no emite OAuth por ningún paso', () => {
  // Los pasos que la máquina sigue atendiendo. Ninguno puede responder con un enlace de
  // Google: si mañana alguien reintroduce el selector de bancos como un paso más, cae acá.
  it.each([-1, 0, 1, 2, 10, 20, 100, 30, 31])('el paso %i no entrega una URL de OAuth', async (paso) => {
    const res = await manejarOnboarding({
      usuario: proPagado({ onboarding_paso: paso, onboarding_completado: paso !== 100 }),
      msg: 'todos', cmd: 'todos',
    });
    expect(generarUrlAutorizacion).not.toHaveBeenCalled();
    if (typeof res === 'string') expect(res).not.toContain('oauth.example');
  });
});

/**
 * Los pasos 30 y 31 desaparecieron del código, pero podían quedar escritos en filas de
 * `usuarios` (en producción no quedó ninguna, pero eso es suerte, no una garantía). Un valor
 * de paso huérfano NO puede convertirse en una celda: sin este caso, quien hubiera quedado
 * a mitad del menú vería cada mensaje suyo interpretado por un `if` que ya no existe.
 */
describe('un paso huérfano (30/31) no atrapa a nadie', () => {
  it.each([30, 31])('el paso %i cae a la cascada normal en vez de capturar la respuesta', async (paso) => {
    const res = await manejarOnboarding({
      usuario: proPagado({ onboarding_paso: paso }),
      msg: '1,3,5', cmd: '1,3,5',
    });
    // null = "esto no es del alta, sigue con los comandos y el NLP", que es exactamente lo
    // que queremos: el mensaje lo atiende el resto del webhook, no un estado muerto.
    expect(res).toBeNull();
  });

  // Y el que además tenía el alta a medias sale hacia adelante (se le pregunta el nombre),
  // no hacia el menú de bancos.
  it('quien tenía el alta incompleta se reengancha en el paso del nombre', async () => {
    const res = await manejarOnboarding({
      usuario: { id: 'u2', onboarding_paso: 30, onboarding_completado: false, plan: 'premium', trial_estado: 'convertido' },
      msg: 'todos', cmd: 'todos',
    });
    expect(res).toContain('¿Cómo te llamas?');
    expect(updates).toContainEqual(expect.objectContaining({ onboarding_paso: 100 }));
  });
});
