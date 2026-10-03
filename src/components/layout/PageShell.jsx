import React from "react";
import { Link } from "react-router-dom";
import { BrainCircuit } from "lucide-react";
import AuthControls from "@/components/auth/AuthControls";

export default function PageShell({ children }) {
  return (
    <div className="omni-shell min-h-screen w-full overflow-x-hidden text-foreground">
      <header className="sticky top-0 z-40 border-b border-neutral-200/80 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-2.5">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50">
              <BrainCircuit className="h-4 w-4 text-neutral-700" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-sans text-base font-semibold tracking-normal text-neutral-900">
                OmniMath
              </h1>
              <p className="truncate text-xs text-neutral-500">
                Guided math explanations with inspectable steps.
              </p>
            </div>
          </Link>
          <AuthControls />
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-4 py-4">{children}</main>
    </div>
  );
}
