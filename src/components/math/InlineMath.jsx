import React, { useMemo } from "react";
import katex from "katex";

export default function InlineMath({ math, className = "" }) {
  const rendered = useMemo(() => {
    try {
      return katex.renderToString(math, {
        throwOnError: false,
        displayMode: false,
      });
    } catch {
      return null;
    }
  }, [math]);

  if (!rendered) {
    return <span className={className}>{math}</span>;
  }

  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  );
}
