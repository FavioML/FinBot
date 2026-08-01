'use client';

import Link from 'next/link';
import Image from 'next/image';
import { motion } from 'motion/react';
import { Home, ArrowLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0E0E0C] px-6 text-center">
      {/* Logo */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="mb-6 flex items-center justify-center gap-3">
          <Image
            src="/neto-icon.png"
            alt="NETO"
            width={56}
            height={56}
            priority
            className="h-14 w-14 rounded-xl object-contain"
          />
          <span className="text-xl font-bold text-[#F0EFE8]">NETO</span>
        </div>
      </motion.div>

      {/* 404 number */}
      <motion.h1
        className="text-7xl font-bold text-[#1D9E75] mb-2"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
      >
        404
      </motion.h1>

      {/* Message */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        <h2 className="text-xl font-semibold text-[#F0EFE8] mb-2">
          Pagina no encontrada
        </h2>
        <p className="text-sm text-[#8A877D] max-w-sm mb-8">
          La pagina que buscas no existe o fue movida. Vuelve al inicio para seguir controlando tus finanzas.
        </p>
      </motion.div>

      {/* Actions */}
      <motion.div
        className="flex flex-col sm:flex-row gap-3"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
      >
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 rounded-xl bg-[#1D9E75] px-6 py-3 text-sm font-medium text-white shadow-lg shadow-[#1D9E75]/20 transition-all hover:bg-[#1D9E75]/90 hover:shadow-[#1D9E75]/30"
        >
          <Home className="h-4 w-4" />
          Ir al dashboard
        </Link>
        <button
          onClick={() => window.history.back()}
          className="inline-flex items-center gap-2 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-6 py-3 text-sm font-medium text-[#C8C6BC] transition-all hover:bg-[rgba(255,255,255,0.06)]"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver atras
        </button>
      </motion.div>
    </div>
  );
}
