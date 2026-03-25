"use client";

import { Check, X, Minus } from "lucide-react";

const ROWS: {
  feature: string;
  neto: "yes" | "partial" | "no";
  manual: "yes" | "partial" | "no";
  bank: "yes" | "partial" | "no";
  netoNote?: string;
  manualNote?: string;
  bankNote?: string;
}[] = [
  {
    feature: "Automático (sin ingresar datos)",
    neto: "yes",
    manual: "no",
    bank: "yes",
    bankNote: "Solo 1 banco",
  },
  {
    feature: "Funciona en WhatsApp",
    neto: "yes",
    manual: "no",
    bank: "no",
  },
  {
    feature: "Sin descargar app",
    neto: "yes",
    manual: "no",
    bank: "no",
  },
  {
    feature: "Multi-banco (11 bancos)",
    neto: "yes",
    manual: "partial",
    bank: "no",
    manualNote: "Manual",
    bankNote: "Solo 1",
  },
  {
    feature: "Yape y Plin integrados",
    neto: "yes",
    manual: "no",
    bank: "no",
  },
  {
    feature: "IA categoriza automáticamente",
    neto: "yes",
    manual: "no",
    bank: "partial",
    bankNote: "Básico",
  },
  {
    feature: "Dashboard web interactivo",
    neto: "yes",
    manual: "partial",
    bank: "partial",
    manualNote: "En app",
    bankNote: "Limitado",
  },
  {
    feature: "Score financiero personalizado",
    neto: "yes",
    manual: "no",
    bank: "no",
  },
  {
    feature: "Lectura de imágenes Yape/Plin",
    neto: "yes",
    manual: "no",
    bank: "no",
  },
  {
    feature: "Sin contraseña bancaria",
    neto: "yes",
    manual: "yes",
    bank: "no",
    bankNote: "Requiere login",
  },
];

function CellIcon({ value, note }: { value: "yes" | "partial" | "no"; note?: string }) {
  if (value === "yes") {
    return (
      <div className="flex flex-col items-center gap-1">
        <div className="w-6 h-6 rounded-full bg-[#1D9E75]/20 flex items-center justify-center">
          <Check size={14} className="text-[#68dbae]" />
        </div>
      </div>
    );
  }
  if (value === "partial") {
    return (
      <div className="flex flex-col items-center gap-1">
        <div className="w-6 h-6 rounded-full bg-[#EF9F27]/15 flex items-center justify-center">
          <Minus size={14} className="text-[#EF9F27]" />
        </div>
        {note && <span className="text-[10px] text-[#87948c]">{note}</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-6 h-6 rounded-full bg-[#2A2A28] flex items-center justify-center">
        <X size={14} className="text-[#87948c]/40" />
      </div>
      {note && <span className="text-[10px] text-[#87948c]">{note}</span>}
    </div>
  );
}

export default function Comparison() {
  return (
    <section className="py-28 relative overflow-hidden">
      <div className="absolute bottom-[10%] left-[20%] w-[500px] h-[500px] -z-10 rounded-full bg-[#1D9E75]/[0.03] blur-[120px]" />

      <div className="mx-auto max-w-[900px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full bg-[#1D9E75]/10 px-5 py-2 text-xs font-medium text-[#68dbae] mb-6 tracking-wide">
            Comparativa
          </span>
          <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight mb-5">
            <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
              ¿Por qué Neto y no
            </span>
            <br />
            <span className="bg-gradient-to-r from-[#68dbae] to-[#1D9E75] bg-clip-text text-transparent">
              otra alternativa?
            </span>
          </h2>
          <p className="text-[#87948c] max-w-[520px] mx-auto text-lg leading-relaxed">
            El único asistente que lee tus 11 bancos peruanos automáticamente y te resume todo por WhatsApp.
          </p>
        </div>

        {/* Comparison table */}
        <div className="rounded-[24px] bg-[#1C1C19] overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_80px_80px_80px] min-[640px]:grid-cols-[1fr_120px_120px_120px] items-center gap-2 px-5 min-[640px]:px-8 py-5 border-b border-white/5">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#87948c]">
              Funcionalidad
            </span>
            <span className="text-center">
              <span className="text-sm font-bold text-[#68dbae]">Neto</span>
            </span>
            <span className="text-center text-xs text-[#87948c]">
              Apps<br />manuales
            </span>
            <span className="text-center text-xs text-[#87948c]">
              App de<br />tu banco
            </span>
          </div>

          {/* Rows */}
          {ROWS.map((row, i) => (
            <div
              key={row.feature}
              className={`grid grid-cols-[1fr_80px_80px_80px] min-[640px]:grid-cols-[1fr_120px_120px_120px] items-center gap-2 px-5 min-[640px]:px-8 py-4 ${
                i < ROWS.length - 1 ? "border-b border-white/[0.03]" : ""
              } ${i % 2 === 0 ? "" : "bg-white/[0.01]"}`}
            >
              <span className="text-sm text-[#bccac1]">{row.feature}</span>
              <div className="flex justify-center">
                <CellIcon value={row.neto} note={row.netoNote} />
              </div>
              <div className="flex justify-center">
                <CellIcon value={row.manual} note={row.manualNote} />
              </div>
              <div className="flex justify-center">
                <CellIcon value={row.bank} note={row.bankNote} />
              </div>
            </div>
          ))}
        </div>

        {/* Bottom note */}
        <p className="text-center text-sm text-[#87948c] mt-8">
          Apps manuales: Monefy, Mobills, Fintonic y similares. App del banco: BCP, BBVA, Interbank, etc.
        </p>
      </div>
    </section>
  );
}
