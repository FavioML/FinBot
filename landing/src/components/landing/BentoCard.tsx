"use client";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

interface BentoCardProps {
  title: string;
  desc: string;
  visual: ReactNode;
  className?: string;
  size?: "large" | "small";
}

export function BentoCard({
  title,
  desc,
  visual,
  className = "",
  size = "small",
}: BentoCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`group relative rounded-[24px] bg-neto-bg3 border border-white/5 overflow-hidden transition-all duration-300 hover:border-white/10 cursor-default ${className}`}
    >
      {/* Spotlight */}
      <div
        className="absolute pointer-events-none transition-opacity duration-300"
        style={{
          opacity: hovered ? 1 : 0,
          background: `radial-gradient(300px circle at ${pos.x}px ${pos.y}px, rgba(29,158,117,0.08), transparent 70%)`,
          inset: 0,
        }}
      />
      {/* Inner shadow */}
      <div
        className="absolute inset-0 rounded-[24px] pointer-events-none"
        style={{
          boxShadow: "0 -20px 80px -20px rgba(255,255,255,0.03) inset",
        }}
      />

      <div
        className={`relative ${size === "large" ? "p-8" : "p-6"} h-full flex flex-col`}
      >
        {/* Visual */}
        <div
          className={`${size === "large" ? "mb-6 h-28" : "mb-4 h-20"} transition-transform duration-300 group-hover:-translate-y-1`}
        >
          {visual}
        </div>
        <h3
          className={`${size === "large" ? "text-lg" : "text-base"} font-bold text-neto-txt mb-2`}
        >
          {title}
        </h3>
        <p className="text-sm text-neto-txt3 leading-relaxed flex-1">{desc}</p>
      </div>
    </div>
  );
}
