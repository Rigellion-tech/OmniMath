import React, { useState } from "react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { Download, Loader2 } from "lucide-react";

export default function ExportButton({ targetRef, filename = "math-problem" }) {
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const capture = async () => {
    const el = targetRef.current;
    return await html2canvas(el, {
      backgroundColor: "#061116",
      scale: 2,
      useCORS: true,
      logging: false,
    });
  };

  const exportPNG = async () => {
    setMenuOpen(false);
    setLoading(true);
    const canvas = await capture();
    const link = document.createElement("a");
    link.download = `${filename}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    setLoading(false);
  };

  const exportPDF = async () => {
    setMenuOpen(false);
    setLoading(true);
    const canvas = await capture();
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({
      orientation: canvas.width > canvas.height ? "landscape" : "portrait",
      unit: "px",
      format: [canvas.width / 2, canvas.height / 2],
    });
    pdf.addImage(imgData, "PNG", 0, 0, canvas.width / 2, canvas.height / 2);
    pdf.save(`${filename}.pdf`);
    setLoading(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((value) => !value)}
        disabled={loading}
        className="omni-button flex min-h-10 items-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-all duration-200"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Export
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="omni-panel absolute right-0 z-50 mt-2 flex min-w-36 flex-col overflow-hidden rounded-2xl p-1.5">
            {[
              { label: "Save as PNG", action: exportPNG },
              { label: "Save as PDF", action: exportPDF },
            ].map(({ label, action }) => (
              <button
                key={label}
                type="button"
                onClick={action}
                className="rounded-xl px-3 py-2 text-left text-sm text-slate-200/80 transition-colors hover:bg-white/[0.06]"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
