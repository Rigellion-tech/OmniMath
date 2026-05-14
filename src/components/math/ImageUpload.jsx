import React, { useState, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { ImagePlus, Loader2, X } from "lucide-react";

const SHARED_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    expression: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          chunks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                display: { type: "string" },
                short: { type: "string" },
                medium: { type: "string" },
                deep: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

export default function ImageUpload({ onProblemGenerated }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);
    setLoading(true);

    const { file_url } = await base44.integrations.Core.UploadFile({ file });

    const result = await base44.integrations.Core.InvokeLLM({
      prompt: `You are an expert calculus tutor. The attached image shows a blackboard or handwritten solution to a math problem.

1. First, carefully read and transcribe the mathematical expression or problem shown in the image.
2. Then, break it down into clear pedagogical steps from start to finish — as if explaining it to a student seeing it for the first time.

For each step, split the math notation into small "chunks" (individual symbols, terms, or sub-expressions). For every chunk provide three levels of explanation:
- short: a 3-6 word label (e.g. "Outer integral bounds", "Derivative operator")
- medium: 1-2 sentences for an intermediate student
- deep: 2-4 sentences with full mathematical detail and intuition

Return a JSON object matching this schema exactly:
{
  "title": "short label for what kind of problem this is (e.g. Differentiate, Double Integral, Limit, Solve ODE)",
  "expression": "the full expression or problem as read from the image",
  "steps": [
    {
      "id": "step-0",
      "label": "step name",
      "chunks": [
        { "id": "s0-c0", "display": "symbol or term", "short": "...", "medium": "...", "deep": "..." }
      ]
    }
  ]
}

Rules:
- id values must be unique strings (use format "s{stepIndex}-c{chunkIndex}")
- Each step should have 2-10 chunks
- Provide 4-7 steps that fully solve the problem from setup to final answer
- CRITICAL: chunk "display" values MUST be valid LaTeX strings (e.g. "\\frac{d}{dx}", "\\int_0^2", "\\sin(x^3)", "2x", "+", "=")
- The top-level "expression" field must also be valid LaTeX
- Keep chunk display LaTeX short — one symbol, operator, or small sub-expression per chunk
- Be thorough and mathematically rigorous — show all key intermediate steps`,
      file_urls: [file_url],
      response_json_schema: SHARED_SCHEMA,
    });

    setLoading(false);
    setPreview(null);
    onProblemGenerated(result);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) handleFile(file);
  };

  return (
    <div className="relative">
      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files[0])}
      />

      {/* Trigger button */}
      <button
        type="button"
        disabled={loading}
        onClick={() => fileRef.current.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-sans font-semibold transition-all duration-200"
        style={{
          fontSize: 11,
          background: loading ? "rgba(34,211,238,0.06)" : "rgba(34,211,238,0.08)",
          color: loading ? "rgba(34,211,238,0.3)" : "rgba(34,211,238,0.75)",
          border: "1px solid rgba(34,211,238,0.2)",
          whiteSpace: "nowrap",
        }}
        title="Upload a photo of a blackboard or handwritten problem"
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <ImagePlus className="w-3.5 h-3.5" />
        )}
        {loading ? "Reading…" : "Upload Image"}
      </button>

      {/* Preview thumbnail while loading */}
      {preview && (
        <div
          className="absolute top-10 left-0 z-50 rounded-lg overflow-hidden flex flex-col items-center gap-2 p-2"
          style={{
            background: "rgba(10,24,30,0.97)",
            border: "1px solid rgba(34,211,238,0.25)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            width: 180,
          }}
        >
          <img src={preview} alt="preview" className="w-full rounded-md object-cover" style={{ maxHeight: 120 }} />
          <div className="flex items-center gap-1.5 font-sans" style={{ fontSize: 11, color: "rgba(34,211,238,0.7)" }}>
            <Loader2 className="w-3 h-3 animate-spin" />
            Analyzing image…
          </div>
        </div>
      )}
    </div>
  );
}