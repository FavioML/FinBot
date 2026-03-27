"use client";

import { useState, useEffect } from "react";
import { ArrowRight } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

export default function StickyCTA() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 min-[860px]:bottom-6 min-[860px]:inset-x-auto min-[860px]:right-6 min-[860px]:left-auto animate-fade-up">
      {/* Mobile: full-width bottom bar */}
      <div className="min-[860px]:hidden bg-[#131311]/95 backdrop-blur-xl border-t border-white/5 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[#e5e2de] truncate">
            Ordena tu plata sin mover un dedo
          </p>
          <p className="text-xs text-[#87948c]">Desde S/10/mes</p>
        </div>
        <a
          href={WA_LINK}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-br from-[#68dbae] to-[#26a37a] px-5 py-2.5 text-sm font-semibold text-[#002115] cursor-pointer"
        >
          Empezar
          <ArrowRight size={14} />
        </a>
      </div>

      {/* Desktop: floating pill button */}
      <a
        href={WA_LINK}
        target="_blank"
        rel="noopener noreferrer"
        className="hidden min-[860px]:inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-[#68dbae] to-[#26a37a] px-6 py-3.5 text-sm font-semibold text-[#002115] shadow-[0_8px_32px_rgba(29,158,117,0.3)] hover:shadow-[0_8px_48px_rgba(29,158,117,0.45)] hover:scale-[1.02] transition-all duration-300 cursor-pointer"
      >
        Regístrate en 2 minutos
        <ArrowRight size={16} />
      </a>
    </div>
  );
}
