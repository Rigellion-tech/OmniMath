import React, { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, ImagePlus, Loader2, Pencil, RotateCcw, Sparkles, X, XCircle } from "lucide-react";
import { buildExtractionSubmissionPayload, extractImageProblem, solveExtractedProblem } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";
import { canonicalProblemFromExtraction, logCanonicalProblem } from "@/lib/canonicalProblem";
import { cn } from "@/lib/utils";
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
  solving,
  onTextChange,
  onSolve,
  onCancel,
  solveError,
}) {
  const [editing, setEditing] = useState(false);
  if (!extraction) return null;

  const issues = Array.isArray(extraction.issues) ? extraction.issues : [];
  const tier = extraction.confidenceTier || extraction.extractionValidation?.tier || "medium";
  const integrity = Number(extraction.mathIntegrityScore ?? extraction.extractionValidation?.mathIntegrityScore ?? extraction.confidence ?? extraction.extractionValidation?.confidence ?? 0);
  const ocrConfidence = Number(extraction.ocrConfidence ?? extraction.extractionValidation?.ocrConfidence ?? extraction.extractionValidation?.metrics?.ocrConfidence ?? 0);
  const isLow = tier === "low";
  const isMedium = tier === "medium";
  const showEditor = editing;
  const canContinue = !solving && Boolean(editedText.trim());
  const primaryLabel = solveError ? "Retry solve" : "Continue with reviewed text";
  const statusText = isLow
    ? "Review the extracted text, then continue when it looks correct."
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
          <div className="flex flex-wrap gap-1.5">
            {ocrConfidence > 0 && (
              <span className="rounded-full border border-white/[0.09] bg-white/[0.045] px-2 py-0.5 font-mono text-[10px] text-slate-200/70">
                OCR {ocrConfidence}%
              </span>
            )}
            <span className="rounded-full border border-white/[0.09] bg-white/[0.045] px-2 py-0.5 font-mono text-[10px] text-slate-200/70">
              Math {integrity}% · {tier}
            </span>
          </div>
        </div>
        <p className="mt-1.5 text-xs leading-4 text-slate-200/72">
          {statusText}
        </p>
      </div>

      <label className="grid gap-1.5">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/55">
          Extracted problem
        </span>
        <textarea
          value={editedText}
          onChange={(event) => onTextChange(event.target.value)}
          rows={8}
          className="omni-text-wrap-safe min-h-40 resize-y whitespace-pre-wrap rounded-xl border border-teal-300/[0.16] bg-teal-300/[0.045] px-3 py-2 text-sm leading-6 text-slate-100 outline-none transition-colors focus:border-teal-200/35"
          spellCheck={false}
        />
      </label>

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

      {solveError && (
        <div className="rounded-lg border border-amber-300/[0.16] bg-amber-300/[0.06] px-2.5 py-1.5 text-xs leading-4 text-amber-50/82">
          {solveError}
        </div>
      )}

      <details className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-2">
        <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-200/75">
          <FileText className="h-3.5 w-3.5 text-teal-100/70" />
          OCR Details
        </summary>
        <div className="mt-2 grid gap-2">
          <div className="rounded-lg border border-white/[0.08] bg-black/20 p-2">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/55">
              Raw extracted LaTeX
            </p>
            <pre className="omni-text-wrap-safe mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs leading-5 text-cyan-50/82 omni-scrollbar">
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

      <div className="sticky bottom-0 z-20 grid gap-2 border-t border-white/[0.07] bg-[#061116]/95 pt-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={!canContinue}
          onClick={() => onSolve(showEditor ? "edited" : "direct")}
          className="omni-button flex min-h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45"
        >
          {solving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {solving ? "Solving..." : primaryLabel}
        </button>
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
  onTextChange,
  onCancel,
  onSubmit,
  onSolve,
  solveError,
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
              solving={submitting}
              onTextChange={onTextChange}
              onSolve={onSolve}
              onCancel={onCancel}
              solveError={solveError}
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
  onReviewedProblemSubmitted,
}) {
  const [preview, setPreview] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [quality, setQuality] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [extraction, setExtraction] = useState(null);
  const [editedText, setEditedText] = useState("");
  const [solveError, setSolveError] = useState("");
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
    setSolveError("");
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
    setSolveError("");
    onGenerationStart?.({ source: "image" });
    let extractionSucceeded = false;

    try {
      const result = await extractImageProblem({
        file: selectedFile,
        prompt: "Please extract the math problem shown in this image.",
        getToken,
        quality,
      });

      onUsageUpdate?.(result.usage);
      extractionSucceeded = true;
      const canonicalProblem = canonicalProblemFromExtraction({
        extraction: result,
        canonicalText: result.extractedProblemText || result.rawExtractedText || "",
        source: result.confidenceTier === "high" && !result.extractionValidation?.critical ? "ocr-direct" : "ocr-reviewed",
      });
      logCanonicalProblem("OCR extraction", canonicalProblem, { path: "ImageUpload.handleSubmit" });
      setExtraction({ ...result, canonicalProblem });
      setEditedText(result.extractedProblemText || result.rawExtractedText || "");

      if (result.confidenceTier === "high" && !result.extractionValidation?.critical) {
        const payload = buildExtractionSubmissionPayload({
          extraction: { ...result, canonicalProblem },
          displayText: result.extractedProblemText || result.rawExtractedText || "",
          rawText: result.rawExtractedText || result.rawOcrText || result.extractedProblemText || "",
          solveDecision: "direct",
          source: "ocr-direct",
        });
        const requestSessionId = onReviewedProblemSubmitted?.(payload);
        const solved = await solveExtractedProblem({
          ...payload,
          getToken,
        });
        onProblemGenerated({ ...solved, _requestSessionId: requestSessionId });
        resetSelection();
        return;
      }

      onExtractionReview?.(result);
      setSubmitting(false);
    } catch (error) {
      console.error("Image problem generation failed:", error);
      onGenerationError?.({
        source: extractionSucceeded ? "image-solve" : "image",
        message: error.message,
        status: error.status,
        code: error.body?.code,
        usage: error.body?.usage,
        solutionIssues: error.body?.solutionIssues,
        retryable: error.body?.retryable,
      });
      if (extractionSucceeded && error.body?.code === "AI_SERVICE_UNAVAILABLE") {
        setSolveError("AI service timed out or connection dropped. Try again.");
      } else if (extractionSucceeded && error.body?.code === "AI_SOLUTION_QUALITY_INVALID") {
        setSolveError("The generated solution failed mathematical validation. Retry from the reviewed text.");
      }
      setSubmitting(false);
    }
  };

  const solveReviewedExtraction = async (decision) => {
    if (submitting || !extraction || !editedText.trim()) return;
    setSubmitting(true);
    setSolveError("");
    onGenerationStart?.({ source: "image" });

    try {
      const rawText = extraction.extractedProblemText || "";
      const edited = editedText.trim() !== rawText.trim();
      const payload = buildExtractionSubmissionPayload({
        extraction,
        displayText: decision === "anyway" ? rawText : editedText,
        rawText: extraction.rawExtractedText || extraction.rawOcrText || rawText,
        solveDecision: decision === "anyway" ? "anyway" : edited ? "edited" : "direct",
        source: "ocr-reviewed",
      });
      const requestSessionId = onReviewedProblemSubmitted?.(payload);
      const solved = await solveExtractedProblem({
        ...payload,
        getToken,
      });
      onProblemGenerated({ ...solved, _requestSessionId: requestSessionId });
      resetSelection();
    } catch (error) {
      console.error("Confirmed image problem solve failed:", error);
      onGenerationError?.({
        source: "image-solve",
        message: error.message,
        status: error.status,
        code: error.body?.code,
        usage: error.body?.usage,
        solutionIssues: error.body?.solutionIssues,
        retryable: error.body?.retryable,
      });
      if (error.body?.code === "AI_SERVICE_UNAVAILABLE") {
        setSolveError("AI service timed out or connection dropped. Try again.");
      } else if (error.body?.code === "AI_SOLUTION_QUALITY_INVALID") {
        setSolveError("The generated solution failed mathematical validation. Retry from the reviewed text.");
      }
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
        onTextChange={setEditedText}
        onCancel={resetSelection}
        onSubmit={handleSubmit}
        onSolve={solveReviewedExtraction}
        solveError={solveError}
      />
    </div>
  );
}
