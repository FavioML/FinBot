'use client';

import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';
import {
  BarChart3,
  PieChart,
  Wallet,
  TrendingUp,
  Shield,
  Bell,
} from 'lucide-react';

const features = [
  { icon: BarChart3, title: 'Dashboard interactivo', desc: 'Visualiza tus ingresos y gastos en tiempo real' },
  { icon: PieChart, title: 'Reportes detallados', desc: 'Gráficos por categoría, método de pago y más' },
  { icon: Wallet, title: 'Presupuestos inteligentes', desc: 'Controla límites por categoría y subcategoría' },
  { icon: TrendingUp, title: 'Score financiero', desc: 'Mide tu salud financiera con un puntaje de 0 a 100' },
  { icon: Shield, title: 'Seguro y privado', desc: 'Tus datos protegidos con encriptación bancaria' },
  { icon: Bell, title: 'Alertas automáticas', desc: 'Notificaciones cuando te acerques a tus límites' },
];

export default function LoginPage() {
  const handleGoogleLogin = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <div className="flex min-h-screen bg-[#0E0E0C]">
      {/* Left side — Login */}
      <div className="flex w-full flex-col items-center justify-center px-6 py-12 lg:w-[45%] lg:px-16">
        <div className="w-full max-w-md">
          {/* Logo */}
          <div className="mb-12 flex items-center gap-3">
            <Image
              src="/neto-logo.png"
              alt="NETO"
              width={56}
              height={56}
              priority
              className="h-14 w-14 object-contain"
            />
            <div>
              <h2 className="text-xl font-bold text-[#F0EFE8]">NETO</h2>
              <p className="text-sm text-[#8A877D]">Tu asistente financiero</p>
            </div>
          </div>

          {/* Welcome text */}
          <h1 className="mb-2 text-3xl font-bold text-[#F0EFE8]">
            Bienvenido
          </h1>
          <p className="mb-8 text-[#8A877D]">
            Inicia sesión para acceder a tu panel financiero personal
          </p>

          {/* Google button */}
          <button
            onClick={handleGoogleLogin}
            className="flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl bg-[#1D9E75] px-6 py-4 text-base font-medium text-white shadow-lg shadow-[#1D9E75]/20 transition-all hover:bg-[#1D9E75]/90 hover:shadow-[#1D9E75]/30 active:scale-[0.98]"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#fff" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#fff" opacity={0.8} />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#fff" opacity={0.6} />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#fff" opacity={0.8} />
            </svg>
            Continuar con Google
          </button>

          {/* Divider */}
          <div className="my-8 flex items-center gap-3">
            <div className="h-px flex-1 bg-white/[0.06]" />
            <span className="text-xs text-[#8A877D]">o</span>
            <div className="h-px flex-1 bg-white/[0.06]" />
          </div>

          {/* Info */}
          <p className="text-center text-sm text-[#8A877D]">
            Al continuar con Google, podrás registrarte o iniciar sesión
          </p>

          {/* WhatsApp alternative */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
            <p className="text-sm text-[#C8C6BC]">
              ¿Prefieres usar solo WhatsApp?{' '}
              <a
                href="https://wa.me/51933014505"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-[#1D9E75] transition-colors hover:text-[#1D9E75]/80"
              >
                Escríbenos al +51 933 014 505
              </a>
            </p>
          </div>

          {/* Footer */}
          <footer className="mt-12 flex items-center justify-center gap-4 text-xs text-[#8A877D]">
            <a href="https://neto.pe" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[#C8C6BC]">
              neto.pe
            </a>
            <span className="text-white/[0.06]">|</span>
            <a href="/privacidad" className="transition-colors hover:text-[#C8C6BC]">Privacidad</a>
            <span className="text-white/[0.06]">|</span>
            <a href="/terminos" className="transition-colors hover:text-[#C8C6BC]">Términos</a>
          </footer>
        </div>
      </div>

      {/* Right side — Features showcase (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-[55%] flex-col justify-center bg-gradient-to-br from-[#141412] via-[#0E0E0C] to-[#0a1a14] px-16 relative overflow-hidden">
        {/* Decorative gradient orbs */}
        <div className="absolute top-1/4 right-1/4 h-[400px] w-[400px] rounded-full bg-[#1D9E75]/[0.07] blur-[120px]" />
        <div className="absolute bottom-1/4 left-1/4 h-[300px] w-[300px] rounded-full bg-[#EF9F27]/[0.05] blur-[100px]" />

        {/* Content */}
        <div className="relative z-10 max-w-lg">
          <h2 className="mb-3 text-2xl font-bold text-[#F0EFE8]">
            Toma el control de tus finanzas
          </h2>
          <p className="mb-10 text-[#8A877D]">
            NETO conecta tus correos bancarios y WhatsApp para darte una visión completa de tu dinero.
          </p>

          {/* Feature grid */}
          <div className="grid grid-cols-2 gap-4">
            {features.map((f) => (
              <div
                key={f.title}
                className="group rounded-xl border border-white/[0.04] bg-white/[0.02] p-4 backdrop-blur-sm transition-all hover:border-[#1D9E75]/20 hover:bg-white/[0.04]"
              >
                <f.icon className="mb-3 h-6 w-6 text-[#1D9E75] transition-transform group-hover:scale-110" />
                <h3 className="mb-1 text-sm font-semibold text-[#F0EFE8]">{f.title}</h3>
                <p className="text-xs leading-relaxed text-[#8A877D]">{f.desc}</p>
              </div>
            ))}
          </div>

          {/* Social proof */}
          <div className="mt-10 flex items-center gap-4">
            <div className="flex -space-x-2">
              {['bg-[#1D9E75]', 'bg-[#EF9F27]', 'bg-[#3B82F6]', 'bg-[#D85A30]'].map((bg, i) => (
                <div key={i} className={`h-8 w-8 rounded-full ${bg} border-2 border-[#0E0E0C] flex items-center justify-center text-[10px] text-white font-bold`}>
                  {['FM', 'AC', 'JR', 'LP'][i]}
                </div>
              ))}
            </div>
            <p className="text-sm text-[#8A877D]">
              Usuarios en Perú ya controlan sus gastos con NETO
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
