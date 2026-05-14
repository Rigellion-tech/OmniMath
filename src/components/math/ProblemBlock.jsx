import React from "react";
import { InlineMath } from "react-katex";
import MathStep from "./MathStep";
import ConnectorLine from "./ConnectorLine";

export default function ProblemBlock({ problem }) {
  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "rgba(10, 22, 30, 0.5)",
        border: "1px solid rgba(34,211,238,0.12)",
      }}
    >
      {/* Problem title row */}
      <div className="flex items-baseline gap-3 mb-3 pb-2.5" style={{ borderBottom: "1px solid rgba(34,211,238,0.1)" }}>
        <span className="font-sans font-semibold uppercase tracking-widest" style={{ fontSize: 10, color: "rgba(34,211,238,0.5)" }}>
          {problem.title}
        </span>
        <span style={{ fontSize: 15, color: "hsl(185,60%,85%)" }}>
          <InlineMath math={problem.expression} />
        </span>
      </div>

      {/* Steps */}
      <div className="flex flex-col">
        {problem.steps.map((step, index) => (
          <React.Fragment key={step.id}>
            <MathStep step={step} index={index} totalSteps={problem.steps.length} />
            {index < problem.steps.length - 1 && (
              <ConnectorLine flip={index % 2 === 0} />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}