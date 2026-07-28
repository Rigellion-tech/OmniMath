export const DEFAULT_FLOATING_LENS_SIZE = { width: 320, height: 260 };
export const DEFAULT_QUICK_TOOLTIP_SIZE = { width: 360, height: 120 };
export const DEFAULT_TOOLTIP_GAP = 10;

export function clampTooltipPosition(x, y, size = DEFAULT_FLOATING_LENS_SIZE, viewport = null, padding = 12) {
  const resolvedViewport = viewport || {
    width: typeof window !== "undefined" ? window.innerWidth : 1024,
    height: typeof window !== "undefined" ? window.innerHeight : 768,
  };
  const maxX = Math.max(padding, resolvedViewport.width - size.width - padding);
  const maxY = Math.max(padding, resolvedViewport.height - size.height - padding);

  return {
    x: Math.min(Math.max(padding, x), maxX),
    y: Math.min(Math.max(padding, y), maxY),
  };
}

export function getTooltipPositionFromRect(
  rect,
  {
    index = 0,
    size = DEFAULT_FLOATING_LENS_SIZE,
    viewport = null,
    gap = DEFAULT_TOOLTIP_GAP,
    padding = 12,
  } = {}
) {
  const resolvedViewport = viewport || {
    width: typeof window !== "undefined" ? window.innerWidth : 1024,
    height: typeof window !== "undefined" ? window.innerHeight : 768,
  };
  const safeRect = rect || {
    left: resolvedViewport.width / 2,
    right: resolvedViewport.width / 2,
    top: resolvedViewport.height / 2,
    bottom: resolvedViewport.height / 2,
    width: 0,
    height: 0,
  };
  const stagger = (index % 6) * 18;
  const canOpenRight = safeRect.right + gap + size.width + padding <= resolvedViewport.width;
  const canOpenLeft = safeRect.left - gap - size.width - padding >= 0;
  const canOpenBelow = safeRect.bottom + gap + size.height + padding <= resolvedViewport.height;
  const canOpenAbove = safeRect.top - gap - size.height - padding >= 0;
  const isQuickTooltip = size.height <= 160;

  if (canOpenRight || canOpenLeft) {
    return clampTooltipPosition(
      canOpenRight
        ? safeRect.right + gap + stagger
        : safeRect.left - gap - size.width - stagger,
      safeRect.top + stagger,
      size,
      resolvedViewport,
      padding
    );
  }

  if (isQuickTooltip && (canOpenBelow || canOpenAbove)) {
    return clampTooltipPosition(
      safeRect.left + safeRect.width / 2 - size.width / 2 + stagger,
      canOpenBelow
        ? safeRect.bottom + gap + stagger
        : safeRect.top - gap - size.height - stagger,
      size,
      resolvedViewport,
      padding
    );
  }

  return clampTooltipPosition(
    safeRect.left + stagger,
    canOpenBelow || !canOpenAbove
      ? safeRect.bottom + gap + stagger
      : safeRect.top - gap - size.height - stagger,
    size,
    resolvedViewport,
    padding
  );
}

export function getRectSnapshot(rect) {
  if (!rect) return null;
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}
