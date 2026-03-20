const PRODUCT_LINKS = [
  { label: "Cómo funciona", href: "#como-funciona" },
  { label: "Precios", href: "#precios" },
  { label: "FAQ", href: "/faq" },
];

const CONTACT_LINKS = [
  { label: "hola@neto.pe", href: "mailto:hola@neto.pe" },
  {
    label: "WhatsApp",
    href: "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B",
  },
];

const LEGAL_LINKS = [
  { label: "Privacidad", href: "/privacidad" },
  { label: "Términos", href: "/terminos" },
];

function FooterLogo() {
  return (
    <div className="flex items-center gap-2 mb-4">
      <svg
        width="28"
        height="28"
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
          fontFamily="Space Grotesk, sans-serif"
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
    </div>
  );
}

export default function Footer() {
  return (
    <footer className="bg-neto-bg2 border-t border-white/5">
      <div className="mx-auto max-w-[1200px] px-6 py-16">
        <div className="grid grid-cols-2 min-[860px]:grid-cols-4 gap-10">
          {/* Brand */}
          <div className="col-span-2 min-[860px]:col-span-1">
            <FooterLogo />
            <p className="text-sm text-neto-txt3 leading-relaxed max-w-[260px]">
              Tu asistente financiero personal por WhatsApp. Hecho en Perú.
            </p>
          </div>

          {/* Producto */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Producto</h4>
            <ul className="space-y-2.5">
              {PRODUCT_LINKS.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    className="text-sm text-neto-txt3 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Contacto */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Contacto</h4>
            <ul className="space-y-2.5">
              {CONTACT_LINKS.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    target={l.href.startsWith("http") ? "_blank" : undefined}
                    rel={
                      l.href.startsWith("http")
                        ? "noopener noreferrer"
                        : undefined
                    }
                    className="text-sm text-neto-txt3 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Legal</h4>
            <ul className="space-y-2.5">
              {LEGAL_LINKS.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    className="text-sm text-neto-txt3 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-white/5">
        <div className="mx-auto max-w-[1200px] px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-neto-txt3">
            &copy; 2026 Neto &middot; Lima, Perú
          </p>
          <div className="flex gap-6">
            <a
              href="/privacidad"
              className="text-xs text-neto-txt3 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
            >
              Privacidad
            </a>
            <a
              href="/terminos"
              className="text-xs text-neto-txt3 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
            >
              Términos
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
