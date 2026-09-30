'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, Mail, MessageCircle } from 'lucide-react';
import { useAdminPagos } from '@/lib/hooks/use-admin-pagos';
import { useAdminRenovaciones } from '@/lib/hooks/use-admin-renovaciones';
import { etiquetaPlazo, linkCorreo, linkWhatsapp, mensajeRenovacion } from '@/lib/admin-renovaciones';
import { ErrorState } from '@/components/shared/error-state';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { toCsv, downloadCsv } from '@/lib/csv-export';
import {
  CSV_HEADERS,
  claveMes,
  contar,
  etiquetaMes,
  etiquetaPagador,
  etiquetaTipoPago,
  fechaLima,
  filasCsv,
  notaNoSuma,
  sumaALaCaja,
} from '@/lib/admin-pagos';
import type { AdminPagoFila, AdminPagosMes, AdminRenovacion } from '@/lib/types-admin';

function formatPen(n: number): string {
  return `S/ ${n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatFecha(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

export default function AdminPagosPage() {
  // `useSearchParams` pide un límite de Suspense para que el shell se pueda prerenderizar.
  return (
    <Suspense fallback={<PagosSkeleton />}>
      <PagosRecibidos />
    </Suspense>
  );
}

function PagosSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-28 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" />
      ))}
    </div>
  );
}

function PagosRecibidos() {
  const router = useRouter();
  const mesParam = useSearchParams().get('mes');
  const { data, isLoading, error, refetch } = useAdminPagos(mesParam);

  const elegirMes = (mes: string) => {
    router.replace(`/admin/pagos?mes=${claveMes(mes)}`, { scroll: false });
  };

  if (error && !data) {
    return (
      <ErrorState
        titulo="No pudimos cargar los pagos"
        variante="card"
        descripcion="La lista no se pudo leer. No es que no haya pagos: reintenta."
        onReintentar={() => refetch()}
      />
    );
  }
  if (isLoading || !data) return <PagosSkeleton />;

  const resumenMes = data.meses.find((m) => claveMes(m.mes) === data.mes);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[#F0EFE8]">Pagos recibidos</h2>
        <p className="mt-0.5 text-sm text-[#8A877D]">
          Quién pagó cada mes. El total es la misma caja que &ldquo;Ingresos&rdquo; en Costos: pagos aprobados de
          cuentas reales, por fecha de aprobación en hora Lima.
        </p>
      </div>

      <Renovaciones />
      <ResumenDelMes mes={data.mes} resumen={resumenMes} />
      <DetalleDelMes mes={data.mes} pagos={data.pagos} />
      <HistorialMeses meses={data.meses} seleccionado={data.mes} onElegir={elegirMes} />
    </div>
  );
}

/**
 * A quién escribirle: clientes que ya pagaron con el plan por vencer o vencido sin renovar. Es
 * independiente del mes elegido (es el estado de hoy), por eso tiene su propia query.
 */
function Renovaciones() {
  const { data, isLoading, error, refetch } = useAdminRenovaciones();

  if (error && !data) {
    return (
      <ErrorState
        titulo="No pudimos cargar las renovaciones"
        variante="card"
        descripcion="La lista no se pudo leer. No es que nadie tenga que renovar: reintenta."
        onReintentar={() => refetch()}
      />
    );
  }
  if (isLoading || !data) {
    return <div className="h-32 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" />;
  }

  const porVencer = data.renovaciones.filter((r) => r.estado === 'por_vencer');
  const vencidos = data.renovaciones.filter((r) => r.estado === 'vencido');

  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-sm font-semibold text-[#F0EFE8]">Renovaciones</h3>
      <p className="mt-0.5 text-xs text-[#8A877D]">
        Clientes que ya pagaron. El botón abre tu WhatsApp con un mensaje listo para editar antes de enviarlo.
      </p>
      <GrupoRenovacion
        titulo={`Vencen en los próximos ${data.dias} días`}
        filas={porVencer}
        vacio={`Nadie vence en los próximos ${data.dias} días.`}
      />
      <GrupoRenovacion
        titulo={`Vencieron sin renovar (últimos ${data.dias_vencido} días)`}
        filas={vencidos}
        vacio="Nadie venció sin renovar en ese periodo."
      />
    </div>
  );
}

function GrupoRenovacion({ titulo, filas, vacio }: { titulo: string; filas: AdminRenovacion[]; vacio: string }) {
  return (
    <div className="mt-4">
      <div className="text-[10px] uppercase tracking-wider text-[#8A877D]">
        {titulo} · {filas.length}
      </div>
      {filas.length === 0 ? (
        <p className="py-3 text-sm text-[#8A877D]">{vacio}</p>
      ) : (
        <ul className="mt-1 divide-y divide-white/5">
          {filas.map((r) => (
            <FilaRenovacion key={r.usuario_id} r={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilaRenovacion({ r }: { r: AdminRenovacion }) {
  const texto = mensajeRenovacion(r);
  const wa = linkWhatsapp(r.whatsapp, texto);
  const correo = wa ? null : linkCorreo(r, texto);
  const nombre = r.nombre || r.whatsapp || r.email_web || 'Sin nombre';
  const boton =
    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs transition-colors';
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-[180px] flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[#F0EFE8]">
          {nombre}
          {r.pago_pendiente && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              comprobante pendiente
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-[#8A877D]">
          {r.tipo_plan || 'plan sin tipo'} · {contar(r.n_pagos, 'pago', 'pagos')} · último{' '}
          {formatPen(r.ultimo_monto)}
        </div>
      </div>
      <div className={`whitespace-nowrap text-sm ${r.estado === 'por_vencer' ? 'text-amber-400' : 'text-[#D85A30]'}`}>
        {etiquetaPlazo(r)}
        <span className="ml-1.5 text-xs text-[#8A877D]">{formatFecha(r.premium_vence)}</span>
      </div>
      {wa ? (
        <a
          href={wa}
          target="_blank"
          rel="noopener noreferrer"
          className={`${boton} border-[rgba(29,158,117,0.35)] bg-[rgba(29,158,117,0.10)] text-[#1D9E75] hover:bg-[rgba(29,158,117,0.18)]`}
        >
          <MessageCircle className="h-3.5 w-3.5" />
          Escribir por WhatsApp
        </a>
      ) : correo ? (
        <a href={correo} className={`${boton} border-white/10 bg-[#131311] text-[#C8C6BC] hover:text-[#F0EFE8]`}>
          <Mail className="h-3.5 w-3.5" />
          Escribir por correo
        </a>
      ) : (
        <span className="text-xs text-[#5A584F]">sin contacto</span>
      )}
    </li>
  );
}

