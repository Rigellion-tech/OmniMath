import React from "react";
import InlineMath from "./InlineMath";
import { getMathTextRenderParts } from "@/lib/mathTextSegments";

export default function MathText({ children, className = "" }) {
  const text = typeof children === "string" ? children : String(children ?? "");
  const parts = getMathTextRenderParts(text);

  return (
    <span className={className}>
      {parts.map((part, index) => (
        part.type === "math"
          ? (
            <InlineMath
              key={part.key || `math-${index}`}
              math={part.value}
              className={part.displayMode ? "omni-block-math" : "omni-inline-math"}
              displayMode={part.displayMode}
            />
          )
          : <React.Fragment key={`text-${index}`}>{part.value}</React.Fragment>
      ))}
    </span>
  );
}
