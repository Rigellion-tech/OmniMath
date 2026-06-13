const ANALYSIS_SIZE = 512;
const MIN_SCORE_TO_SUBMIT = 50;
const WARNING_SCORE = 70;
const MIN_IMAGE_DIMENSION = 720;
const MIN_STRICT_IMAGE_DIMENSION = 320;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LARGE_IMAGE_BYTES = 6 * 1024 * 1024;
const OCR_OVERRIDE_CONFIDENCE = 90;
const STRICT_ROTATION_DEGREES = 45;

const SCORE_WEIGHTS = {
  resolution: 15,
  sharpness: 25,
  lighting: 15,
  exposure: 10,
  framing: 20,
  rotation: 5,
  fileSize: 10,
};

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function scoreBetween(value, lowFail, lowGood, highGood, highFail) {
  if (value >= lowGood && value <= highGood) return 1;
  if (value < lowGood) return clamp((value - lowFail) / (lowGood - lowFail));
  return clamp((highFail - value) / (highFail - highGood));
}

function getQualityLabel(score) {
  if (score >= 85) return "Excellent";
  if (score >= 70) return "Good";
  if (score >= 50) return "Needs improvement";
  return "Retake recommended";
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read this image."));
    };
    image.src = url;
  });
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function getImageData(image) {
  const scale = Math.min(1, ANALYSIS_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  return {
    width,
    height,
    originalWidth: image.naturalWidth,
    originalHeight: image.naturalHeight,
    data: context.getImageData(0, 0, width, height).data,
  };
}

function buildLuminance(data, width, height) {
  const luminance = new Float32Array(width * height);
  let sum = 0;
  let sumSquares = 0;
  let overexposed = 0;
  let underexposed = 0;

  for (let i = 0; i < luminance.length; i += 1) {
    const offset = i * 4;
    const value = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
    luminance[i] = value;
    sum += value;
    sumSquares += value * value;
    if (value >= 245) overexposed += 1;
    if (value <= 35) underexposed += 1;
  }

  const average = sum / luminance.length;
  const variance = Math.max(0, sumSquares / luminance.length - average * average);

  return {
    luminance,
    average,
    contrast: Math.sqrt(variance),
    overexposedRatio: overexposed / luminance.length,
    underexposedRatio: underexposed / luminance.length,
  };
}

function buildColorMetrics(data) {
  let saturationSum = 0;
  let colorfulnessSum = 0;
  const count = data.length / 4;

  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    saturationSum += max === 0 ? 0 : (max - min) / max;
    colorfulnessSum += Math.max(
      Math.abs(red - green),
      Math.abs(green - blue),
      Math.abs(blue - red)
    );
  }

  return {
    averageSaturation: saturationSum / count,
    colorfulness: colorfulnessSum / count,
  };
}

function measureSharpness(luminance, width, height) {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const laplacian = (
        luminance[i - width]
        + luminance[i - 1]
        - 4 * luminance[i]
        + luminance[i + 1]
        + luminance[i + width]
      );
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }

  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

function buildContentMask(luminance, width, height) {
  const mask = new Uint8Array(width * height);
  let count = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx = luminance[i + 1] - luminance[i - 1];
      const gy = luminance[i + width] - luminance[i - width];
      const edge = Math.hypot(gx, gy);
      const darkInk = luminance[i] < 125;
      const isContent = edge > 36 || darkInk;

      if (!isContent) continue;
      mask[i] = 1;
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
    }
  }

  if (count === 0) {
    return {
      mask,
      count,
      contentRatio: 0,
      boxRatio: 0,
      centeredScore: 0,
      angleDegrees: 0,
      bounds: null,
    };
  }

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const boxRatio = (boxWidth * boxHeight) / (width * height);
  const contentRatio = count / (width * height);
  const centerX = sumX / count;
  const centerY = sumY / count;
  const centerOffset = Math.hypot(centerX / width - 0.5, centerY / height - 0.5);
  const centeredScore = clamp(1 - centerOffset / 0.38);

  const covarianceXX = sumXX / count - centerX * centerX;
  const covarianceYY = sumYY / count - centerY * centerY;
  const covarianceXY = sumXY / count - centerX * centerY;
  const angleRadians = 0.5 * Math.atan2(2 * covarianceXY, covarianceXX - covarianceYY);
  const rawAngle = angleRadians * 180 / Math.PI;
  const angleDegrees = rawAngle > 45 ? rawAngle - 90 : rawAngle < -45 ? rawAngle + 90 : rawAngle;

  return {
    mask,
    count,
    contentRatio,
    boxRatio,
    centeredScore,
    angleDegrees,
    rawAngleDegrees: rawAngle,
    bounds: { minX, minY, maxX, maxY, boxWidth, boxHeight },
  };
}

