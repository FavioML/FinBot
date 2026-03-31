"use client";
import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const STORAGE_KEY = "neto_exit_shown";

export default function ExitIntent() {
  const [visible, setVisible] = useState(false);

  const dismiss = useCallback(() => {
    setVisible(false);
  }, []);

  useEffect(() => {
    if (sessionStorage.getItem(STORAGE_KEY)) return;

    const handleMouseLeave = (e: MouseEvent) => {
      if (e.clientY <= 0) {
        if (sessionStorage.getItem(STORAGE_KEY)) return;
        sessionStorage.setItem(STORAGE_KEY, "1");
        setVisible(true);
      }
    };

    document.addEventListener("mouseleave", handleMouseLeave);
    return () => document.removeEventListener("mouseleave", handleMouseLeave);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center px-4"
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
      aria-label="¿Te vas sin ordenar tu plata?"
    >
      <div
        className="relative max-w-[460px] w-full rounded-[28px] bg-neto-bg2 border border-white/10 p-8 shadow-[0_32px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Green glow */}
        <div className="absolute inset-0 rounded-[28px] overflow-hidden pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-neto-green/15 blur-[50px] rounded-full" />
        </div>

        {/* Close button */}
        <button
          onClick={dismiss}
          className="absolute top-4 right-4 w-8 h-8 rounded-full bg-neto-bg3 flex items-center justify-center text-neto-txt2 hover:text-neto-txt transition-colors duration-200"
          aria-label="Cerrar"
        >
          <X size={16} />
        </button>

        {/* Content */}
        <div className="relative flex flex-col items-center text-center">
          <span className="text-4xl mb-5">💸</span>
          <h3 className="text-2xl font-bold text-neto-txt mb-3">
            ¿Te vas sin ordenar tu plata?
          </h3>
          <p className="text-neto-txt3 text-sm mb-6 leading-relaxed">
            Tus gastos se siguen acumulando. Neto los organiza por ti — en 2 minutos, gratis, sin
            contraseñas bancarias.
          </p>

          <a
            href={WA_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full rounded-full bg-gradient-to-r from-neto-green to-neto-green-dark px-6 py-3 text-sm font-semibold text-white hover:opacity-90 transition-opacity duration-200 text-center"
          >
            Empezar gratis ahora
          </a>

          <p
            onClick={dismiss}
            className="text-xs text-neto-txt3 text-center cursor-pointer hover:text-neto-txt2 transition-colors duration-200 mt-3"
          >
            No, prefiero seguir sin control de mis gastos
          </p>
        </div>
      </div>
    </div>
  );
}
