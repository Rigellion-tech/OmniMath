import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import katex from "katex";

/** Measure the intrinsic ink once per item/resize, leaving a separate label row. */
export default function SymbolPreview({ item, className = "" }) {
  const areaRef = useRef(null);
  const inkRef = useRef(null);
  const [scale, setScale] = useState(1);
  const markup = useMemo(() => {
    try { return katex.renderToString(item.displayLatex || item.display || item.insertion || "", { throwOnError: true, strict: "ignore", output: "html", trust: false }); }
    catch { return ""; }
  }, [item]);
  useLayoutEffect(() => {
    const area = areaRef.current;
    const ink = inkRef.current;
    if (!area || !ink) return undefined;
    const measure = () => {
      const width = Math.max(1, ink.scrollWidth);
      const height = Math.max(1, ink.scrollHeight);
      const next = Math.min(1, (area.clientWidth - 4) / width, (area.clientHeight - 4) / height);
      setScale(Math.max(.01, next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(area); observer.observe(ink); measure();
    return () => observer.disconnect();
  }, [markup]);
  return <span className={`omni-symbol-preview ${className}`}>
    <span ref={areaRef} className="omni-symbol-preview-area" aria-hidden="true">
      <span ref={inkRef} className="omni-symbol-preview-ink" style={{ transform: `scale(${scale})` }} dangerouslySetInnerHTML={{ __html: markup }} />
    </span>
    <span className="omni-symbol-preview-label">{item.name}</span>
  </span>;
}
