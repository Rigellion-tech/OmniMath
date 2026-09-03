const EXPLICIT_MATH_PATTERN = /(\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g;

function appendSegment(segments, segment) {
  if (!segment.value) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text" && segment.type === "text") {
    previous.value += segment.value;
    return;
  }
  segments.push(segment);
}

function splitTokenAffixes(token = "") {
  const leading = token.match(/^["'\u201c\u2018]+/)?.[0] || "";
  const withoutLeading = token.slice(leading.length);
  const trailing = withoutLeading.match(/[.,;:!?]+$/)?.[0] || "";
  return {
    leadingLength: leading.length,
    core: withoutLeading.slice(0, withoutLeading.length - trailing.length),
    trailingLength: trailing.length,
  };
}

function implicitMathTokenKind(value = "") {
  if (!value) return "none";
  if (value.includes("\\")) return "strong";
  if (/[=<>^_+\-*/\u00b2\u00b3\u2070-\u2079\u207f\u207b\u2264\u2265\u00b7\u2212\u222b\u221a]/u.test(value)) {
    return "strong";
  }
  if (/^[A-Za-z]'?\([^)]*\)$/u.test(value)) return "strong";
  if (/^[([{]*[A-Za-z]'?[)\]}]*$/u.test(value)) return "weak";
  if (/^[([{]*[+-]?\d+(?:\.\d+)?[A-Za-z]*[)\]}]*$/u.test(value)) return "weak";
  if (/^d[A-Za-z][)\]}]*$/u.test(value)) return "weak";
  return "none";
}

function braceBalance(value = "") {
  let balance = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === "{") balance += 1;
    if (value[index] === "}") balance -= 1;
  }
  return balance;
}

function scanWhitespaceTokens(source) {
  const tokens = [];
  let cursor = 0;

  while (cursor < source.length) {
    const whitespace = /^\s+/u.exec(source.slice(cursor));
    if (whitespace) cursor += whitespace[0].length;
    if (cursor >= source.length) break;

    const tokenStart = cursor;
    const firstToken = /^\S+/u.exec(source.slice(cursor));
    cursor += firstToken[0].length;
    let tokenEnd = cursor;
    let balance = braceBalance(source.slice(tokenStart, tokenEnd));

    // A control sequence argument can contain prose spaces. Keep that whole
    // balanced argument in one candidate so prose normalization never sees a
    // fragment of an existing LaTeX span.
    while (balance > 0 && cursor < source.length) {
      const gap = /^\s+/u.exec(source.slice(cursor));
      if (!gap) break;
      cursor += gap[0].length;
      const nextToken = /^\S+/u.exec(source.slice(cursor));
      if (!nextToken) break;
      cursor += nextToken[0].length;
      tokenEnd = cursor;
      balance += braceBalance(source.slice(tokenEnd - nextToken[0].length, tokenEnd));
    }

    const raw = source.slice(tokenStart, tokenEnd);
    const affixes = splitTokenAffixes(raw);
    tokens.push({
      start: tokenStart + affixes.leadingLength,
      end: tokenEnd - affixes.trailingLength,
      kind: implicitMathTokenKind(affixes.core),
    });
  }

  return tokens;
}

function segmentImplicitMath(text = "") {
  const source = String(text ?? "");
  const tokens = scanWhitespaceTokens(source);
  const spans = [];

  for (let index = 0; index < tokens.length;) {
    if (tokens[index].kind === "none") {
      index += 1;
      continue;
    }

    let endIndex = index;
    let hasStrongToken = tokens[index].kind === "strong";
    while (endIndex + 1 < tokens.length && tokens[endIndex + 1].kind !== "none") {
      endIndex += 1;
      hasStrongToken ||= tokens[endIndex].kind === "strong";
    }

    if (hasStrongToken) spans.push({ start: tokens[index].start, end: tokens[endIndex].end });
    index = endIndex + 1;
  }

  if (spans.length === 0) return [{ type: "text", value: source }];
  const segments = [];
  let cursor = 0;
  for (const span of spans) {
    appendSegment(segments, { type: "text", value: source.slice(cursor, span.start) });
    const value = source.slice(span.start, span.end);
    appendSegment(segments, {
      type: "math",
      value,
      displayMode: false,
      explicit: false,
      escaped: value.includes("\\"),
      openDelimiter: "",
      closeDelimiter: "",
    });
    cursor = span.end;
  }
  appendSegment(segments, { type: "text", value: source.slice(cursor) });
  return segments;
}

function explicitMathSegment(raw = "") {
  if (raw.startsWith("\\[")) {
    return { value: raw.slice(2, -2), displayMode: true, openDelimiter: "\\[", closeDelimiter: "\\]" };
  }
  if (raw.startsWith("\\(")) {
    return { value: raw.slice(2, -2), displayMode: false, openDelimiter: "\\(", closeDelimiter: "\\)" };
  }
  if (raw.startsWith("$$")) {
    return { value: raw.slice(2, -2), displayMode: true, openDelimiter: "$$", closeDelimiter: "$$" };
  }
  return { value: raw.slice(1, -1), displayMode: false, openDelimiter: "$", closeDelimiter: "$" };
}

export function parseExplicitMathSegments(text = "") {
  const segments = [];
  const source = String(text ?? "");
  let lastIndex = 0;
  let match;

  EXPLICIT_MATH_PATTERN.lastIndex = 0;
  while ((match = EXPLICIT_MATH_PATTERN.exec(source)) !== null) {
    appendSegment(segments, { type: "text", value: source.slice(lastIndex, match.index) });
    appendSegment(segments, {
      type: "math",
      ...explicitMathSegment(match[0]),
      explicit: true,
      escaped: true,
    });
    lastIndex = EXPLICIT_MATH_PATTERN.lastIndex;
  }

  appendSegment(segments, { type: "text", value: source.slice(lastIndex) });
  return segments;
}

export function segmentMixedTextMath(text = "") {
  return parseExplicitMathSegments(text).flatMap((segment) => (
    segment.type === "math" ? [segment] : segmentImplicitMath(segment.value)
  ));
}
