import React from "react";
import { Link } from "react-router-dom";
import { BrainCircuit } from "lucide-react";
import AuthControls from "@/components/auth/AuthControls";

export default function PageShell({ children }) {
  return (
    <div className="omni-shell min-h-screen w-full overflow-x-hidden text-foreground">
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#061116]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-4">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-teal-300/20 bg-teal-300/10 shadow-[0_12px_32px_rgba(0,0,0,0.28)]">
              <BrainCircuit className="h-5 w-5 text-teal-200" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-sans text-xl font-semibold tracking-normal text-cyan-50">
                OmniMath
              </h1>
              <p className="mt-0.5 truncate text-sm text-slate-300/60">
                Guided math explanations with inspectable steps.
              </p>
            </div>
          </Link>
          <AuthControls />
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-5 py-6">{children}</main>
    </div>
  );
}
