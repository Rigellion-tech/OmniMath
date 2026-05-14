import React from "react";

export default function ProblemHeader({ expression }) {
  return (
    <div className="text-center mb-4">
      <div className="inline-block font-serif italic font-light" style={{ fontSize: 32 }}
        style={{ color: "hsl(185,60%,90%)", letterSpacing: "-0.01em" }}>
        {expression}
      </div>
    </div>
  );
}