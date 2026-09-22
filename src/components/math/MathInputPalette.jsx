import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import katex from "katex";
import { MATH_CATEGORIES, MATH_SYMBOL_REGISTRY, searchMathSymbols } from "@/lib/mathSymbolRegistry";

const CATEGORY_LABELS = {
  linearAlgebra: "Linear algebra", numberSystems: "Number systems", vectorCalculus: "Vector calculus",
  differentialEquations: "ODE / PDE", numericalAnalysis: "Numerical", informationTheory: "Information",
  controlTheory: "Control", signalProcessing: "Signals", quantum: "Quantum",
};
const COMMON_IDS = new Set(["plus", "+", "minus", "times", "divide", "equals", "neq", "approx", "le", "ge", "infty", "pi", "theta", "lambda", "partial", "nabla", "int", "sum", "prod", "in", "subseteq", "forall", "exists", "to", "realNumbers", "complexNumbers", "hbar", "otimes"]);

function renderSymbol(item) {
  const latex = item.displayLatex || item.display || item.insertion || "";
  try {
    return katex.renderToString(latex, { throwOnError: true, strict: "ignore", output: "html", trust: false });
  } catch {
    return "";
  }
}

function getPanelPosition(button) {
  const rect = button?.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(560, viewportWidth - 24);
  const idealHeight = Math.min(430, viewportHeight - 24);
  const left = Math.max(12, Math.min((rect?.right || viewportWidth) - width, viewportWidth - width - 12));
  const below = viewportHeight - (rect?.bottom || 0) - 12;
  const above = (rect?.top || viewportHeight) - 12;
  const useBelow = below >= Math.min(280, idealHeight) || below >= above;
  const maxHeight = Math.max(180, Math.min(idealHeight, useBelow ? below : above));
  const top = useBelow ? (rect?.bottom || 4) + 8 : Math.max(12, (rect?.top || viewportHeight) - maxHeight - 8);
  return { left, top: Math.min(top, viewportHeight - maxHeight - 12), width, maxHeight };
}

