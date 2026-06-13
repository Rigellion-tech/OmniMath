import React, { useEffect, useState } from "react";
import { Columns2, Loader2, Sparkles } from "lucide-react";
import InlineMath from "./InlineMath";
import { compareMethods } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";

function AlternativeMethod({ problem }) {
  const method = Array.isArray(problem?.alternativeMethods)
    ? problem.alternativeMethods[0]
    : Array.isArray(problem?.alternatives)
      ? problem.alternatives[0]
      : null;

  if (method) {
    return {
      title: method.title || method.label || "Alternative approach",
      status: method.status || "Preview",
      points: Array.isArray(method.points)
        ? method.points
        : [method.summary || method.description].filter(Boolean),
    };
  }

  return {
    title: "Method B: alternative approach",
    status: "Empty",
    points: [
      "No structured alternative method is attached to this solution yet.",
    ],
  };
}

export default function WorkspaceCompareView({ problem, selectedStep }) {
  const { getToken } = useAuthToken();
  const [state, setState] = useState({ loading: false, error: "", methods: null });
  const alternative = state.methods?.[0]
    ? {
        title: state.methods[0].title,
        status: state.loading ? "Loading" : "Ready",
        points: state.methods[0].points?.length
          ? state.methods[0].points
          : [state.methods[0].summary].filter(Boolean),
      }
    : AlternativeMethod({ problem });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: "", methods: null });
    compareMethods({
      getToken,
      payload: {
        problemLatex: problem?.expression || problem?.problem || problem?.originalProblem || "",
        finalAnswerLatex: problem?.finalAnswerLatex || problem?.finalAnswer || "",
        steps: (problem?.steps || []).map((step) => ({
          heading: step.label || step.title || "",
          latex: step.math || "",
        })),
      },
    })
      .then((data) => {
        if (cancelled) return;
        setState({ loading: false, error: "", methods: data.methods || [] });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ loading: false, error: error.message || "Could not load compare methods.", methods: null });
      });

    return () => {
      cancelled = true;
    };
  }, [getToken, problem]);

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <article className="rounded-2xl border border-teal-300/[0.14] bg-white/[0.035] p-4 shadow-[0_18px_44px_rgba(0,0,0,0.2)]">
        <div className="mb-3 flex items-center gap-2">
          <Columns2 className="h-4 w-4 text-teal-200/70" />
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-teal-200/62">
            Method A
          </p>
        </div>
        <h3 className="text-base font-semibold text-cyan-50">Current solution</h3>
        {selectedStep?.math && (
          <div className="mt-3 overflow-x-auto rounded-xl border border-teal-300/[0.12] bg-teal-300/[0.045] px-3 py-2 font-serif text-sm italic text-cyan-50/86 omni-scrollbar">
            <InlineMath math={selectedStep.math} />
          </div>
        )}
        <p className="mt-3 text-sm leading-6 text-slate-300/68">
          {selectedStep?.summary || selectedStep?.label || "Select a step to compare its role in the current solution."}
        </p>
      </article>

      <article className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_44px_rgba(0,0,0,0.18)]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-100/72" />
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-amber-100/62">
              Method B
            </p>
          </div>
          <span className="rounded-full border border-amber-300/[0.16] bg-amber-300/[0.06] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-amber-100/72">
            {alternative.status}
          </span>
        </div>
        {state.loading ? (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-black/12 px-3 py-2 text-sm leading-6 text-slate-300/68">
            <Loader2 className="h-4 w-4 animate-spin text-teal-100/75" />
            Loading compare methods...
          </div>
        ) : state.error ? (
          <p className="mt-3 rounded-xl border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-sm leading-6 text-rose-100/82">
            {state.error}
          </p>
        ) : (
          <>
            <h3 className="text-base font-semibold text-cyan-50">{alternative.title}</h3>
            <div className="mt-3 space-y-2">
              {alternative.points.map((point) => (
                <p key={point} className="rounded-xl border border-white/[0.06] bg-black/12 px-3 py-2 text-sm leading-6 text-slate-300/68">
                  {point}
                </p>
              ))}
            </div>
          </>
        )}
      </article>
    </section>
  );
}
