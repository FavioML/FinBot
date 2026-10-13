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
      <DialogContent className="glass-card-elevated text-foreground max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary-ink" />
            Importar Excel / CSV
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Sube tu estado de cuenta bancario (CSV) o la plantilla de gastos (Excel).
            Neto detecta las columnas fecha, monto y descripción automáticamente.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-2">
            <div className="flex flex-col items-center gap-2 text-center">
              <CheckCircle2 className="h-10 w-10 text-primary-ink" />
              <p className="text-lg font-semibold text-foreground">
                {result.insertados} movimientos importados
              </p>
            </div>
            <div className="space-y-2 rounded-xl bg-foreground/3 p-4 text-sm">
              {result.gastos > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Gastos ({result.gastos})</span>
                  <span className="font-medium text-negative-ink">{formatCurrency(result.totalGastos)}</span>
                </div>
              )}
              {result.ingresos > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ingresos ({result.ingresos})</span>
                  <span className="font-medium text-positive-ink">{formatCurrency(result.totalIngresos)}</span>
                </div>
              )}
              {result.descartadas > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Filas descartadas</span>
                  <span className="text-muted-foreground">{result.descartadas}</span>
                </div>
              )}
            </div>
            <Button
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
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
              className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-foreground/14 bg-foreground/2 py-10 transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:opacity-60"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-primary-ink" />
                  <span className="text-sm text-muted-foreground">Procesando tu archivo…</span>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-muted-foreground" />
                  <span className="text-sm text-foreground-soft">Toca para elegir un archivo</span>
                  <span className="text-xs text-muted-foreground">.xlsx o .csv · máx 5MB · 500 filas</span>
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
              className="block text-center text-xs text-primary-ink hover:underline"
            >
              Descargar plantilla de gastos
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
