"use client";
import { useState, useEffect } from "react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

export default function StickyCTA() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPct = docHeight > 0 ? scrollY / docHeight : 0;
      setVisible(scrollY > 400 && scrollPct < 0.7);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div
      id="sticky-cta"
      className={`fixed bottom-0 inset-x-0 z-40 transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"
      }`}
      aria-hidden={!visible}
    >
      <div className="bg-neto-bg/90 backdrop-blur-xl border-t border-white/5 shadow-[0_-8px_40px_rgba(0,0,0,0.4)]">
        <div className="mx-auto max-w-[1200px] px-6 py-3 flex items-center justify-between gap-4">
          {/* Left: logo + tagline (hidden on mobile) */}
          <div className="hidden sm:flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-icon.svg" alt="Neto" width={24} height={24} className="rounded-md" />
            <span className="text-sm text-neto-txt2">Ordena tu plata sin mover un dedo</span>
          </div>

          {/* CTA button */}
          <a
            href={WA_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto rounded-full bg-gradient-to-r from-neto-green to-neto-green-dark px-6 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity duration-200 whitespace-nowrap"
          >
            Empezar gratis →
          </a>
        </div>
      </div>
    </div>
  );
}
