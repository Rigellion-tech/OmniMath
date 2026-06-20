export function rectArea(rect = {}) {
  const width = Math.max(0, Number(rect.width ?? rect.right - rect.left) || 0);
  const height = Math.max(0, Number(rect.height ?? rect.bottom - rect.top) || 0);
  return width * height;
}

export function rectContainsPoint(rect = {}, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function chooseSemanticHit(targets = [], x, y, fallback = null) {
  const hits = targets
    .flatMap((target) => (
      Array.isArray(target?.rects)
        ? target.rects.map((rect) => ({ target, rect }))
        : []
    ))
    .filter(({ rect }) => rectContainsPoint(rect, x, y) && rectArea(rect) > 0)
    .sort((left, right) => (
      (Number(right.target.depth) - Number(left.target.depth))
      || (rectArea(left.rect) - rectArea(right.rect))
    ));

  return hits[0]?.target || fallback;
}

export function normalizeSemanticRect(rect) {
  if (!rect) return null;
  const left = Number(rect.left);
  const right = Number(rect.right);
  const top = Number(rect.top);
  const bottom = Number(rect.bottom);
  if (![left, right, top, bottom].every(Number.isFinite)) return null;
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width <= 0 || height <= 0) return null;
  return { left, right, top, bottom, width, height };
}
