"use client";
import { useReveal } from "@/hooks/useReveal";

interface BlurRevealProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}

export default function BlurReveal({ children, delay = 0, className = "" }: BlurRevealProps) {
  const ref = useReveal(delay);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
