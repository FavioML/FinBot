import { describe, it, expect, beforeEach } from 'vitest';
import {
  publicarIdNeto,
  alSaberIdNeto,
  olvidarIdNeto,
  _resetIdNeto,
} from './identidad-neto';

/**
 * El canal entre el bootstrap del dashboard (publica) y PostHog (consume). Su fallo es
 * silencioso por los dos lados: si no avisa, analytics cae a su consulta y nadie se
 * entera salvo mirando peticiones; si avisa de más o con el id viejo, se identifica a
 * alguien con la identidad de otro. Ninguna de las dos rompe una pantalla.
 */
beforeEach(() => {
  _resetIdNeto();
});

describe('identidad-neto', () => {
  it('avisa al suscriptor que llegó ANTES de la publicación', () => {
    const vistos: string[] = [];
    alSaberIdNeto((id) => vistos.push(id));
    expect(vistos).toEqual([]);

    publicarIdNeto('user-1');
    expect(vistos).toEqual(['user-1']);
  });

  it('avisa EN EL ACTO al suscriptor que llegó después', () => {
    // Las dos órdenes son reales: PostHogProvider monta en el root layout y el bootstrap
    // adentro del shell, y quién gana depende de cuándo resuelva el import dinámico de
    // posthog-js.
    publicarIdNeto('user-1');
    const vistos: string[] = [];
    alSaberIdNeto((id) => vistos.push(id));
    expect(vistos).toEqual(['user-1']);
  });

  it('no repite el mismo id, y el suscriptor SOBREVIVE al primer aviso', () => {
    const vistos: string[] = [];
    alSaberIdNeto((id) => vistos.push(id));

    publicarIdNeto('user-1');
    publicarIdNeto('user-1');
    expect(vistos).toEqual(['user-1']);

    // La suscripción no se canceló sola: un id distinto (otra sesión en la misma
    // pestaña) tiene que llegarle igual.
    publicarIdNeto('user-2');
    expect(vistos).toEqual(['user-1', 'user-2']);
  });

  it('tras olvidar, la MISMA cuenta vuelve a avisar', () => {
    // El caso que motivó `olvidarIdNeto`: cerrar sesión y volver a entrar con la misma
    // cuenta. Sin olvidar, el corto de "ya es el mismo id" descarta la publicación y esa
    // segunda sesión queda sin identificar.
    const vistos: string[] = [];
    alSaberIdNeto((id) => vistos.push(id));
    publicarIdNeto('user-1');

    olvidarIdNeto();
    publicarIdNeto('user-1');
    expect(vistos).toEqual(['user-1', 'user-1']);
  });

  it('desuscribirse corta los avisos', () => {
    const vistos: string[] = [];
    const cortar = alSaberIdNeto((id) => vistos.push(id));
    cortar();
    publicarIdNeto('user-1');
    expect(vistos).toEqual([]);
  });

  it('ignora un id vacío en vez de publicar basura', () => {
    const vistos: string[] = [];
    alSaberIdNeto((id) => vistos.push(id));
    publicarIdNeto('');
    expect(vistos).toEqual([]);
  });
});
