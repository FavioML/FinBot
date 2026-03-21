"use client";

import { cn } from "@/lib/utils";

const colorStyles = {
  green: "bg-[#1D9E75]/12 text-[#5DC9A0]",
  amber: "bg-[#EF9F27]/12 text-[#E8B85C]",
  red: "bg-[#D85A30]/12 text-[#E8A088]",
  blue: "bg-[#378ADD]/12 text-[#6DB3EE]",
} as const;

interface PillProps {
  children: React.ReactNode;
  color?: "green" | "amber" | "red" | "blue";
}

export function Pill({ children, color = "green" }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium",
        colorStyles[color]
      )}
    >
      {children}
    </span>
  );
}
