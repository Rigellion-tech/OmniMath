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
      backgroundColor: "#162028",
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
        onClick={() => setMenuOpen((v) => !v)}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-sans font-semibold transition-all duration-200"
        style={{
          fontSize: 11,
          background: "rgba(34,211,238,0.08)",
          color: loading ? "rgba(34,211,238,0.3)" : "rgba(34,211,238,0.75)",
          border: "1px solid rgba(34,211,238,0.2)",
        }}
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        Export
      </button>

      {menuOpen && (
        <>
          {/* backdrop to close */}
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div
            className="absolute right-0 mt-1 rounded-lg overflow-hidden z-50 flex flex-col"
            style={{
              background: "rgba(10,24,30,0.97)",
              border: "1px solid rgba(34,211,238,0.25)",
              minWidth: 120,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            }}
          >
            {[
              { label: "Save as PNG", action: exportPNG },
              { label: "Save as PDF", action: exportPDF },
            ].map(({ label, action }) => (
              <button
                key={label}
                onClick={action}
                className="px-4 py-2 text-left font-sans transition-all hover:bg-white/5"
                style={{ fontSize: 12, color: "rgba(185,230,240,0.85)" }}
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