import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Loader2 } from "lucide-react";
import { fetchUserHistory } from "@/api/userClient";
import { useAuthToken } from "@/lib/auth";
import { cleanLatexSnippet, getProblemLabel } from "@/lib/problemLabels";
import InlineMath from "@/components/math/InlineMath";

export default function History() {
  const { getToken } = useAuthToken();
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");

    fetchUserHistory({ getToken })
      .then((data) => {
        if (cancelled) return;
        setHistory(data.items || []);
        setStatus("ready");
      })
      .catch((requestError) => {
        if (cancelled) return;
        setError(requestError.message || "Could not load your saved explanations.");
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [getToken]);

  return (
    <section className="omni-panel mx-auto max-w-4xl rounded-2xl border-0 bg-transparent p-6 shadow-none">
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-100">
            <Clock3 className="h-5 w-5 text-neutral-600" />
          </div>
          <div>
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
              History
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-neutral-950">Your saved explanations</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
              Saved explanations are private to your signed-in account.
            </p>
          </div>
        </div>

        {status === "loading" && (
          <div className="flex items-center gap-3 rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600">
            <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
            Loading saved explanations...
          </div>
        )}

        {status === "error" && (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>{error}</span>
          </div>
        )}

        {status === "ready" && history.length === 0 && (
          <div className="rounded-2xl bg-neutral-50 p-5 text-sm text-neutral-600">
            No saved explanations yet. Generate a new explanation while signed in and it will appear here.
          </div>
        )}

        {status === "ready" && history.length > 0 && (
          <div className="grid gap-3">
            {history.map((item) => (
              <article
                key={item.id}
                className="rounded-2xl border border-transparent bg-neutral-50 p-4 transition-colors hover:border-neutral-200 hover:bg-neutral-100"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-semibold text-neutral-900">
                        {getProblemLabel(item, "Saved explanation")}
                      </h2>
                      <span className="rounded-full bg-neutral-200/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
                        {item.source}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm leading-6 text-neutral-600">
                      {cleanLatexSnippet(item.originalProblem || item.expression || item.finalAnswer, "No problem text saved.", 96)}
                    </p>
                    {item.finalAnswer && (
                      <p className="mt-2 text-sm text-neutral-700">
                        Final answer: <InlineMath math={item.finalAnswer} />
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-neutral-500">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    {new Date(item.createdAt).toLocaleDateString()}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
