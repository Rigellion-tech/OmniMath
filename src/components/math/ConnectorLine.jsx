import React from "react";

// Draws an SVG wavy connector between steps, like in the mockup
export default function ConnectorLine({ flip = false }) {
  return (
    <div className="flex items-center justify-center my-0" style={{ height: 32 }}>
      <svg width="40" height="32" viewBox="0 0 40 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d={flip
            ? "M 30 0 C 30 8, 10 8, 10 16, 10 24, 30 24, 30 32"
            : "M 10 0 C 10 8, 30 8, 30 16, 30 24, 10 24, 10 32"
          }
          stroke="rgba(34,211,238,0.3)"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}