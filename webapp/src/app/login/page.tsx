'use client';

import Image from 'next/image';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
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

function AuthErrorBanner() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  if (searchParams.get('error') !== 'auth') return null;

  async function handleMagicLink() {
    if (!email.trim()) return;
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setSent(true);
    setLoading(false);
  }

  return (
    <div className="mb-6 rounded-xl bg-[rgba(216,90,48,0.08)] border border-[rgba(216,90,48,0.2)] px-4 py-4 space-y-3">
      <p className="text-sm text-[#D85A30]">
        No pudimos verificar tu sesión con Google. Ingresa tu email y te enviamos un enlace de acceso directo.
      </p>
      {sent ? (
        <p className="text-sm text-[#1D9E75] font-medium">
          ✓ Enlace enviado — revisa tu correo y haz click en el link.
        </p>
      ) : (
        <div className="flex gap-2">
          <input
            type="email"
            placeholder="tu@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleMagicLink()}
            className="flex-1 rounded-lg bg-[rgba(255,255,255,0.06)] border border-[rgba(216,90,48,0.3)] px-3 py-2 text-sm text-[#F0EFE8] placeholder-[#8A877D] outline-none focus:border-[#D85A30]"
          />
          <button
            onClick={handleMagicLink}
            disabled={loading || !email.trim()}
            className="rounded-lg bg-[#D85A30] px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-[#D85A30]/90 transition-colors shrink-0"
          >
            {loading ? '...' : 'Enviar enlace'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {

  const handleGoogleLogin = async () => {
    const supabase = createClient();
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    const callbackUrl = redirect
      ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirect)}`
      : `${window.location.origin}/auth/callback`;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callbackUrl,
      },
    });
  };

  return (
    <div className="flex min-h-screen bg-[#0E0E0C]">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,rgba(29,158,117,0.06)_0%,transparent_70%)] pointer-events-none" />
      {/* Left side — Login */}
      <div className="flex w-full flex-col items-center justify-center px-6 py-12 lg:w-[45%] lg:px-16">
        <motion.div
          className="w-full max-w-md glass-card-glow glass-card-depth"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
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
            Tus finanzas en piloto automático
          </h1>
          <p className="mb-8 text-[#8A877D]">
            Neto lee tus correos bancarios y organiza todo automáticamente. Sin anotar nada.
          </p>

          {/* Auth error banner */}
          <Suspense>
            <AuthErrorBanner />
          </Suspense>

          {/* ── Existing users: Google login ── */}
          <div className="mb-2">
            <p className="text-xs font-medium text-[#8A877D] uppercase tracking-wider mb-3">
              ¿Ya tienes cuenta?
            </p>
            <motion.button
              onClick={handleGoogleLogin}
              className="flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl bg-[#1D9E75] px-6 py-4 text-base font-medium text-white shadow-lg shadow-[#1D9E75]/20 transition-all duration-200 hover:bg-[#1D9E75]/90 hover:shadow-[#1D9E75]/30 hover:shadow-[0_0_20px_rgba(29,158,117,0.15)]"
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.98 }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#fff" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#fff" opacity={0.8} />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#fff" opacity={0.6} />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#fff" opacity={0.8} />
              </svg>
              Iniciar sesión con Google
            </motion.button>
          </div>

          {/* Divider */}
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-white/[0.06]" />
            <span className="text-xs text-[#8A877D]">o</span>
            <div className="h-px flex-1 bg-white/[0.06]" />
          </div>

          {/* ── New users: WhatsApp registration ── */}
          <div>
            <p className="text-xs font-medium text-[#8A877D] uppercase tracking-wider mb-3">
              ¿Aún no tienes cuenta?
            </p>
            <a
              href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B"
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#1D9E75]/30 bg-[#1D9E75]/[0.08] px-6 py-4 text-base font-medium text-[#1D9E75] transition-all hover:bg-[#1D9E75]/[0.15] hover:border-[#1D9E75]/50"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="#25D366">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
              Regístrate por WhatsApp
            </a>
            <p className="mt-2 text-center text-xs text-[#8A877D]">
              Te guiamos paso a paso en 2 minutos
            </p>
          </div>

          {/* Security badge */}
          <div className="mt-6 flex items-center justify-center gap-2 text-[#8A877D]">
            <Shield className="h-3.5 w-3.5" />
            <p className="text-xs">
              Conexión segura · Datos encriptados · Sin contraseñas bancarias
            </p>
          </div>

          {/* Mobile-only benefits (hidden on desktop where right panel shows features) */}
          <div className="mt-4 flex flex-col gap-2 lg:hidden">
            {[
              { emoji: '🤖', text: 'Tus gastos se registran solos' },
              { emoji: '🏦', text: 'Conecta BCP, BBVA, Interbank y más' },
              { emoji: '📊', text: 'Dashboard con gráficos y score financiero' },
            ].map((b) => (
              <div key={b.text} className="flex items-center gap-2.5 rounded-lg bg-white/[0.02] px-3 py-2">
                <span className="text-sm">{b.emoji}</span>
                <span className="text-xs text-[#C8C6BC]">{b.text}</span>
              </div>
            ))}
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
        </motion.div>
      </div>

      {/* Right side — Features showcase (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-[55%] flex-col justify-center bg-gradient-to-br from-[#141412] via-[#0E0E0C] to-[#0a1a14] px-16 relative overflow-hidden">
        {/* Decorative gradient orbs */}
        <div className="absolute top-1/4 right-1/4 h-[400px] w-[400px] rounded-full bg-[#1D9E75]/[0.07] blur-[120px]" />
        <div className="absolute bottom-1/4 left-1/4 h-[300px] w-[300px] rounded-full bg-[#EF9F27]/[0.05] blur-[100px]" />

        {/* Content */}
        <motion.div
          className="relative z-10 max-w-lg"
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, delay: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          <h2 className="mb-3 text-2xl font-bold text-[#F0EFE8]">
            Toma el control de tus finanzas
          </h2>
          <p className="mb-10 text-[#8A877D]">
            NETO conecta tus correos bancarios y WhatsApp para darte una visión completa de tu dinero.
          </p>

          {/* Feature grid */}
          <div className="grid grid-cols-2 gap-4">
            {features.map((f, i) => (
              <motion.div
                key={f.title}
                className="group rounded-xl border border-white/[0.04] bg-white/[0.02] p-4 backdrop-blur-sm transition-all hover:border-[#1D9E75]/20 hover:bg-white/[0.04]"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.3 + i * 0.08 }}
              >
                <f.icon className="mb-3 h-6 w-6 text-[#1D9E75] transition-transform group-hover:scale-110" />
                <h3 className="mb-1 text-sm font-semibold text-[#F0EFE8]">{f.title}</h3>
                <p className="text-xs leading-relaxed text-[#8A877D]">{f.desc}</p>
              </motion.div>
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
              +100 usuarios en Perú ya controlan sus gastos con NETO
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