export default function MathInputPalette({ onInsert, recent = [], onRecent, disabled = false, structuresEnabled = true }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("common");
  const [subcategory, setSubcategory] = useState("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const searchRef = useRef(null);
  const itemRefs = useRef([]);
  const gridRef = useRef(null);

  const recentItems = useMemo(() => recent.map((id) => MATH_SYMBOL_REGISTRY.find((item) => item.id === id)).filter(Boolean), [recent]);
  const categoryItems = useMemo(() => {
    if (query.trim()) return searchMathSymbols(query).filter((item) => structuresEnabled || item.type !== "structure");
    if (category === "recent") return recentItems.filter((item) => structuresEnabled || item.type !== "structure");
    if (category === "common") {
      const selected = MATH_SYMBOL_REGISTRY.filter((item) => item.type !== "structure" && COMMON_IDS.has(item.id));
      return selected.length ? selected : MATH_SYMBOL_REGISTRY.filter((item) => item.type !== "structure").slice(0, 28);
    }
    return MATH_SYMBOL_REGISTRY.filter((item) => (structuresEnabled || item.type !== "structure") && item.category === category);
  }, [category, query, recentItems, structuresEnabled]);
  const subcategories = useMemo(() => [...new Set(categoryItems.map((item) => item.subcategory).filter(Boolean))], [categoryItems]);
  const results = subcategory === "all" ? categoryItems : categoryItems.filter((item) => item.subcategory === subcategory);

  useEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => setPosition(getPanelPosition(buttonRef.current));
    const closeOnOutsidePointer = (event) => {
      if (!panelRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) setOpen(false);
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [open]);

  useEffect(() => { setActiveIndex(0); }, [category, query, subcategory]);

  const insert = (item) => {
    onInsert(item);
    onRecent?.(item.id);
    setOpen(false);
  };
  const moveGridFocus = (delta) => {
    if (!results.length) return;
    const next = Math.max(0, Math.min(results.length - 1, activeIndex + delta));
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  };
  const handleKeyDown = (event) => {
    const columns = Math.max(1, getComputedStyle(gridRef.current || event.currentTarget).gridTemplateColumns.split(" ").filter(Boolean).length);
    if (event.key === "Escape") {
      event.preventDefault(); setOpen(false); buttonRef.current?.focus(); return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); moveGridFocus(event.target === searchRef.current ? 0 : columns); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveGridFocus(-columns); }
    else if (event.key === "ArrowRight" && event.target !== searchRef.current) { event.preventDefault(); moveGridFocus(1); }
    else if (event.key === "ArrowLeft" && event.target !== searchRef.current) { event.preventDefault(); moveGridFocus(-1); }
    else if (event.key === "Home" && event.target !== searchRef.current) { event.preventDefault(); moveGridFocus(-results.length); }
    else if (event.key === "End" && event.target !== searchRef.current) { event.preventDefault(); moveGridFocus(results.length); }
  };

  const panel = open && position ? (
    <div ref={panelRef} role="dialog" aria-label="Universal mathematical symbol browser" data-testid="math-symbol-browser" onKeyDown={handleKeyDown} className="omni-symbol-browser fixed z-[90] flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-xl" style={position}>
      <div className="mb-2 flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-2 focus-within:border-teal-300/35">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setSubcategory("all"); }} placeholder="Search by name: surface integral, Hessian, subset…" aria-label="Search mathematical symbols" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-white outline-none placeholder:text-slate-500" />
        </label>
        <button type="button" aria-label="Close symbol browser" onClick={() => setOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white"><X className="h-4 w-4" /></button>
      </div>
      <div className="omni-scrollbar mb-2 flex shrink-0 gap-1 overflow-x-auto pb-1" aria-label="Symbol categories">
        {["common", "recent", ...MATH_CATEGORIES.filter((item) => structuresEnabled || item !== "structures")].map((item) => (
          <button key={item} type="button" onClick={() => { setCategory(item); setQuery(""); setSubcategory("all"); }} className={`whitespace-nowrap rounded-md px-2 py-1 text-[11px] capitalize ${category === item && !query ? "bg-teal-300/20 text-teal-100" : "text-slate-400 hover:bg-white/5"}`}>
            {CATEGORY_LABELS[item] || item.replace(/([A-Z])/g, " $1")}
          </button>
        ))}
      </div>
      {subcategories.length > 1 && !query && (
        <div className="omni-scrollbar mb-2 flex shrink-0 gap-1 overflow-x-auto" aria-label="Symbol subcategories">
          {["all", ...subcategories].map((item) => <button key={item} type="button" onClick={() => setSubcategory(item)} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] capitalize ${subcategory === item ? "bg-cyan-300/15 text-cyan-100" : "text-slate-500 hover:text-slate-200"}`}>{item.replace(/([A-Z])/g, " $1")}</button>)}
        </div>
      )}
      <div ref={gridRef} className="omni-scrollbar grid min-h-0 flex-1 grid-cols-4 content-start gap-1 overflow-y-auto pr-1 sm:grid-cols-5" role="grid" aria-label="Mathematical symbols">
        {results.map((item, index) => {
          const markup = renderSymbol(item);
          return <button key={item.id} ref={(node) => { itemRefs.current[index] = node; }} type="button" role="gridcell" title={item.name} aria-label={`Insert ${item.name}`} onFocus={() => setActiveIndex(index)} onClick={() => insert(item)} className="group min-h-12 rounded-lg border border-white/5 bg-white/[0.03] px-1.5 py-1 text-center text-cyan-50 transition hover:border-teal-300/40 hover:bg-teal-300/10 focus:border-teal-200/60 focus:outline-none focus:ring-2 focus:ring-teal-300/15">
            {markup ? <span className="omni-palette-symbol block truncate text-base" aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} /> : <span className="block truncate font-serif text-base" aria-hidden="true">{item.name}</span>}
            <span className="block truncate text-[9px] text-slate-500 group-hover:text-slate-300">{item.name}</span>
          </button>;
        })}
      </div>
      {!results.length && <p className="p-5 text-center text-sm text-slate-400">No matching standard notation. Use Advanced LaTeX for custom commands.</p>}
    </div>
  ) : null;

  return <>
    <button ref={buttonRef} type="button" disabled={disabled} aria-label="Open universal symbol browser" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="omni-button flex min-h-9 items-center gap-2 rounded-xl px-3 text-xs font-semibold"><span className="font-serif text-base">Ω</span>Symbols</button>
    {panel && createPortal(panel, document.body)}
  </>;
}
