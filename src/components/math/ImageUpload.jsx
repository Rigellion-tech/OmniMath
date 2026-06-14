import React, { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, ImagePlus, Loader2, Pencil, RotateCcw, Sparkles, X, XCircle } from "lucide-react";
import { extractImageProblem, solveExtractedProblem } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";
import { cn } from "@/lib/utils";
import MathText from "./MathText";
import MathRenderer from "./MathRenderer";
import {
  analyzeImageQuality,
  canSubmitImageForAi,
  MAX_IMAGE_BYTES,
} from "@/lib/imageQuality";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function getScoreTone(score) {
  if (score >= 85) return "text-emerald-100";
  if (score >= 70) return "text-teal-100";
  if (score >= 50) return "text-amber-100";
  return "text-rose-100";
}

function QualityIcon({ status }) {
  if (status === "pass") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-200/85" />;
  if (status === "warn") return <AlertTriangle className="h-3.5 w-3.5 text-amber-200/85" />;
  return <XCircle className="h-3.5 w-3.5 text-rose-200/85" />;
}

function QualityChecklist({ quality }) {
  if (!quality) return null;

  return (
    <div className="grid gap-1.5">
      {quality.checks.map((check) => (
        <div
          key={check.key}
          className={cn(
            "flex items-start gap-2 rounded-lg border px-2.5 py-1.5",
            check.status === "fail"
              ? "border-rose-300/[0.16] bg-rose-400/[0.055]"
              : check.status === "warn"
                ? "border-amber-300/[0.16] bg-amber-300/[0.055]"
                : "border-teal-300/[0.14] bg-teal-300/[0.045]"
          )}
        >
          <QualityIcon status={check.status} />
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-100/85">{check.label}</p>
            <p className="text-[11px] leading-4 text-slate-300/58">{check.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatPercent(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function QualityDiagnostics({ quality }) {
  if (!quality?.metrics) return null;

  const metrics = [
    { label: "OCR", value: `${quality.metrics.ocrConfidence}%` },
    { label: "Coverage", value: formatPercent(quality.metrics.mathCoverage) },
    { label: "Brightness", value: quality.metrics.brightness },
    { label: "Contrast", value: quality.metrics.contrast },
  ];

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {metrics.map((metric) => (
        <div key={metric.label} className="rounded-lg border border-white/[0.08] bg-white/[0.035] px-2.5 py-1.5">
          <p className="font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-slate-300/50">
            {metric.label}
          </p>
          <p className="mt-1 text-xs font-semibold text-slate-100/82">{metric.value}</p>
        </div>
      ))}
    </div>
  );
}

function ExtractionReviewPanel({
  extraction,
  editedText,
  editedLatex,
  solving,
  onTextChange,
  onLatexChange,
  onSolve,
  onCancel,
}) {
  const [editing, setEditing] = useState(false);
  if (!extraction) return null;

  const issues = Array.isArray(extraction.issues) ? extraction.issues : [];
  const tier = extraction.confidenceTier || extraction.extractionValidation?.tier || "medium";
  const confidence = Number(extraction.confidence ?? extraction.extractionValidation?.confidence ?? 0);
  const isLow = tier === "low";
  const isMedium = tier === "medium";
  const showEditor = editing;
  const displaySegments = Array.isArray(extraction.displaySegments)
    ? extraction.displaySegments
    : Array.isArray(extraction.imageSource?.displaySegments)
      ? extraction.imageSource.displaySegments
      : [];
  const statusText = isLow
    ? "Review required before solving"
    : isMedium
      ? "Review highlighted parts before solving"
      : "Extraction looks good";

  return (
    <div className="grid gap-3">
      <div className={cn(
        "rounded-xl border px-3 py-2.5",
        isLow ? "border-amber-300/24 bg-amber-300/[0.07]" : "border-teal-300/[0.18] bg-teal-300/[0.055]"
      )}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-100/80">
            Image extraction
          </p>
          <span className="rounded-full border border-white/[0.09] bg-white/[0.045] px-2 py-0.5 font-mono text-[10px] text-slate-200/70">
            {confidence}% · {tier}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-4 text-slate-200/72">
          {statusText}
        </p>
      </div>

      {editedText && (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-2 text-sm leading-6 text-slate-100/82">
          {editedText}
        </div>
      )}

      {displaySegments.length > 0 ? (
        <div className="max-w-full overflow-x-auto rounded-xl border border-teal-300/[0.16] bg-teal-300/[0.045] px-3 py-3 omni-scrollbar">
          <div className="flex min-w-max flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-7 text-slate-100/86">
            {displaySegments.map((segment, index) => (
              segment.type === "math" ? (
                <span key={`math-${index}`} className="font-serif italic text-cyan-50/92">
                  <MathRenderer
                    math={segment.latex}
                    fallbackText={segment.fallbackText}
                    componentName="ImageUpload.segment"
                  />
                </span>
              ) : (
                <span key={`text-${index}`}>{segment.text}</span>
              )
            ))}
          </div>
        </div>
      ) : (
        <div className="max-w-full overflow-x-auto rounded-xl border border-teal-300/[0.16] bg-teal-300/[0.045] px-3 py-3 text-sm text-cyan-50/90 omni-scrollbar">
          <div className="min-w-max">
            <MathText>{`\\(${editedLatex || "\\text{No extraction}"}\\)`}</MathText>
          </div>
        </div>
      )}

      {issues.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {issues.slice(0, 5).map((issue, index) => (
            <span
              key={`${issue.type || "issue"}-${index}`}
              className={cn(
                "rounded-full border px-2 py-1 text-[11px] leading-4",
                issue.severity === "high"
                  ? "border-rose-300/22 bg-rose-400/10 text-rose-50/86"
                  : "border-amber-300/22 bg-amber-300/10 text-amber-50/86"
              )}
              title={issue.message || "Review this extraction."}
            >
              {issue.message || "Suspicious extraction token"}
            </span>
          ))}
        </div>
      )}

      {showEditor && (
        <label className="grid gap-1.5">
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/55">
            Edit LaTeX
          </span>
          <textarea
            value={editedLatex}
            onChange={(event) => onLatexChange(event.target.value)}
            rows={4}
            className="min-h-24 resize-y rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2 font-mono text-sm leading-5 text-cyan-50 outline-none transition-colors focus:border-teal-200/35"
          />
        </label>
      )}

      <details className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-2">
        <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-200/75">
          <FileText className="h-3.5 w-3.5 text-teal-100/70" />
          OCR Details
        </summary>
        <div className="mt-2 grid gap-2">
          <label className="grid gap-1.5">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/55">
              Plain text transcription
            </span>
            <textarea
              value={editedText}
              onChange={(event) => onTextChange(event.target.value)}
              rows={3}
              className="min-h-20 resize-y rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2 text-sm leading-5 text-slate-100 outline-none transition-colors focus:border-teal-200/35"
            />
          </label>
          <div className="rounded-lg border border-white/[0.08] bg-black/20 p-2">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/55">
              Raw extracted LaTeX
            </p>
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-cyan-50/82 omni-scrollbar">
              {extraction.extractedProblemLatex || ""}
            </pre>
          </div>
          {issues.length > 0 && (
            <ul className="grid gap-1 text-xs leading-4 text-amber-50/82">
              {issues.map((issue, index) => (
                <li key={`${issue.type || "issue-detail"}-${index}`} className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-200/75" />
                  <span>{issue.message || "Review this extraction."}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <div className="grid gap-2 sm:grid-cols-2">
        {isLow && !showEditor ? (
          <button
            type="button"
            disabled={solving}
            onClick={() => setEditing(true)}
            className="omni-button flex min-h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Pencil className="h-4 w-4" />
            Edit Extraction
          </button>
        ) : (
          <button
            type="button"
            disabled={solving || !editedLatex.trim()}
            onClick={() => onSolve(showEditor ? "edited" : "direct")}
            className="omni-button flex min-h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45"
          >
            {solving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {showEditor ? "Solve" : "Accept Extraction"}
          </button>
        )}
        <button
          type="button"
          disabled={solving}
          onClick={isLow ? onCancel : () => setEditing(true)}
          className="flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 text-sm font-semibold text-slate-200/78 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isLow ? <RotateCcw className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          {isLow ? "Re-upload Image" : "Edit Extraction"}
        </button>
      </div>
    </div>
  );
}

function QualityPanel({
  preview,
  quality,
  analyzing,
  submitting,
  extraction,
  editedText,
  editedLatex,
  onTextChange,
  onLatexChange,
  onCancel,
  onSubmit,
  onSolve,
}) {
  if (!preview) return null;

  const canSubmit = quality?.passes && !analyzing && !submitting && !extraction;

  return (
    <div className="omni-panel absolute right-0 top-14 z-50 flex max-h-[80vh] w-[min(92vw,340px)] flex-col overflow-hidden rounded-2xl p-2.5 shadow-[0_22px_60px_rgba(0,0,0,0.35)]">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1 omni-scrollbar">
        <div className="flex items-start gap-2.5">
          <img src={preview} alt="Uploaded problem preview" className="h-20 w-20 rounded-lg object-cover" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-200/70">
                Image quality
              </p>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg p-1 text-slate-300/60 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                aria-label="Clear selected image"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {analyzing ? (
              <div className="mt-2 flex items-center gap-2 text-xs font-medium text-teal-100/80">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking image...
              </div>
            ) : quality ? (
              <>
                <div className="mt-1.5 flex items-end gap-2">
                  <span className={cn("text-2xl font-semibold", getScoreTone(quality.score))}>
                    {quality.score}
                  </span>
                  <span className="pb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-300/55">
                    /100
                  </span>
                </div>
                <p className="text-sm font-medium text-slate-100/85">{quality.label}</p>
                <p className="mt-0.5 text-xs leading-4 text-slate-300/58">
                  {!quality.passes
                    ? "Strict readability check needs a better image."
                    : quality.score < quality.warningThreshold
                    ? "Warning shown, AI can still attempt it."
                    : `${quality.imageType === "digital-screenshot" ? "Digital screenshot" : "Camera photo"} checks passed.`}
                </p>
              </>
            ) : null}
          </div>
        </div>

        <div className="mt-2.5 grid gap-2">
          {extraction ? (
            <ExtractionReviewPanel
              extraction={extraction}
              editedText={editedText}
              editedLatex={editedLatex}
              solving={submitting}
              onTextChange={onTextChange}
              onLatexChange={onLatexChange}
              onSolve={onSolve}
              onCancel={onCancel}
            />
          ) : (
            <>
          <QualityDiagnostics quality={quality} />

          <QualityChecklist quality={quality} />

          {quality?.hints?.length > 0 && (
            <div className={cn(
              "rounded-lg border p-2.5",
              quality.passes
                ? "border-teal-300/[0.14] bg-teal-300/[0.045]"
                : "border-amber-300/[0.16] bg-amber-300/[0.06]"
            )}
            >
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-200/65">
                Hints
              </p>
              <ul className="mt-1.5 space-y-1 text-xs leading-4 text-slate-200/72">
                {quality.hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            </div>
          )}

          {quality?.warning && (
            <div className="rounded-lg border border-amber-300/[0.16] bg-amber-300/[0.06] px-2.5 py-1.5 text-xs leading-4 text-amber-50/82">
              Math is small in frame. AI can still attempt to solve it.
            </div>
          )}

          {quality && !quality.passes && (
            <div className="rounded-lg border border-rose-300/[0.16] bg-rose-400/[0.055] px-2.5 py-1.5 text-xs leading-4 text-rose-100/82">
              {quality.strictIssues?.[0] || "This image looks unreadable. Try a sharper, upright, higher-resolution image."}
            </div>
          )}
            </>
          )}
        </div>
      </div>

      {!extraction && (
      <div className="sticky bottom-0 z-10 mt-2 border-t border-white/[0.07] bg-[#061116]/95 pt-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSubmit}
          className={cn(
            "omni-button flex min-h-10 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-all duration-200",
            !canSubmit && "cursor-not-allowed opacity-45"
          )}
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {submitting ? "Analyzing..." : "Analyze with AI"}
        </button>
      </div>
      )}
    </div>
  );
}

export default function ImageUpload({
  onProblemGenerated,
  onGenerationStart,
  onGenerationError,
  onExtractionReview,
  onUsageUpdate,
}) {
  const [preview, setPreview] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [quality, setQuality] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [extraction, setExtraction] = useState(null);
  const [editedText, setEditedText] = useState("");
  const [editedLatex, setEditedLatex] = useState("");
  const fileRef = useRef(null);
  const previewRef = useRef(null);
  const { getToken } = useAuthToken();

  const resetSelection = () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
    setSelectedFile(null);
    setQuality(null);
    setExtraction(null);
    setEditedText("");
    setEditedLatex("");
    setAnalyzing(false);
    setSubmitting(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const reportInputProblem = (message, status = 400) => {
    onGenerationError?.({
      source: "image",
      message,
      status,
      code: "BAD_INPUT",
    });
  };

  const handleFile = async (file) => {
    if (!file) return;
    resetSelection();

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      reportInputProblem("Please upload a PNG, JPG, WebP, or GIF image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reportInputProblem("Please upload an image under 10 MB.", 413);
      return;
    }

    const localUrl = URL.createObjectURL(file);
    previewRef.current = localUrl;
    setPreview(localUrl);
    setSelectedFile(file);
    setAnalyzing(true);

    try {
      const result = await analyzeImageQuality(file);
      setQuality(result);
    } catch (error) {
      reportInputProblem(error.message || "Could not inspect this image.");
      resetSelection();
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSubmit = async () => {
    if (!selectedFile || !quality) return;

    // Cost-control guard: failed client-side quality checks return here, before
    // explainImageProblem can send a request to /api/explain-image.
    if (!canSubmitImageForAi(quality)) return;

    setSubmitting(true);
    onGenerationStart?.({ source: "image" });

    try {
      const result = await extractImageProblem({
        file: selectedFile,
        prompt: "Please extract the math problem shown in this image.",
        getToken,
        quality,
      });

      onUsageUpdate?.(result.usage);
      setExtraction(result);
      setEditedText(result.extractedProblemText || "");
      setEditedLatex(result.extractedProblemLatex || "");

      if (result.confidenceTier === "high" && !result.extractionValidation?.critical) {
        const solved = await solveExtractedProblem({
          problemLatex: result.extractedProblemLatex,
          problemText: result.extractedProblemText,
          extraction: result,
          solveDecision: "direct",
          getToken,
        });
        onProblemGenerated(solved);
        resetSelection();
        return;
      }

      onExtractionReview?.(result);
      setSubmitting(false);
    } catch (error) {
      console.error("Image problem generation failed:", error);
      onGenerationError?.({
        source: "image",
        message: error.message,
        status: error.status,
        code: error.body?.code,
        usage: error.body?.usage,
      });
      setSubmitting(false);
    }
  };

  const solveReviewedExtraction = async (decision) => {
    if (!extraction || !editedLatex.trim()) return;
    setSubmitting(true);
    onGenerationStart?.({ source: "image" });

    try {
      const rawLatex = extraction.extractedProblemLatex || "";
      const rawText = extraction.extractedProblemText || "";
      const edited = editedLatex.trim() !== rawLatex.trim() || editedText.trim() !== rawText.trim();
      const solved = await solveExtractedProblem({
        problemLatex: decision === "anyway" ? rawLatex : editedLatex,
        problemText: decision === "anyway" ? rawText : editedText,
        extraction,
        solveDecision: decision === "anyway" ? "anyway" : edited ? "edited" : "direct",
        getToken,
      });
      onProblemGenerated(solved);
      resetSelection();
    } catch (error) {
      console.error("Confirmed image problem solve failed:", error);
      onGenerationError?.({
        source: "image",
        message: error.message,
        status: error.status,
        code: error.body?.code,
        usage: error.body?.usage,
      });
      setSubmitting(false);
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) handleFile(file);
  };

  return (
    <div className="relative">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => handleFile(event.target.files[0])}
      />

      <button
        type="button"
        disabled={submitting}
        onClick={() => fileRef.current.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        className="omni-button flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-all duration-200 xl:w-auto xl:min-w-[150px]"
        title="Upload a photo of a blackboard or handwritten problem"
      >
        {analyzing || submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ImagePlus className="h-4 w-4" />
        )}
        {submitting ? "Analyzing..." : analyzing ? "Checking..." : "Upload image"}
      </button>

      <QualityPanel
        preview={preview}
        quality={quality}
        analyzing={analyzing}
        submitting={submitting}
        extraction={extraction}
        editedText={editedText}
        editedLatex={editedLatex}
        onTextChange={setEditedText}
        onLatexChange={setEditedLatex}
        onCancel={resetSelection}
        onSubmit={handleSubmit}
        onSolve={solveReviewedExtraction}
      />
    </div>
  );
}
