"use client";

import { useEffect, useState, useCallback } from "react";
import { X, Calculator, ArrowRight } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20calcular%20mis%20gastos%20hormiga%20%F0%9F%90%9C";

const STORAGE_KEY = "neto_exit_shown";

export default function ExitIntent() {
  const [show, setShow] = useState(false);

  const handleClose = useCallback(() => {
    setShow(false);
    try {
      sessionStorage.setItem(STORAGE_KEY, "1");
    } catch {}
  }, []);

  useEffect(() => {
    // Don't show if already shown this session
    try {
      if (sessionStorage.getItem(STORAGE_KEY)) return;
    } catch {}

    // Desktop: mouse leaves viewport from top
    const handleMouseLeave = (e: MouseEvent) => {
      if (e.clientY <= 0) {
        setShow(true);
        document.removeEventListener("mouseout", handleMouseLeave);
      }
    };

    // Mobile: detect back/scroll-up intent after 30s on page
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      // Show after user scrolls past 50% then scrolls back up significantly
      const scrollPercent = window.scrollY / (document.body.scrollHeight - window.innerHeight);
      if (scrollPercent < 0.3 && window.scrollY > 200) {
        setShow(true);
        window.removeEventListener("scroll", handleScroll);
      }
    };

    // Delay listeners to avoid triggering immediately
    timer = setTimeout(() => {
      document.addEventListener("mouseout", handleMouseLeave);
      // Only add scroll listener on mobile
      if (window.innerWidth < 860) {
        window.addEventListener("scroll", handleScroll, { passive: true });
      }
    }, 15000); // Wait 15s before arming

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("mouseout", handleMouseLeave);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onClick={handleClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-md rounded-3xl bg-[#1C1C19] border border-white/10 p-8 text-center animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 text-[#87948c] hover:text-[#e5e2de] transition-colors"
          aria-label="Cerrar"
        >
          <X size={20} />
        </button>

        {/* Icon */}
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#EF9F27]/15">
          <Calculator className="h-8 w-8 text-[#EF9F27]" />
        </div>

        {/* Headline */}
        <h3 className="text-2xl font-bold text-[#e5e2de] mb-3">
          ¿Sabías que gastas ~S/350/mes sin darte cuenta?
        </h3>

        {/* Subtext */}
        <p className="text-[#87948c] text-sm leading-relaxed mb-6 max-w-xs mx-auto">
          Los gastos hormiga (café, delivery, taxi) suman más de lo que crees.
          Descubre cuánto pierdes cada mes — por WhatsApp.
        </p>

        {/* CTA */}
        <a
          href={WA_LINK}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleClose}
          className="inline-flex items-center gap-2 rounded-full bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white font-semibold px-8 py-3.5 transition-colors"
        >
          Calcular mis gastos hormiga
          <ArrowRight size={16} />
        </a>

        {/* Dismiss text */}
        <p className="text-xs text-[#87948c]/60 mt-4">
          Sin costo · Sin descargar nada · 2 minutos
        </p>
      </div>
    </div>
  );
}
