// Frames only closed members of the existing strict fast-solve JSON schema.
// Provider deltas stay here; callers may publish only records they validate.
const KEYS = ["title", "problemLatex", "steps", "finalAnswerLatex", "numericCheck"];

function frameError(message) {
  return Object.assign(new Error(message), { code: "PROGRESSIVE_FRAME_INVALID" });
}

function readString(source, start) {
  if (source[start] !== '"') throw frameError("Expected a JSON string.");
  let escaped = false;
  for (let i = start + 1; i < source.length; i += 1) {
    if (escaped) { escaped = false; continue; }
    if (source[i] === "\\") { escaped = true; continue; }
    if (source[i] === '"') {
      try { return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 }; }
      catch { throw frameError("Invalid JSON string."); }
    }
  }
  return null;
}

function readObject(source, start) {
  if (source[start] !== "{") throw frameError("Expected a completed step object.");
  const stack = [];
  let quoted = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) throw frameError("Mismatched JSON brackets.");
      if (stack.length === 0) {
        try { return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 }; }
        catch { throw frameError("Invalid completed step JSON."); }
      }
    }
  }
  return null;
}

export function createProgressiveJsonFramer({ maxChars = 1_000_000 } = {}) {
  let source = "";
  let cursor = 0;
  let state = "root";
  let keyIndex = 0;
  let stepIndex = 0;
  const values = {};
  const emittedSteps = [];
  let emittedMetadata = null;
  let emittedFinal = null;
  let failed = false;

  function skipSpace() {
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
  }

  function push(delta) {
    if (failed || state === "done") {
      if (String(delta || "").trim()) throw frameError("Output continued after completion.");
      return [];
    }
    if (typeof delta !== "string") throw new TypeError("Provider delta must be a string.");
    source += delta;
    if (source.length > maxChars) { failed = true; throw frameError("Progressive output size limit exceeded."); }
    const records = [];
    try {
      while (true) {
        skipSpace();
        if (cursor >= source.length) break;
        if (state === "root") {
          if (source[cursor++] !== "{") throw frameError("Expected a JSON object.");
          state = "key";
        } else if (state === "key") {
          const item = readString(source, cursor);
          if (!item) break;
          if (item.value !== KEYS[keyIndex]) throw frameError(`Unexpected JSON field at position ${keyIndex}.`);
          cursor = item.end;
          state = "colon";
        } else if (state === "colon") {
          if (source[cursor++] !== ":") throw frameError("Expected a JSON field separator.");
          state = KEYS[keyIndex] === "steps" ? "array_open" : "scalar";
        } else if (state === "scalar") {
          const item = readString(source, cursor);
          if (!item) break;
          let next = item.end;
          while (next < source.length && /\s/u.test(source[next])) next += 1;
          if (next >= source.length) break;
          if (source[next] !== (keyIndex === KEYS.length - 1 ? "}" : ",")) throw frameError("Invalid JSON field boundary.");
          values[KEYS[keyIndex]] = item.value;
          cursor = next + 1;
          if (keyIndex === 1) {
            emittedMetadata = { title: values.title, problemLatex: values.problemLatex };
            records.push({ type: "metadata", value: emittedMetadata });
          }
          if (keyIndex === 3) {
            emittedFinal = values.finalAnswerLatex;
            records.push({ type: "final_answer", value: emittedFinal });
          }
          if (keyIndex === KEYS.length - 1) state = "done";
          else { keyIndex += 1; state = "key"; }
        } else if (state === "array_open") {
          if (source[cursor++] !== "[") throw frameError("Expected a steps array.");
          state = "step";
        } else if (state === "step") {
          if (source[cursor] === "]") throw frameError("Steps array must not be empty.");
          const item = readObject(source, cursor);
          if (!item) break;
          let next = item.end;
          while (next < source.length && /\s/u.test(source[next])) next += 1;
          if (next >= source.length) break;
          if (source[next] !== "," && source[next] !== "]") throw frameError("Invalid step boundary.");
          if (stepIndex >= 10) throw frameError("Too many steps.");
          emittedSteps.push(item.value);
          records.push({ type: "step", index: stepIndex++, value: item.value });
          cursor = next + 1;
          state = source[next] === "," ? "step" : "after_steps";
        } else if (state === "after_steps") {
          if (source[cursor++] !== ",") throw frameError("Expected field after steps.");
          keyIndex += 1;
          state = "key";
        } else if (state === "done") {
          throw frameError("Trailing JSON output.");
        }
      }
    } catch (error) { failed = true; throw error; }
    return records;
  }

  function finish() {
    if (failed || state !== "done" || source.slice(cursor).trim()) throw frameError("Incomplete progressive output.");
    let parsed;
    try { parsed = JSON.parse(source); }
    catch { throw frameError("Invalid final JSON object."); }
    if (Object.keys(parsed).join("|") !== KEYS.join("|")
      || !Array.isArray(parsed.steps) || parsed.steps.length !== emittedSteps.length
      || JSON.stringify(parsed.steps) !== JSON.stringify(emittedSteps)
      || parsed.title !== emittedMetadata?.title
      || parsed.problemLatex !== emittedMetadata?.problemLatex
      || parsed.finalAnswerLatex !== emittedFinal) {
      throw frameError("Final output conflicts with published prefix.");
    }
    return parsed;
  }

  return { push, finish };
}
