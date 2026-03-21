"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const NAV_LINKS = [
  { label: "Cómo funciona", href: "#como-funciona" },
  { label: "Precios", href: "#precios" },
  { label: "FAQ", href: "/faq" },
  { label: "Contacto", href: "mailto:hola@neto.pe" },
];

function NetoLogo() {
  return (
    <a href="/" className="flex items-center gap-2 cursor-pointer">
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="8" fill="#1D9E75" />
        <text
          x="8"
          y="23"
          fill="white"
          fontFamily="Manrope, sans-serif"
          fontWeight="700"
          fontSize="20"
        >
          N
        </text>
        <path
          d="M6 22 Q12 18 16 20 Q20 22 26 12"
          stroke="#EF9F27"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <span className="text-neto-green font-semibold text-lg tracking-tight">
        neto
      </span>
    </a>
  );
}

export default function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="fixed top-0 inset-x-0 z-50 bg-neto-bg/92 backdrop-blur-2xl border-b border-white/5">
      <div className="mx-auto max-w-[1200px] px-6 h-16 flex items-center justify-between">
        <NetoLogo />

        {/* Desktop links */}
        <div className="hidden min-[860px]:flex items-center gap-8">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm text-neto-txt2 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
            >
              {l.label}
            </a>
          ))}
          <a
            href={WA_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-neto-green px-5 py-2 text-sm font-medium text-white hover:bg-neto-green-dark transition-colors duration-200 cursor-pointer"
          >
            Empezar gratis
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          onClick={() => setOpen(!open)}
          className="min-[860px]:hidden text-neto-txt2 hover:text-neto-txt cursor-pointer"
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
        >
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="min-[860px]:hidden bg-neto-bg2 border-b border-white/5 px-6 py-6 flex flex-col gap-4">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="text-sm text-neto-txt2 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
            >
              {l.label}
            </a>
          ))}
          <a
            href={WA_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-neto-green px-5 py-2.5 text-sm font-medium text-white text-center hover:bg-neto-green-dark transition-colors duration-200 cursor-pointer"
          >
            Empezar gratis
          </a>
        </div>
      )}
    </nav>
  );
}
