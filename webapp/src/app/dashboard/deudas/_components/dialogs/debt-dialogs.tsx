'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Repeat, Infinity as InfinityIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Deuda, Frecuencia } from '@/lib/hooks/use-debts';
import { monedaSym } from '../../_lib/debt-helpers';

const INPUT_CLS = 'w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]';
const LABEL_CLS = 'text-xs text-[#8A877D] mb-1.5 block';

export interface NuevaDeudaPayload {
  tipo: 'debo' | 'me_deben';
  contraparte: string;
  monto_original: number;
  moneda: 'PEN' | 'USD';
  descripcion?: string;
  fecha_vencimiento?: string;
  es_recurrente: boolean;
  frecuencia: Frecuencia | null;
  fecha_fin: string | null;
}

/** Dialog: crear deuda (o compromiso recurrente). */
export function NuevaDeudaDialog({
  open,
  onOpenChange,
  initialTipo,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTipo: 'debo' | 'me_deben';
  onSubmit: (payload: NuevaDeudaPayload) => void;
  isPending: boolean;
}) {
  const [tipo, setTipo] = useState<'debo' | 'me_deben'>(initialTipo);
  const [contraparte, setContraparte] = useState('');
  const [monto, setMonto] = useState('');
  const [moneda, setMoneda] = useState<'PEN' | 'USD'>('PEN');
  const [descripcion, setDescripcion] = useState('');
  const [fechaVencimiento, setFechaVencimiento] = useState('');
  const [esRecurrente, setEsRecurrente] = useState(false);
  const [frecuencia, setFrecuencia] = useState<Frecuencia>('mensual');
  const [fechaFin, setFechaFin] = useState('');

  // Reinicia el formulario cada vez que se abre.
  useEffect(() => {
    if (open) {
      setTipo(initialTipo);
      setContraparte('');
      setMonto('');
      setMoneda('PEN');
      setDescripcion('');
      setFechaVencimiento('');
      setEsRecurrente(false);
      setFrecuencia('mensual');
      setFechaFin('');
    }
  }, [open, initialTipo]);

  function handleSave() {
    if (!contraparte.trim() || !monto) {
      toast.error('Completa el nombre y el monto');
      return;
    }
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
      toast.error('El monto debe ser mayor a 0');
      return;
    }
    if (esRecurrente && fechaFin && fechaVencimiento && fechaFin < fechaVencimiento) {
      toast.error('La fecha límite debe ser posterior al primer pago');
      return;
    }
    onSubmit({
      tipo,
      contraparte,
      monto_original: montoNum,
      moneda,
      descripcion: descripcion || undefined,
      fecha_vencimiento: fechaVencimiento || undefined,
      es_recurrente: esRecurrente,
      frecuencia: esRecurrente ? frecuencia : null,
      fecha_fin: esRecurrente ? (fechaFin || null) : null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva deuda</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className={LABEL_CLS}>Tipo</label>
            <div className="flex gap-2">
              {(['debo', 'me_deben'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTipo(t)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                    tipo === t
                      ? t === 'debo'
                        ? 'bg-[rgba(216,90,48,0.15)] text-[#D85A30] ring-1 ring-[#D85A30]/40'
                        : 'bg-[rgba(29,158,117,0.15)] text-[#1D9E75] ring-1 ring-[#1D9E75]/40'
                      : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D] hover:text-[#C8C6BC]'
                  }`}
                >
                  {t === 'debo' ? '📤 Yo debo' : '📥 Me deben'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={LABEL_CLS}>{tipo === 'debo' ? 'Acreedor (a quién le debes)' : 'Deudor (quién te debe)'}</label>
            <input
              type="text"
              value={contraparte}
              onChange={(e) => setContraparte(e.target.value)}
              placeholder={tipo === 'debo' ? 'Ej: Juan, BCP, Mi hermana' : 'Ej: Pedro, Ana'}
              className={INPUT_CLS}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Monto</label>
              <input type="number" value={monto} onChange={(e) => setMonto(e.target.value)} placeholder="200" min="0.01" step="0.01" className={INPUT_CLS} />
            </div>
            <div>
              <label className={LABEL_CLS}>Moneda</label>
              <select value={moneda} onChange={(e) => setMoneda(e.target.value as 'PEN' | 'USD')} className={INPUT_CLS}>
                <option value="PEN">S/ Soles</option>
                <option value="USD">$ Dólares</option>
              </select>
            </div>
          </div>

          <div>
            <label className={LABEL_CLS}>Motivo (opcional)</label>
            <input
              type="text"
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder="Ej: la cancha, cena del viernes, préstamo personal"
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label className={LABEL_CLS}>{esRecurrente ? 'Próximo pago' : 'Fecha límite (opcional)'}</label>
            <input type="date" value={fechaVencimiento} onChange={(e) => setFechaVencimiento(e.target.value)} className={INPUT_CLS} />
          </div>

          <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-3 space-y-3">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={esRecurrente} onChange={(e) => setEsRecurrente(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1D9E75]" />
              <span className="flex-1">
                <span className="text-sm text-[#F0EFE8] font-medium flex items-center gap-1.5">
                  <Repeat className="h-3.5 w-3.5 text-[#1D9E75]" /> Compromiso recurrente
                </span>
                <span className="text-xs text-[#8A877D] block mt-0.5">
                  {tipo === 'debo' ? 'Pagas un monto fijo cada periodo (ej: alquiler).' : 'Te pagan un monto fijo cada periodo (ej: mensualidad).'}
                </span>
              </span>
            </label>

            {esRecurrente && (
              <div className="pl-6 space-y-3">
                <div>
                  <label className={LABEL_CLS}>Frecuencia</label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(['semanal', 'quincenal', 'mensual', 'anual'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFrecuencia(f)}
                        className={`py-1.5 rounded-md text-xs font-medium transition-all ${
                          frecuencia === f ? 'bg-[#1D9E75] text-white' : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D] hover:text-[#C8C6BC]'
                        }`}
                      >
                        {f === 'semanal' ? 'Semanal' : f === 'quincenal' ? 'Quincenal' : f === 'mensual' ? 'Mensual' : 'Anual'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#8A877D] mb-1.5 block flex items-center justify-between">
                    <span>Hasta</span>
                    {!fechaFin && (
                      <span className="text-[10px] text-[#1D9E75] flex items-center gap-1">
                        <InfinityIcon className="h-3 w-3" /> indefinido
                      </span>
                    )}
                  </label>
                  <div className="flex gap-1.5">
                    <input type="date" value={fechaFin} onChange={(e) => setFechaFin(e.target.value)} className={`flex-1 ${INPUT_CLS}`} />
                    {fechaFin && (
                      <button type="button" onClick={() => setFechaFin('')} className="px-2 rounded-lg text-xs text-[#8A877D] hover:text-[#C8C6BC] bg-[rgba(255,255,255,0.04)]">
                        Limpiar
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <Button onClick={handleSave} className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90" disabled={isPending}>
              {isPending ? 'Guardando...' : esRecurrente ? 'Crear compromiso' : 'Registrar deuda'}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)} className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]">
              Cancelar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Dialog: registrar abono a una deuda. */
export function AbonoDialog({
  debt,
  onClose,
  onSubmit,
  isPending,
}: {
  debt: Deuda | null;
  onClose: () => void;
  onSubmit: (monto: number, nota: string) => void;
  isPending: boolean;
}) {
  const [montoAbono, setMontoAbono] = useState('');
  const [notaAbono, setNotaAbono] = useState('');

  useEffect(() => {
    if (debt) {
      setMontoAbono('');
      setNotaAbono('');
    }
  }, [debt]);

  function handlePay() {
    const montoNum = parseFloat(montoAbono);
    if (isNaN(montoNum) || montoNum <= 0) {
      toast.error('Ingresa un monto válido');
      return;
    }
    onSubmit(montoNum, notaAbono);
  }

  const sym = debt ? monedaSym(debt.moneda) : 'S/';

  return (
    <Dialog open={!!debt} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
        <DialogHeader>
          <DialogTitle>Registrar abono · {debt?.contraparte}</DialogTitle>
        </DialogHeader>
        {debt && (
          <div className="space-y-4">
            <p className="text-sm text-[#8A877D]">
              Pendiente: <span className="text-[#F0EFE8] font-medium">{sym} {Number(debt.monto_pendiente).toFixed(2)}</span>
            </p>
            <div>
              <label className={LABEL_CLS}>Abono rápido</label>
              <div className="grid grid-cols-4 gap-2">
                {[25, 50, 75, 100].map((pct) => {
                  const val = (Number(debt.monto_pendiente) * pct) / 100;
                  return (
                    <button
                      key={pct}
                      onClick={() => setMontoAbono(val.toFixed(2))}
                      className={`py-2 rounded-lg text-xs font-medium transition-all ${
                        montoAbono === val.toFixed(2)
                          ? 'bg-[rgba(29,158,117,0.2)] text-[#1D9E75] ring-1 ring-[#1D9E75]/40'
                          : 'bg-[rgba(255,255,255,0.04)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.08)]'
                      }`}
                    >
                      <span className="block text-sm font-bold">{pct}%</span>
                      <span className="block text-[10px] text-[#8A877D] tabular-nums">{sym} {val.toFixed(2)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className={LABEL_CLS}>Monto personalizado</label>
              <input
                type="number"
                value={montoAbono}
                onChange={(e) => setMontoAbono(e.target.value)}
                placeholder={String(Number(debt.monto_pendiente).toFixed(2))}
                min="0.01"
                step="0.01"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Nota (opcional)</label>
              <input type="text" value={notaAbono} onChange={(e) => setNotaAbono(e.target.value)} placeholder="Ej: transferencia BCP" className={INPUT_CLS} />
            </div>
            <div className="flex gap-2">
              <Button onClick={handlePay} className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90" disabled={isPending}>
                {isPending ? 'Registrando...' : 'Registrar abono'}
              </Button>
              <Button variant="outline" onClick={onClose} className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]">
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Dialog: confirmar eliminación de deuda. */
export function EliminarDialog({
  open,
  onClose,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-sm">
        <DialogHeader>
          <DialogTitle>Eliminar deuda</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-[#8A877D]">Esta acción no se puede deshacer.</p>
        <div className="flex gap-2 pt-2">
          <Button onClick={onConfirm} className="flex-1 bg-[#D85A30] text-white hover:bg-[#D85A30]/90" disabled={isPending}>
            {isPending ? 'Eliminando...' : 'Eliminar'}
          </Button>
          <Button variant="outline" onClick={onClose} className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]">
            Cancelar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Dialog: editar campos básicos de una deuda. */
export function EditarDeudaDialog({
  debt,
  onClose,
  onSave,
  isPending,
}: {
  debt: Deuda | null;
  onClose: () => void;
  onSave: (fields: { contraparte?: string; descripcion?: string | null; fecha_vencimiento?: string | null }) => void;
  isPending: boolean;
}) {
  const [contraparte, setContraparte] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [fechaVencimiento, setFechaVencimiento] = useState('');

  useEffect(() => {
    if (debt) {
      setContraparte(debt.contraparte);
      setDescripcion(debt.descripcion || '');
      setFechaVencimiento(debt.fecha_vencimiento || '');
    }
  }, [debt]);

  return (
    <Dialog open={!!debt} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="bg-[#1A1A18] border-[#2A2A28] text-[#F0EFE8] max-w-md">
        <DialogHeader>
          <DialogTitle>Editar deuda</DialogTitle>
        </DialogHeader>
        {debt && (
          <div className="space-y-4">
            <div>
              <label className={LABEL_CLS}>{debt.tipo === 'debo' ? 'Acreedor' : 'Deudor'}</label>
              <input type="text" value={contraparte} onChange={(e) => setContraparte(e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label className={LABEL_CLS}>Motivo</label>
              <input type="text" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Ej: la cancha, cena del viernes" className={INPUT_CLS} />
            </div>
            <div>
              <label className={LABEL_CLS}>Fecha limite</label>
              <input type="date" value={fechaVencimiento} onChange={(e) => setFechaVencimiento(e.target.value)} className={INPUT_CLS} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                onClick={() => onSave({ contraparte: contraparte.trim(), descripcion: descripcion.trim() || null, fecha_vencimiento: fechaVencimiento || null })}
                className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
                disabled={isPending || !contraparte.trim()}
              >
                {isPending ? 'Guardando...' : 'Guardar cambios'}
              </Button>
              <Button variant="outline" onClick={onClose} className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]">
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
