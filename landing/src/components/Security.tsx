"use client";

import { Shield, Eye, Lock, KeyRound, ServerCrash, Fingerprint } from "lucide-react";

const SECURITY_POINTS = [
  {
    Icon: Eye,
    title: "Solo lectura de correos bancarios",
    desc: "Neto accede unicamente a correos de notificacion de 11 bancos. Nunca tus correos personales, laborales ni ningun otro tipo.",
  },
  {
    Icon: KeyRound,
    title: "Cero contrasenas bancarias",
    desc: "Nunca pedimos usuario ni contrasena de tu banco. No accedemos a tu banca en linea. Solo leemos lo que tu banco ya te envia por correo.",
  },
  {
    Icon: Lock,
    title: "Datos encriptados",
    desc: "Toda la comunicacion esta encriptada en transito (TLS). Tus datos financieros se almacenan con Row-Level Security en Supabase.",
  },
  {
    Icon: Fingerprint,
    title: "Login con Google OAuth",
    desc: "No guardamos contrasenas. Tu cuenta se autentica directamente con Google. Puedes revocar el acceso en cualquier momento.",
  },
  {
    Icon: ServerCrash,
    title: "Tu tienes el control",
    desc: "Revoca el acceso de Neto a tu Gmail cuando quieras desde myaccount.google.com/permissions. Tus datos se eliminan si lo solicitas.",
  },
  {
    Icon: Shield,
    title: "Hecho en Peru, para peruanos",
    desc: "Somos un producto peruano con soporte local. Tu plata y tus datos se quedan contigo — nunca vendemos informacion a terceros.",
  },
];

export default function Security() {
  return (
    <section className="py-28 relative overflow-hidden">
      <div className="absolute top-[20%] right-[15%] w-[400px] h-[400px] -z-10 rounded-full bg-[#EF9F27]/[0.03] blur-[100px]" />

      <div className="mx-auto max-w-[1100px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full bg-[#EF9F27]/10 px-5 py-2 text-xs font-medium text-[#EF9F27] mb-6 tracking-wide">
            Seguridad
          </span>
          <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight mb-5">
            <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
              Tu plata es tuya.
            </span>
            <br />
            <span className="bg-gradient-to-r from-[#EF9F27] to-[#D4860E] bg-clip-text text-transparent">
              Tus datos tambien.
            </span>
          </h2>
          <p className="text-[#87948c] max-w-[520px] mx-auto text-lg leading-relaxed">
            Neto esta disenado con seguridad desde el primer dia. Asi es como protegemos tu informacion.
          </p>
        </div>

        {/* Security grid */}
        <div className="grid grid-cols-1 min-[640px]:grid-cols-2 min-[1024px]:grid-cols-3 gap-4">
          {SECURITY_POINTS.map((point) => {
            const { Icon } = point;
            return (
              <div
                key={point.title}
                className="group rounded-[20px] bg-[#1C1C19] p-7 transition-all duration-300 hover:bg-[#20201d] cursor-default"
              >
                <div className="w-11 h-11 rounded-xl bg-[#EF9F27]/10 flex items-center justify-center mb-5">
                  <Icon size={22} className="text-[#EF9F27]" />
                </div>
                <h3 className="text-base font-semibold text-[#e5e2de] mb-2">
                  {point.title}
                </h3>
                <p className="text-sm text-[#87948c] leading-relaxed">
                  {point.desc}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
