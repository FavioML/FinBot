"use client";

import { cn } from "@/lib/utils";

const accentGradients = {
  green: "from-[#1D9E75] to-[#68dbae]",
  amber: "from-[#EF9F27] to-[#f0c36d]",
  red: "from-[#D85A30] to-[#e8a088]",
  blue: "from-[#378ADD] to-[#6DB3EE]",
} as const;

interface DashCardProps {
  children: React.ReactNode;
  className?: string;
  accent?: "green" | "amber" | "red" | "blue" | "none";
}

export function DashCard({
  children,
  className,
  accent = "none",
}: DashCardProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[18px] border border-white/[0.06] bg-neto-bg3/60 p-5 backdrop-blur-sm",
        className
      )}
    >
      {accent !== "none" && (
        <div
          className={cn(
            "absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r",
            accentGradients[accent]
          )}
        />
      )}
      {children}
    </div>
  );
}
