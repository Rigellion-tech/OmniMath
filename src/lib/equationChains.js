function isLatexDelimiterCommandAt(source = "", index = 0, command = "") {
  const token = `\\${command}`;
  return source.startsWith(token, index)
    && !/[A-Za-z]/.test(source[index + token.length] || "");
}

function hasTopLevelRelation(text = "") {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let leftRightDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (isLatexDelimiterCommandAt(text, index, "left")) leftRightDepth += 1;
    else if (isLatexDelimiterCommandAt(text, index, "right")) leftRightDepth = Math.max(0, leftRightDepth - 1);
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (
      braceDepth === 0
      && parenDepth === 0
      && bracketDepth === 0
      && leftRightDepth === 0
      && /[=<>]/.test(char)
    ) return true;
  }
  return false;
}

function topLevelRelationIndexes(text = "") {
  const indexes = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let leftRightDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (isLatexDelimiterCommandAt(text, index, "left")) leftRightDepth += 1;
    else if (isLatexDelimiterCommandAt(text, index, "right")) leftRightDepth = Math.max(0, leftRightDepth - 1);
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (
      braceDepth === 0
      && parenDepth === 0
      && bracketDepth === 0
      && leftRightDepth === 0
      && /[=<>]/.test(char)
    ) indexes.push(index);
  }
  return indexes;
}

function isSimpleEquationLeftSide(value = "") {
  return /^(?:[A-Za-z]|\\[A-Za-z]+)$/.test(String(value || "").trim());
}

function findSimpleLeftSideStart(source, relationIndex) {
  let start = relationIndex - 1;
  if (start < 0) return -1;

  if (/[A-Za-z]/.test(source[start])) {
    while (start > 0 && /[A-Za-z]/.test(source[start - 1])) start -= 1;
    if (start > 0 && source[start - 1] === "\\") start -= 1;
    return start;
  }

  return -1;
}

function findGluedEquationBoundary(source, relationIndex, previousStart) {
  const boundary = findSimpleLeftSideStart(source, relationIndex);
  if (boundary <= previousStart) return -1;

  const previous = source.slice(previousStart, boundary).trim();
  const leftSide = source.slice(boundary, relationIndex).trim();
  const rightSide = source.slice(relationIndex + 1).trim();
  if (!hasTopLevelRelation(previous)) return -1;
  if (!/[0-9})\]]$/.test(previous)) return -1;
  if (!isSimpleEquationLeftSide(leftSide)) return -1;
  if (!/^-?(?:\d|[A-Za-z]|\\[A-Za-z]+|\()/.test(rightSide)) return -1;
  return boundary;
}

function findEquationChainBoundary(source, relationIndex, previousStart) {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let leftRightDepth = 0;

  for (let index = previousStart; index < relationIndex; index += 1) {
    const char = source[index];
    if (isLatexDelimiterCommandAt(source, index, "left")) leftRightDepth += 1;
    else if (isLatexDelimiterCommandAt(source, index, "right")) leftRightDepth = Math.max(0, leftRightDepth - 1);
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (
      braceDepth !== 0
      || parenDepth !== 0
      || bracketDepth !== 0
      || leftRightDepth !== 0
      || !/\s/.test(char)
    ) continue;

    const before = source.slice(Math.max(previousStart, index - 8), index).trim();
    const after = source.slice(index + 1, relationIndex).trim();
    if (!/[0-9A-Za-z})\]]$/.test(before)) continue;
    if (!/^(?:-?\d|[A-Za-z]|\\[A-Za-z]+|\()/.test(after)) continue;
    if (!/[+\-*/^]|\\(?:frac|sqrt|cdot|times)\b/.test(after)) continue;
    if (hasTopLevelRelation(after)) continue;
    return index;
  }

  return findGluedEquationBoundary(source, relationIndex, previousStart);
}

function maskTexEnvironments(source) {
  const masked = source.split("");
  const stack = [];
  const command = /\\(begin|end)\s*\{([A-Za-z*]+)\}/gu;
  for (const match of source.matchAll(command)) {
    const [, action, name] = match;
    if (action === "begin") {
      stack.push({ name, start: match.index });
    } else if (stack.at(-1)?.name === name) {
      const opening = stack.pop();
      if (stack.length === 0) {
        for (let index = opening.start; index < match.index + match[0].length; index += 1) {
          masked[index] = "M";
        }
      }
    }
  }
  return masked.join("");
}

export function splitEquationChainLatex(value = "") {
  const source = String(value || "").trim();
  // A complete environment is one math atom for equation-chain detection.
  // Preserve string offsets so top-level chains around a matrix still split.
  const boundarySource = maskTexEnvironments(source);
  const relationIndexes = topLevelRelationIndexes(boundarySource);
  if (relationIndexes.length < 2) return [source].filter(Boolean);

  const nextSegmentStart = (boundary) => (/\s/.test(source[boundary] || "") ? boundary + 1 : boundary);
  const boundaries = [];
  let previousStart = 0;
  for (const relationIndex of relationIndexes.slice(1)) {
    const boundary = findEquationChainBoundary(boundarySource, relationIndex, previousStart);
    if (boundary > previousStart) {
      boundaries.push(boundary);
      previousStart = nextSegmentStart(boundary);
    }
  }

  if (boundaries.length === 0) return [source].filter(Boolean);

  const segments = [];
  let start = 0;
  for (const boundary of boundaries) {
    const segment = source.slice(start, boundary).trim();
    if (segment) segments.push(segment);
    start = nextSegmentStart(boundary);
  }
  const tail = source.slice(start).trim();
  if (tail) segments.push(tail);
  return segments.length > 1 ? segments : [source].filter(Boolean);
}
