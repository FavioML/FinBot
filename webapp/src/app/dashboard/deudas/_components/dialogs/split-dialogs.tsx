'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { GastoCompartido, GastoParticipante } from '@/lib/hooks/use-split';

const INPUT_CLS = 'w-full rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#F0EFE8] placeholder:text-[#8A877D] outline-none focus:border-[#1D9E75]';
const LABEL_CLS = 'text-xs text-[#8A877D] mb-1.5 block';

export interface SplitCreatePayload {
  descripcion: string;
  monto_total: number;
  fecha_limite?: string;
  participantes: { nombre: string; monto_debe: number }[];
}

/** Dialog: dividir un gasto entre varias personas. */
export function SplitCreateDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: SplitCreatePayload) => void;
  isPending: boolean;
}) {
  const [desc, setDesc] = useState('');
  const [monto, setMonto] = useState('');
  const [numPersonas, setNumPersonas] = useState('2');
  const [names, setNames] = useState<string[]>([]);
  const [fechaLimite, setFechaLimite] = useState('');

  useEffect(() => {
    if (open) {
      setDesc('');
      setMonto('');
      setNumPersonas('2');
      setNames([]);
      setFechaLimite('');
    }
  }, [open]);

  function handleCreate() {
    if (!desc.trim() || !monto) {
      toast.error('Completa descripcion y monto');
      return;
    }
    const total = parseFloat(monto);
    const num = parseInt(numPersonas) || 2;
    if (isNaN(total) || total <= 0 || num < 2) {
      toast.error('Monto y numero de personas invalidos');
      return;
    }
    const perPerson = Math.round((total / num) * 100) / 100;
    const filled = names.filter((n) => n.trim());
    const participantes = Array.from({ length: num - 1 }, (_, i) => ({
      nombre: filled[i] || `Persona ${i + 1}`,
      monto_debe: perPerson,
    }));
    onSubmit({ descripcion: desc.trim(), monto_total: total, fecha_limite: fechaLimite || undefined, participantes });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card-elevated text-[#F0EFE8] max-w-md">
        <DialogHeader>
          <DialogTitle>Dividir gasto</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className={LABEL_CLS}>Descripcion</label>
            <input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ej: Cena del viernes, Uber, etc." className={INPUT_CLS} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Monto total (S/)</label>
              <input type="number" value={monto} onChange={(e) => setMonto(e.target.value)} placeholder="300" className={INPUT_CLS} />
            </div>
            <div>
              <label className={LABEL_CLS}>Personas (incluido tu)</label>
              <input
                type="number"
                value={numPersonas}
                onChange={(e) => {
                  setNumPersonas(e.target.value);
                  const n = parseInt(e.target.value) || 2;
                  setNames((prev) => {
                    const next = [...prev];
                    while (next.length < n - 1) next.push('');
                    return next.slice(0, n - 1);
                  });
                }}
                min="2"
                max="20"
                className={INPUT_CLS}
              />
            </div>
          </div>

          {monto && numPersonas && (
            <p className="text-xs text-[#8A877D] bg-[rgba(239,159,39,0.06)] rounded-lg px-3 py-2">
              Cada persona: <span className="text-[#EF9F27] font-medium">S/ {(parseFloat(monto) / (parseInt(numPersonas) || 2)).toFixed(2)}</span>
            </p>
          )}

          <div>
            <label className={LABEL_CLS}>Fecha limite de cobro (opcional)</label>
            <input type="date" value={fechaLimite} onChange={(e) => setFechaLimite(e.target.value)} className={INPUT_CLS} />
          </div>

          {Array.from({ length: Math.max(0, (parseInt(numPersonas) || 2) - 1) }, (_, i) => (
            <div key={i}>
              <label className="text-xs text-[#8A877D] mb-1 block">Persona {i + 1}</label>
              <input
                type="text"
                value={names[i] || ''}
                onChange={(e) => {
                  const next = [...names];
                  next[i] = e.target.value;
                  setNames(next);
                }}
                placeholder={`Nombre persona ${i + 1}`}
                className={INPUT_CLS}
              />
            </div>
          ))}

          <div className="flex gap-2 pt-1">
            <Button onClick={handleCreate} className="flex-1 bg-[#EF9F27] text-white hover:bg-[#EF9F27]/90" disabled={isPending}>
              {isPending ? 'Creando...' : 'Crear gasto compartido'}
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

export interface SplitEditPayload {
  id: string;
  descripcion: string;
  fecha_limite: string | null;
  notas: string | null;
  participantes: { id: string; nombre: string }[];
}

/** Dialog: editar un gasto compartido. */
export function SplitEditDialog({
  gasto,
  onClose,
  onSubmit,
  isPending,
}: {
  gasto: GastoCompartido | null;
  onClose: () => void;
  onSubmit: (payload: SplitEditPayload) => void;
  isPending: boolean;
}) {
  const [desc, setDesc] = useState('');
  const [fecha, setFecha] = useState('');
  const [notas, setNotas] = useState('');
  const [names, setNames] = useState<{ id: string; nombre: string }[]>([]);

  useEffect(() => {
    if (gasto) {
      setDesc(gasto.descripcion);
      setFecha(gasto.fecha_limite || '');
      setNotas(gasto.notas || '');
      setNames((gasto.gasto_participantes || []).map((p) => ({ id: p.id, nombre: p.nombre })));
    }
  }, [gasto]);

  function handleUpdate() {
    if (!desc.trim()) {
      toast.error('La descripcion no puede estar vacia');
      return;
    }
    if (!gasto) return;
    onSubmit({ id: gasto.id, descripcion: desc.trim(), fecha_limite: fecha || null, notas: notas || null, participantes: names });
  }

  return (
    <Dialog open={!!gasto} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="glass-card-elevated text-[#F0EFE8] max-w-md">
        <DialogHeader>
          <DialogTitle>Editar gasto compartido</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className={LABEL_CLS}>Descripcion</label>
            <input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} className={`${INPUT_CLS} focus:border-[#EF9F27]`} />
          </div>
          <div>
            <label className={LABEL_CLS}>Fecha limite de cobro (opcional)</label>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={`${INPUT_CLS} focus:border-[#EF9F27]`} />
          </div>
          <div>
            <label className={LABEL_CLS}>Participantes</label>
            <div className="space-y-2">
              {names.map((p, i) => (
                <div key={p.id} className="flex items-center gap-2">
                  <span className="text-xs text-[#8A877D] w-20 shrink-0">Persona {i + 1}</span>
                  <input
                    type="text"
                    value={p.nombre}
                    onChange={(e) => {
                      const next = [...names];
                      next[i] = { ...next[i], nombre: e.target.value };
                      setNames(next);
                    }}
                    className={`flex-1 ${INPUT_CLS} py-1.5 focus:border-[#EF9F27]`}
                  />
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className={LABEL_CLS}>Notas (opcional)</label>
            <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej: Cena de cumpleanos" className={`${INPUT_CLS} focus:border-[#EF9F27]`} />
          </div>
          <div className="flex gap-2 pt-1">
            <Button onClick={handleUpdate} className="flex-1 bg-[#EF9F27] text-white hover:bg-[#EF9F27]/90" disabled={isPending}>
              {isPending ? 'Guardando...' : 'Guardar cambios'}
            </Button>
            <Button variant="outline" onClick={onClose} className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC]">
              Cancelar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Dialog: registrar pago de un participante de un gasto compartido. */
export function SplitAbonoDialog({
  target,
  onClose,
  onSubmit,
  isPending,
}: {
  target: { gastoId: string; participante: GastoParticipante } | null;
  onClose: () => void;
  onSubmit: (monto: number) => void;
  isPending: boolean;
}) {
  const [monto, setMonto] = useState('');

  useEffect(() => {
    if (target) {
      const pendiente = Number(target.participante.monto_debe) - Number(target.participante.monto_pagado || 0);
      setMonto(pendiente.toFixed(2));
    }
  }, [target]);

  function handleAbono() {
    const val = parseFloat(monto);
    if (!val || val <= 0) {
      toast.error('Monto invalido');
      return;
    }
    onSubmit(val);
  }

  const pendiente = target ? Number(target.participante.monto_debe) - Number(target.participante.monto_pagado || 0) : 0;

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="glass-card-elevated text-[#F0EFE8] max-w-xs">
        <DialogHeader>
          <DialogTitle>Registrar pago</DialogTitle>
        </DialogHeader>
        {target && (
          <div className="space-y-4">
            <p className="text-xs text-[#8A877D]">
              {target.participante.nombre} — pendiente: <span className="text-[#EF9F27]">S/ {pendiente.toFixed(2)}</span>
            </p>
            <div>
              <label className={LABEL_CLS}>Monto del abono</label>
              <input type="number" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} placeholder={pendiente.toFixed(2)} className={`${INPUT_CLS} focus:border-[#EF9F27]`} />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleAbono} className="flex-1 bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90" disabled={isPending}>
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
