'use client';

import { useRef, useState } from 'react';
import { Upload, FileSpreadsheet, Loader2, CheckCircle2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { formatCurrency } from '@/lib/utils';

interface ImportResult {
  insertados: number;
  descartadas: number;
  gastos: number;
  ingresos: number;
  totalGastos: number;
  totalIngresos: number;
}

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function ImportDialog({ open, onOpenChange, onSuccess }: ImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const reset = () => {
    setResult(null);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleFile = async (file: File) => {
    setUploading(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/transactions/import', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'No pude importar el archivo.');
        return;
      }
      setResult(data as ImportResult);
      toast.success(`${data.insertados} movimientos importados`);
      onSuccess();
    } catch {
      toast.error('Error de red al subir el archivo.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="bg-[#1C1C1A] border-[#2A2A28] text-[#F0EFE8] max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-[#1D9E75]" />
            Importar Excel / CSV
          </DialogTitle>
          <DialogDescription className="text-[#8A877D]">
            Sube tu estado de cuenta bancario (CSV) o la plantilla de gastos (Excel).
            Neto detecta las columnas fecha, monto y descripción automáticamente.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-2">
            <div className="flex flex-col items-center gap-2 text-center">
              <CheckCircle2 className="h-10 w-10 text-[#1D9E75]" />
              <p className="text-lg font-semibold text-[#F0EFE8]">
                {result.insertados} movimientos importados
              </p>
            </div>
            <div className="space-y-2 rounded-xl bg-[rgba(255,255,255,0.03)] p-4 text-sm">
              {result.gastos > 0 && (
                <div className="flex justify-between">
                  <span className="text-[#8A877D]">Gastos ({result.gastos})</span>
                  <span className="font-medium text-[#D85A30]">{formatCurrency(result.totalGastos)}</span>
                </div>
              )}
              {result.ingresos > 0 && (
                <div className="flex justify-between">
                  <span className="text-[#8A877D]">Ingresos ({result.ingresos})</span>
                  <span className="font-medium text-[#1D9E75]">{formatCurrency(result.totalIngresos)}</span>
                </div>
              )}
              {result.descartadas > 0 && (
                <div className="flex justify-between">
                  <span className="text-[#8A877D]">Filas descartadas</span>
                  <span className="text-[#8A877D]">{result.descartadas}</span>
                </div>
              )}
            </div>
            <Button
              className="w-full bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white"
              onClick={() => onOpenChange(false)}
            >
              Listo
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.02)] py-10 transition-colors hover:border-[#1D9E75]/50 hover:bg-[rgba(29,158,117,0.05)] disabled:opacity-60"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-[#1D9E75]" />
                  <span className="text-sm text-[#8A877D]">Procesando tu archivo…</span>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-[#8A877D]" />
                  <span className="text-sm text-[#C8C6BC]">Toca para elegir un archivo</span>
                  <span className="text-xs text-[#8A877D]">.xlsx o .csv · máx 5MB · 500 filas</span>
                </>
              )}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            <a
              href="https://neto.pe/plantilla_gastos.xlsx"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-xs text-[#1D9E75] hover:underline"
            >
              Descargar plantilla de gastos
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
