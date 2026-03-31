"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Message {
  id: number;
  from: "neto" | "user";
  text: string;
}

const MESSAGES: Message[] = [
  { id: 0, from: "neto", text: "¡Hola! 👋 Soy Neto, tu asistente financiero." },
  { id: 1, from: "neto", text: "Acabo de leer tu correo del BCP." },
  { id: 2, from: "neto", text: "Rappi · S/45.00 · Comida 🍔\nLlevas S/847 esta semana.\nTe quedan S/403 de tu presupuesto." },
  { id: 3, from: "neto", text: "💡 Tip: Llevas 3 pedidos de delivery esta semana. ¿Quieres que te avise cuando pases de S/200 en delivery?" },
  { id: 4, from: "user", text: "Sí porfa" },
  { id: 5, from: "neto", text: "Listo ✅ Te avisaré. ¡Sigue así!" },
];

const SEQUENCE_TIMINGS = [600, 2000, 3500, 6500, 8500, 10000];
const TYPING_SHOW = 5200;
const TYPING_HIDE = 6500;
const RESET_DELAY = 13000;

export default function ChatSimulator() {
  const [visibleCount, setVisibleCount] = useState<number>(0);
  const [showTyping, setShowTyping] = useState<boolean>(false);

  const runSequence = useCallback(() => {
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    SEQUENCE_TIMINGS.forEach((delay, index) => {
      timeouts.push(
        setTimeout(() => {
          setVisibleCount(index + 1);
        }, delay)
      );
    });

    timeouts.push(
      setTimeout(() => {
        setShowTyping(true);
      }, TYPING_SHOW)
    );

    timeouts.push(
      setTimeout(() => {
        setShowTyping(false);
      }, TYPING_HIDE)
    );

    timeouts.push(
      setTimeout(() => {
        setVisibleCount(0);
        setShowTyping(false);
      }, RESET_DELAY)
    );

    return timeouts;
  }, []);

  useEffect(() => {
    let timeouts: ReturnType<typeof setTimeout>[] = [];

    const start = () => {
      timeouts = runSequence();
    };

    start();

    const loopInterval = setInterval(() => {
      timeouts.forEach(clearTimeout);
      setVisibleCount(0);
      setShowTyping(false);
      setTimeout(() => {
        timeouts = runSequence();
      }, 100);
    }, RESET_DELAY + 500);

    return () => {
      timeouts.forEach(clearTimeout);
      clearInterval(loopInterval);
    };
  }, [runSequence]);

  const visibleMessages = MESSAGES.slice(0, visibleCount);

  return (
    <div
      className="animate-float rounded-[44px] bg-neto-bg2 border border-neto-bg5 shadow-[0_40px_120px_rgba(0,0,0,0.6)] flex flex-col overflow-hidden"
      style={{ width: "320px", height: "580px" }}
    >
      {/* WhatsApp Header */}
      <div className="bg-[#075E54] rounded-t-[40px] px-4 py-3 flex items-center gap-3 shrink-0">
        <div className="w-9 h-9 rounded-full bg-neto-green flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-sm">N</span>
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-white font-semibold text-sm leading-tight">Neto 🟢</span>
          <span className="text-white/70 text-xs leading-tight">en línea</span>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-hidden bg-[#0B1114] px-4 py-4 flex flex-col gap-3 justify-end">
        <AnimatePresence initial={false}>
          {visibleMessages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className={
                msg.from === "neto"
                  ? "rounded-[18px] rounded-tl-[4px] bg-neto-bg3 text-neto-txt2 text-sm px-4 py-2.5 max-w-[85%] mr-auto leading-relaxed whitespace-pre-line"
                  : "rounded-[18px] rounded-tr-[4px] bg-[#005C4B] text-white text-sm px-4 py-2.5 max-w-[85%] ml-auto whitespace-pre-line"
              }
            >
              {msg.text}
            </motion.div>
          ))}

          {showTyping && (
            <motion.div
              key="typing"
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="rounded-[18px] rounded-tl-[4px] bg-neto-bg3 px-4 py-3 max-w-[85%] mr-auto flex items-center gap-1.5"
            >
              {[0, 0.2, 0.4].map((delay, i) => (
                <span
                  key={i}
                  className="w-2 h-2 rounded-full bg-neto-txt3 animate-pulse-dot"
                  style={{ animationDelay: `${delay}s` }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom Bar */}
      <div className="bg-[#1F2C34] rounded-b-[40px] px-4 py-3 shrink-0">
        <div className="bg-[#2A3942] rounded-full px-4 py-2.5 flex items-center">
          <span className="text-[#8696A0] text-sm select-none">Escribe un mensaje</span>
        </div>
      </div>
    </div>
  );
}