function Kpi({ label, value, subtitle }: { label: string; value: string | number; subtitle?: string }) {
  return (
    <div className="glass-card rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-[#8A877D]">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-[#F0EFE8]">{value}</div>
      {subtitle && <div className="mt-1 text-xs text-[#8A877D]">{subtitle}</div>}
    </div>
  );
}

function ResumenDelMes({ mes, resumen }: { mes: string; resumen: AdminPagosMes | undefined }) {
  const r = resumen;
  const nota = r ? notaNoSuma(r) : null;
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-[#F0EFE8]">{etiquetaMes(mes)}</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Cobrado" value={formatPen(r?.total_pen ?? 0)} subtitle={contar(r?.n_pagos ?? 0, 'pago', 'pagos')} />
        <Kpi
          label="Primer pago"
          value={r?.n_primer_pago ?? 0}
          subtitle={contar(r?.n_renovacion ?? 0, 'renovación', 'renovaciones')}
        />
        <Kpi label="Mensual" value={r?.n_mensual ?? 0} subtitle={formatPen(r?.total_mensual ?? 0)} />
        <Kpi label="Anual" value={r?.n_anual ?? 0} subtitle={formatPen(r?.total_anual ?? 0)} />
      </div>
      {nota && <p className="mt-2 text-xs text-[#8A877D]">{nota}</p>}
    </div>
  );
}

function DetalleDelMes({ mes, pagos }: { mes: string; pagos: AdminPagoFila[] }) {
  const exportar = () => downloadCsv(`neto-pagos-${mes}.csv`, toCsv(CSV_HEADERS, filasCsv(pagos)));

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[#F0EFE8]">Detalle</h3>
          <p className="mt-0.5 text-xs text-[#8A877D]">
            &ldquo;Primer pago&rdquo; o &ldquo;renovación&rdquo; se cuenta sobre toda la historia de esa cuenta.
          </p>
        </div>
        {pagos.length > 0 && (
          <button
            onClick={exportar}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#131311] px-2.5 py-1.5 text-xs text-[#C8C6BC] hover:text-[#F0EFE8]"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </button>
        )}
      </div>

      {pagos.length === 0 ? (
        <div className="py-8 text-center text-sm text-[#8A877D]">Nadie pagó este mes.</div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-[#8A877D]">
                <th className="pb-2 pr-4 font-medium">Fecha</th>
                <th className="pb-2 pr-4 font-medium">Usuario</th>
                <th className="pb-2 pr-4 text-right font-medium">Monto</th>
                <th className="pb-2 pr-4 font-medium">Plan</th>
                <th className="pb-2 pr-4 font-medium">Tipo</th>
                <th className="pb-2 pr-4 font-medium">Canal</th>
                <th className="pb-2 pr-4 font-medium">Cubre hasta</th>
                <th className="pb-2 font-medium">Comprobante</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {pagos.map((p) => (
                <FilaPago key={p.id} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilaPago({ p }: { p: AdminPagoFila }) {
  const suma = sumaALaCaja(p);
  const tipo = etiquetaTipoPago(p);
  const tono =
    p.estado !== 'aprobado'
      ? 'text-amber-400'
      : p.n_pago === 1
        ? 'text-[#1D9E75]'
        : p.n_pago != null
          ? 'text-[#C8C6BC]'
          : 'text-[#8A877D]';
  return (
    <tr className={suma ? '' : 'opacity-60'}>
      <td className="whitespace-nowrap py-2 pr-4 text-[#C8C6BC]">{formatFecha(fechaLima(p.cuando))}</td>
      <td className="py-2 pr-4 text-[#F0EFE8]">
        {etiquetaPagador(p)}
        {p.interno && <span className="ml-2 text-[10px] uppercase text-[#8A877D]">interna, no suma</span>}
      </td>
      <td className="whitespace-nowrap py-2 pr-4 text-right text-[#F0EFE8]">{p.monto == null ? '—' : formatPen(p.monto)}</td>
      <td className="py-2 pr-4 text-[#C8C6BC]">{p.tipo_plan || '—'}</td>
      <td className={`py-2 pr-4 ${tono}`}>{tipo}</td>
      <td className="py-2 pr-4 text-[#8A877D]">{p.origen || '—'}</td>
      <td className="py-2 pr-4 text-[#8A877D]">{formatFecha(p.premium_vence)}</td>
      <td className="py-2">
        {p.tiene_comprobante ? <VerComprobante p={p} /> : <span className="text-[#5A584F]">—</span>}
      </td>
    </tr>
  );
}

/**
 * El comprobante se ve en un visor encima de la tabla, sin salir de la página.
 *
 * La URL firmada se pide al abrir, no al listar: firmar un comprobante por fila en cada carga es
 * trabajo que casi nunca se usa. Se pide cada vez que se abre porque la firma dura una hora y la
 * página puede quedar abierta más que eso. Reutiliza `/api/admin/payments?user_id=`, que ya firma.
 */
function VerComprobante({ p }: { p: AdminPagoFila }) {
  const [abierto, setAbierto] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando');

  const cargar = async () => {
    setUrl(null);
    setEstado('cargando');
    try {
      const res = await fetch(`/api/admin/payments?user_id=${encodeURIComponent(p.usuario_id)}`);
      const json = await res.json();
      const firmada: string | undefined = (json.pagos || []).find(
        (x: { id: string; comprobante_signed_url?: string | null }) => x.id === p.id,
      )?.comprobante_signed_url;
      if (!res.ok || !firmada) throw new Error('sin url');
      setUrl(firmada);
      setEstado('listo');
    } catch {
      setEstado('error');
    }
  };

  const abrir = () => {
    setAbierto(true);
    void cargar();
  };

  return (
    <>
      <button onClick={abrir} className="text-xs text-[#1D9E75] hover:underline">
        Ver
      </button>
      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="glass-card-elevated border-0 gap-3 p-5 sm:max-w-lg">
          <DialogTitle className="pr-8 text-base text-[#F0EFE8]">Comprobante de {etiquetaPagador(p)}</DialogTitle>
          <DialogDescription className="text-xs text-[#8A877D]">
            {formatFecha(fechaLima(p.cuando))} · {p.monto == null ? 'sin monto' : formatPen(p.monto)} ·{' '}
            {p.tipo_plan || 'sin plan'} · {etiquetaTipoPago(p)}
          </DialogDescription>

          <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-lg bg-black/30">
            {estado === 'cargando' && <span className="text-sm text-[#8A877D]">Cargando comprobante…</span>}
            {estado === 'error' && (
              <ErrorState
                titulo="No se pudo cargar el comprobante"
                variante="card"
                descripcion="La imagen no llegó. No es que no exista: reintenta."
                onReintentar={() => void cargar()}
              />
            )}
            {estado === 'listo' && url && (
              // eslint-disable-next-line @next/next/no-img-element -- URL firmada de Storage, no pasa por next/image
              <img
                src={url}
                alt={`Comprobante de pago de ${etiquetaPagador(p)}`}
                className="max-h-[70vh] w-full object-contain"
                onError={() => setEstado('error')}
              />
            )}
          </div>

          {estado === 'listo' && url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="self-end text-xs text-[#8A877D] hover:text-[#F0EFE8]"
            >
              Abrir en pestaña nueva ↗
            </a>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistorialMeses({
  meses,
  seleccionado,
  onElegir,
}: {
  meses: AdminPagosMes[];
  seleccionado: string;
  onElegir: (mes: string) => void;
}) {
  if (meses.length === 0) return null;
  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-sm font-semibold text-[#F0EFE8]">Todos los meses</h3>
      <div className="mt-4 overflow-x-auto">
        {/* Una columna por dato, números alineados a la derecha con cifras de ancho fijo, y
            aire en los dos bordes para que la fila resaltada no toque el borde de la tarjeta. */}
        <table className="w-full min-w-[560px] text-sm tabular-nums">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-[#8A877D]">
              <th className="pb-2 pl-3 pr-4 font-medium">Mes</th>
              <th className="pb-2 pr-4 text-right font-medium">Cobrado</th>
              <th className="pb-2 pr-4 text-right font-medium">Pagos</th>
              <th className="pb-2 pr-4 text-right font-medium">Primer pago</th>
              <th className="pb-2 pr-4 text-right font-medium">Renovación</th>
              <th className="pb-2 pr-4 text-right font-medium">Mensual</th>
              <th className="pb-2 pr-3 text-right font-medium">Anual</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {[...meses].reverse().map((m) => {
              const activo = claveMes(m.mes) === seleccionado;
              return (
                <tr
                  key={m.mes}
                  onClick={() => onElegir(m.mes)}
                  className={`cursor-pointer transition-colors hover:bg-white/[0.03] ${activo ? 'bg-[rgba(29,158,117,0.08)]' : ''}`}
                >
                  <td className={`py-2.5 pl-3 pr-4 ${activo ? 'text-[#1D9E75]' : 'text-[#F0EFE8]'}`}>
                    {etiquetaMes(m.mes)}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-right text-[#F0EFE8]">{formatPen(m.total_pen)}</td>
                  <td className="py-2.5 pr-4 text-right text-[#C8C6BC]">{m.n_pagos}</td>
                  <td className="py-2.5 pr-4 text-right text-[#C8C6BC]">{m.n_primer_pago}</td>
                  <td className="py-2.5 pr-4 text-right text-[#C8C6BC]">{m.n_renovacion}</td>
                  <td className="py-2.5 pr-4 text-right text-[#C8C6BC]">{m.n_mensual}</td>
                  <td className="py-2.5 pr-3 text-right text-[#C8C6BC]">{m.n_anual}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
