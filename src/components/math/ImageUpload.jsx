import React, { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { explainImageProblem } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";

export default function ImageUpload({ onProblemGenerated, onGenerationStart, onGenerationError }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef(null);
  const { getToken } = useAuthToken();

  const handleFile = async (file) => {
    if (!file) return;
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);
    setLoading(true);
    onGenerationStart?.({ source: "image" });

    try {
      const result = await explainImageProblem({
        file,
        prompt: "Please solve and explain the math problem shown in this image.",
        getToken,
      });

      onProblemGenerated(result);
    } catch (error) {
      console.error("Image problem generation failed:", error);
      onGenerationError?.({
        source: "image",
        message: error.message,
        status: error.status,
        code: error.body?.code,
        usage: error.body?.usage,
      });
    } finally {
      setLoading(false);
      setPreview(null);
      URL.revokeObjectURL(localUrl);
      if (fileRef.current) fileRef.current.value = "";
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
        disabled={loading}
        onClick={() => fileRef.current.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        className="omni-button flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-all duration-200 xl:w-auto xl:min-w-[150px]"
        title="Upload a photo of a blackboard or handwritten problem"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ImagePlus className="h-4 w-4" />
        )}
        {loading ? "Reading..." : "Upload image"}
      </button>

      {preview && (
        <div className="omni-panel absolute left-0 top-14 z-50 flex w-56 flex-col gap-3 overflow-hidden rounded-2xl p-3">
          <img src={preview} alt="Uploaded problem preview" className="max-h-32 w-full rounded-xl object-cover" />
          <div className="flex items-center gap-2 text-xs font-medium text-teal-100/80">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Analyzing image...
          </div>
        </div>
      )}
    </div>
  );
}
