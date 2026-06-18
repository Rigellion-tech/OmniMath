import React from "react";
import MathRenderer, { MathRenderShell } from "./MathRenderer";

export default function InlineMath(props) {
  const { className = "", displayMode = false, ...rendererProps } = props;
  return (
    <MathRenderShell
      className={className}
      displayMode={displayMode}
      role={displayMode ? "inline-display-math" : "inline-math"}
    >
      <MathRenderer
        componentName="InlineMath"
        displayMode={displayMode}
        {...rendererProps}
      />
    </MathRenderShell>
  );
}
