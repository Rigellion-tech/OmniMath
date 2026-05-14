import React from "react";
import { Clock3 } from "lucide-react";

export default function History() {
  return (
    <section className="omni-panel mx-auto max-w-3xl rounded-2xl p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-teal-300/20 bg-teal-300/10">
          <Clock3 className="h-5 w-5 text-teal-200" />
        </div>
        <div>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-200/70">
            History
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-cyan-50">Your saved explanations</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300/65">
            Account history is protected by Clerk and ready for saved explanations when persistence is added.
            Your in-session recent problems still appear on the tutor board.
          </p>
        </div>
      </div>
    </section>
  );
}
