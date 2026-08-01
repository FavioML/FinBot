'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Lock, MessageCircle } from 'lucide-react';
import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from '@/lib/constants';

interface DatosMuro {
  conteoTx: number;
  totalMes: number;
  trialVence: string | null;
  trialEstado: string | null;
  nombre: string | null;
}

/** 14 días — el mismo número que TRIAL_DIAS en el backend (lib/trial.js). */
const TRIAL_DIAS = 14;

const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

/** '2026-07-26' → '26 de julio'. Un ISO crudo en pantalla se lee como un log, no como Neto. */
function fechaLegible(iso: string | null): string | null {
  if (!iso) return null;
  const [, m, d] = String(iso).slice(0, 10).split('-');
  const mes = MESES[parseInt(m, 10) - 1];
  if (!mes || !d) return null;
  return `${parseInt(d, 10)} de ${mes}`;
}

/**
 * Pantalla del muro: lo que ve en el dashboard quien terminó su prueba sin pagar.
 *
 * Las dos cosas que tiene que lograr, en este orden:
 *  1. Que NO se lea como "Neto se rompió". Por eso lo primero que dice es que sus datos
 *     siguen ahí (con el número exacto) y que puede seguir anotando por WhatsApp. Un muro
 *     que parece una falla no vende: hace que la persona se vaya.
 *  2. Mostrar el total del mes. Es el único número que sobrevive del lado gratis, y es el
 *     que genera la comezón que el desglose cobra.
 *
 * Sustituye al contenido de las páginas del dashboard, NO al chrome: el sidebar y la
 * navegación siguen ahí para que se entienda que lo que falta está detrás del pago, no
 * desaparecido.
 */
export function Paywall() {
  const [datos, setDatos] = useState<DatosMuro | null>(null);

  useEffect(() => {
    let cancelado = false;
    // El `?visto=1` emite el paso 401 del embudo desde el backend (una vez por montaje).
    fetch('/api/pro/muro?visto=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelado && d) setDatos(d);
      })
      .catch(() => {});
    return () => {
      cancelado = true;
    };
  }, []);

  const primerNombre = datos?.nombre ? datos.nombre.split(' ')[0] : null;
  const conteo = datos?.conteoTx ?? 0;
  // Quien nunca tuvo prueba (cuentas anteriores al trial que llevan tiempo dormidas) no
  // puede leer "tu prueba terminó": sería mentirle. Su prueba arranca con su próximo
  // gasto, así que el mensaje correcto es la invitación a anotar uno — sale gratis y es
  // mejor gancho de reactivación que un cobro.
  const nuncaTuvoTrial = !!datos && !datos.trialEstado;

  return (
    <div className="mx-auto max-w-lg py-6">
      <div className="glass-card rounded-2xl p-6">
        <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-full bg-[#1D9E75]/15 text-[#1D9E75]">
          <Lock className="h-5 w-5" />
        </span>

        <h1 className="mb-2 text-2xl font-bold leading-tight text-[#F0EFE8]">
          {nuncaTuvoTrial ? (
            <>
              {primerNombre ? `${primerNombre}, tienes ` : 'Tienes '}
              {TRIAL_DIAS} días de Neto Pro esperándote
            </>
          ) : (
            <>
              {primerNombre ? `${primerNombre}, tu ` : 'Tu '}prueba de Neto Pro terminó
              {fechaLegible(datos?.trialVence ?? null)
                ? ` el ${fechaLegible(datos!.trialVence)}`
                : ''}
            </>
          )}
        </h1>
        <p className="mb-6 text-[#8A877D]">
          {nuncaTuvoTrial
            ? 'Sin tarjeta. Se activan solos con tu próximo gasto: anótame uno por WhatsApp y entras a ver todo.'
            : conteo > 0
              ? `Tus ${conteo} movimientos siguen guardados — no se borró nada. Y sigo anotando todo lo que me mandes por WhatsApp, gratis.`
              : 'Sigo anotando todo lo que me mandes por WhatsApp, gratis.'}
        </p>

        {/* El total del mes es la señal de que su data sigue creciendo, y es lo que hace
            que el muro muerda. Pero en S/0.00 no hay nada que morder: "activa Pro para
            ver en qué se fue" sobre cero es una frase sin sentido, así que el bloque
            desaparece hasta que haya un gasto del mes. */}
        {!!datos && datos.totalMes > 0 && (
          <div className="mb-6 rounded-xl border border-[rgba(240,239,232,0.08)] bg-[#1C1C19] p-4">
            <p className="text-xs uppercase tracking-wide text-[#8A877D]">Van este mes</p>
            <p className="mt-1 text-3xl font-bold text-[#F0EFE8]">
              S/{datos.totalMes.toFixed(2)}
            </p>
            <p className="mt-1 text-sm text-[#8A877D]">
              Activa Pro para ver en qué se fue.
            </p>
          </div>
        )}

        <p className="mb-3 text-sm text-[#8A877D]">
          {nuncaTuvoTrial ? 'Con Pro tienes:' : 'Con Pro recuperas:'}
        </p>
        <ul className="mb-6 space-y-1.5 text-sm text-[#F0EFE8]">
          <li>Gráficos y desglose por categoría</li>
          <li>Historial completo, sin límite de meses</li>
          <li>Presupuestos, metas y reportes</li>
          <li>Lectura automática de tus correos bancarios</li>
        </ul>

        <Link
          href="/dashboard/pro"
          className="mb-3 block rounded-lg bg-[#1D9E75] px-4 py-3 text-center text-sm font-semibold text-[#0E0E0C] transition-colors hover:bg-[#1D9E75]/90"
        >
          {nuncaTuvoTrial
            ? `Activar Pro ahora — S/${PRO_PRICE_MONTHLY_PEN}/mes o S/${PRO_PRICE_YEARLY_PEN}/año`
            : `Activar Pro — S/${PRO_PRICE_MONTHLY_PEN}/mes o S/${PRO_PRICE_YEARLY_PEN}/año`}
        </Link>

        <p className="flex items-center justify-center gap-1.5 text-xs text-[#8A877D]">
          <MessageCircle className="h-3.5 w-3.5" />
          Mientras tanto, sigue anotando por WhatsApp como siempre.
        </p>
      </div>
    </div>
  );
}