function countTextRegions(mask, width, height) {
  const mergedMask = new Uint8Array(mask.length);
  const radiusX = Math.max(2, Math.floor(width * 0.018));
  const radiusY = Math.max(2, Math.floor(height * 0.012));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;

      for (let dy = -radiusY; dy <= radiusY; dy += 1) {
        const nextY = y + dy;
        if (nextY < 0 || nextY >= height) continue;
        for (let dx = -radiusX; dx <= radiusX; dx += 1) {
          const nextX = x + dx;
          if (nextX < 0 || nextX >= width) continue;
          mergedMask[nextY * width + nextX] = 1;
        }
      }
    }
  }

  const visited = new Uint8Array(mergedMask.length);
  const queue = [];
  const components = [];
  const minComponentPixels = Math.max(120, Math.floor(width * height * 0.018));

  for (let start = 0; start < mergedMask.length; start += 1) {
    if (!mergedMask[start] || visited[start]) continue;

    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;

    while (queue.length) {
      const index = queue.pop();
      const x = index % width;
      const y = Math.floor(index / width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (
          next < 0
          || next >= mergedMask.length
          || visited[next]
          || !mergedMask[next]
        ) continue;

        const nextX = next % width;
        if (Math.abs(nextX - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    const boxArea = (maxX - minX + 1) * (maxY - minY + 1);
    if (count >= minComponentPixels && boxArea / (width * height) >= 0.025) {
      components.push({ count, boxArea });
    }
  }

  return components
    .sort((left, right) => right.count - left.count)
    .slice(0, 6);
}

function statusFromScore(score) {
  if (score >= 0.75) return "pass";
  if (score >= 0.5) return "warn";
  return "fail";
}

function createCheck({ key, label, score, detail, hint }) {
  return {
    key,
    label,
    score,
    status: statusFromScore(score),
    detail,
    hint: score >= 0.75 ? "" : hint,
  };
}

function detectImageType({ file, average, contrast, overexposedRatio, underexposedRatio, sharpness, colorMetrics, content }) {
  const nameSuggestsScreenshot = /screen|screenshot|capture|snip/i.test(file.name || "");
  const digitalMime = ["image/png", "image/webp", "image/gif"].includes(file.type);
  const lowColorNoise = colorMetrics.averageSaturation < 0.1 || colorMetrics.colorfulness < 18;
  const brightCanvas = average >= 215 && overexposedRatio >= 0.28 && underexposedRatio < 0.08;
  const crispEdges = sharpness >= 100 || contrast >= 28;
  const sparseCleanContent = content.contentRatio < 0.18;

  const screenshotSignals = [
    digitalMime || nameSuggestsScreenshot,
    lowColorNoise,
    brightCanvas,
    crispEdges,
    sparseCleanContent,
  ].filter(Boolean).length;

  return screenshotSignals >= 3 ? "digital-screenshot" : "camera-photo";
}

function detectReadableSymbols(text) {
  return /[0-9=+\-*/^√∫ΣΠπθφρ∞≤≥(){}\[\]a-z]/i.test(text);
}

async function runBrowserOcr(file, originalWidth, originalHeight) {
  const TextDetectorCtor = typeof window === "undefined" ? null : Reflect.get(window, "TextDetector");
  const createImageBitmapFn = typeof window === "undefined" ? null : Reflect.get(window, "createImageBitmap");

  if (
    typeof TextDetectorCtor !== "function"
    || typeof createImageBitmapFn !== "function"
  ) {
    return null;
  }

  let bitmap = null;
  try {
    const detector = new TextDetectorCtor();
    bitmap = await createImageBitmapFn(file);
    const detections = await detector.detect(bitmap);
    const detectedText = detections
      .map((detection) => detection.rawValue || "")
      .join(" ")
      .trim();
    const detectedArea = detections.reduce((sum, detection) => {
      const box = detection.boundingBox;
      return sum + (box ? box.width * box.height : 0);
    }, 0);
    const textLengthScore = clamp(detectedText.length / 18);
    const detectionScore = clamp(detections.length / 3);
    const symbolScore = detectReadableSymbols(detectedText) ? 1 : 0.35;
    const areaScore = clamp((detectedArea / (originalWidth * originalHeight)) / 0.08);
    const confidence = Math.round(100 * clamp(
      textLengthScore * 0.3
      + detectionScore * 0.25
      + symbolScore * 0.25
      + areaScore * 0.2
    ));

    return {
      source: "browser-text-detector",
      confidence,
      detections: detections.length,
      textLength: detectedText.length,
    };
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

function estimateOcrConfidence({ sharpness, contrast, minDimension, content, imageType }) {
  const crispnessScore = clamp((sharpness - 55) / (220 - 55));
  const contrastScore = clamp((contrast - 12) / (58 - 12));
  const resolutionScore = clamp((minDimension - MIN_STRICT_IMAGE_DIMENSION) / (MIN_IMAGE_DIMENSION - MIN_STRICT_IMAGE_DIMENSION));
  const edgePresenceScore = clamp((content.contentRatio - 0.002) / (0.035 - 0.002));
  const coverageSignal = clamp((content.boxRatio - 0.006) / (0.12 - 0.006));
  const screenshotBoost = imageType === "digital-screenshot" ? 0.12 : 0;
  const confidence = (
    crispnessScore * 0.3
    + contrastScore * 0.25
    + resolutionScore * 0.15
    + edgePresenceScore * 0.18
    + coverageSignal * 0.12
    + screenshotBoost
  );

  return Math.round(100 * clamp(confidence));
}

export async function analyzeImageQuality(file) {
  const image = await loadImage(file);
  const imageData = getImageData(image);
  const { width, height, originalWidth, originalHeight, data } = imageData;
  const { luminance, average, contrast, overexposedRatio, underexposedRatio } = buildLuminance(data, width, height);
  const colorMetrics = buildColorMetrics(data);
  const sharpness = measureSharpness(luminance, width, height);
  const content = buildContentMask(luminance, width, height);
  const regions = countTextRegions(content.mask, width, height);
  const minDimension = Math.min(originalWidth, originalHeight);
  const imageType = detectImageType({
    file,
    average,
    contrast,
    overexposedRatio,
    underexposedRatio,
    sharpness,
    colorMetrics,
    content,
  });
  const browserOcr = await runBrowserOcr(file, originalWidth, originalHeight);
  const fallbackOcrConfidence = estimateOcrConfidence({
    sharpness,
    contrast,
    minDimension,
    content,
    imageType,
  });
  const ocrConfidence = Math.max(browserOcr?.confidence || 0, fallbackOcrConfidence);
  const mathCoverage = content.boxRatio;
  const fileSizeScore = file.size <= MAX_IMAGE_BYTES
    ? file.size <= LARGE_IMAGE_BYTES ? 1 : 0.75
    : 0;
  const resolutionScore = clamp((minDimension - 360) / (MIN_IMAGE_DIMENSION - 360));
  const sharpnessScore = clamp((sharpness - 60) / (260 - 60));
  const isDigitalScreenshot = imageType === "digital-screenshot";
  const brightnessScore = isDigitalScreenshot
    ? scoreBetween(average, 25, 55, 252, 255)
    : scoreBetween(average, 35, 75, 205, 235);
  const exposureScore = isDigitalScreenshot ? 1 : clamp((0.18 - overexposedRatio) / 0.18);
  const fillScore = isDigitalScreenshot
    ? clamp((content.boxRatio - 0.045) / (0.38 - 0.045))
    : clamp((content.boxRatio - 0.18) / (0.55 - 0.18));
  const inkScore = isDigitalScreenshot
    ? clamp((content.contentRatio - 0.006) / (0.055 - 0.006))
    : clamp((content.contentRatio - 0.018) / (0.08 - 0.018));
  const framingScore = isDigitalScreenshot
    ? clamp(fillScore * 0.4 + inkScore * 0.35 + content.centeredScore * 0.25)
    : clamp(fillScore * 0.55 + inkScore * 0.3 + content.centeredScore * 0.15);
  const rotationScore = clamp(1 - Math.max(0, Math.abs(content.angleDegrees) - 8) / 14);
  const absoluteRotationDegrees = Math.abs(content.rawAngleDegrees || content.angleDegrees || 0);

  const checks = [
    createCheck({
      key: "ocr",
      label: "Text recognition",
      score: ocrConfidence / 100,
      detail: `OCR confidence ${ocrConfidence}%.`,
      hint: "Image may be hard to read. Try a sharper, clearer image.",
    }),
    createCheck({
      key: "sharpness",
      label: "Sharpness",
      score: sharpnessScore,
      detail: sharpnessScore >= 0.75 ? "Writing edges look crisp." : "Writing edges look soft.",
      hint: "Image looks blurry. Hold the camera still and retake.",
    }),
    createCheck({
      key: "lighting",
      label: "Lighting",
      score: brightnessScore,
      detail: `Average brightness ${Math.round(average)}.`,
      hint: average < 75 ? "Lighting is too dark." : "Lighting is uneven. Try softer, more even light.",
    }),
    createCheck({
      key: "framing",
      label: "Framing",
      score: framingScore,
      detail: framingScore >= 0.75
        ? "The writing fills enough of the frame."
        : `Math coverage ${Math.round(mathCoverage * 100)}%.`,
      hint: "Math is small in frame. AI can still attempt to solve it.",
    }),
    createCheck({
      key: "resolution",
      label: "Resolution",
      score: resolutionScore,
      detail: `${originalWidth} x ${originalHeight}px`,
      hint: "Use a higher-resolution image or move closer before retaking.",
    }),
    createCheck({
      key: "fileSize",
      label: "File size",
      score: fileSizeScore,
      detail: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
      hint: "Please upload an image under 10 MB.",
    }),
  ];

  const hints = checks
    .filter((check) => check.hint)
    .map((check) => check.hint);

  if (!isDigitalScreenshot && exposureScore < 0.75) hints.push("Image is overexposed. Avoid glare.");
  if (underexposedRatio > 0.2) hints.push("Lighting is too dark.");
  if (rotationScore < 0.75) hints.push("Rotate the page so the writing is upright.");
  if (regions.length >= 3) hints.push("Crop to one problem only.");

  const weightedScore = (
    sharpnessScore * SCORE_WEIGHTS.sharpness
    + brightnessScore * SCORE_WEIGHTS.lighting
    + exposureScore * SCORE_WEIGHTS.exposure
    + framingScore * SCORE_WEIGHTS.framing
    + resolutionScore * SCORE_WEIGHTS.resolution
    + fileSizeScore * SCORE_WEIGHTS.fileSize
    + rotationScore * SCORE_WEIGHTS.rotation
  );
  const score = Math.round(clamp(weightedScore / 100) * 100);
  const strictIssues = [];

  if (minDimension < MIN_STRICT_IMAGE_DIMENSION) {
    strictIssues.push("Image resolution is extremely low.");
  }
  if (sharpness < 40 && ocrConfidence < OCR_OVERRIDE_CONFIDENCE) {
    strictIssues.push("Image looks too blurry to read.");
  }
  if (absoluteRotationDegrees > STRICT_ROTATION_DEGREES) {
    strictIssues.push("Image is rotated more than 45 degrees.");
  }
  if (ocrConfidence < 35 && content.contentRatio < 0.0025) {
    strictIssues.push("No readable math was detected.");
  }
  if (fileSizeScore === 0) {
    strictIssues.push("Image is larger than 10 MB.");
  }

  const hasStrictFailure = strictIssues.length > 0;
  const ocrOverride = ocrConfidence > OCR_OVERRIDE_CONFIDENCE && !hasStrictFailure;
  const passes = !hasStrictFailure && (score >= MIN_SCORE_TO_SUBMIT || ocrOverride);

  return {
    score,
    label: getQualityLabel(score),
    passes,
    warning: passes && score < WARNING_SCORE,
    blocked: !passes,
    imageType,
    strictIssues,
    ocrOverride,
    threshold: MIN_SCORE_TO_SUBMIT,
    warningThreshold: WARNING_SCORE,
    checks,
    hints: [...new Set(hints)].slice(0, 4),
    metrics: {
      width: originalWidth,
      height: originalHeight,
      fileSize: file.size,
      sharpness: Math.round(sharpness),
      brightness: Math.round(average),
      contrast: Math.round(contrast),
      ocrConfidence,
      mathCoverage,
      overexposedRatio,
      underexposedRatio,
      contentRatio: content.contentRatio,
      boxRatio: content.boxRatio,
      rotationDegrees: Math.round(content.angleDegrees),
      absoluteRotationDegrees: Math.round(absoluteRotationDegrees),
      textRegionCount: regions.length,
      ocrSource: browserOcr?.source || "visual-estimate",
      ocrDetections: browserOcr?.detections || 0,
    },
  };
}

export function canSubmitImageForAi(quality) {
  return Boolean(quality?.passes);
}

export { MAX_IMAGE_BYTES, MIN_SCORE_TO_SUBMIT, WARNING_SCORE };
