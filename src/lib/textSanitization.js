const ENCODED_ANSI_SEQUENCE = /\\(?:u001b|x1b)\[[0-?]*[ -/]*[@-~]/giu;
const ANSI_OSC_SEQUENCE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
const ANSI_CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
const ANSI_ESCAPE_SEQUENCE = /\u001B(?:[@-_])?/gu;
const DISALLOWED_ASCII_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export function stripTerminalControlSequences(value = "") {
  return String(value || "")
    .replace(ENCODED_ANSI_SEQUENCE, "")
    .replace(ANSI_OSC_SEQUENCE, "")
    .replace(ANSI_CSI_SEQUENCE, "")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(DISALLOWED_ASCII_CONTROLS, "");
}

export function sanitizeStringValues(value) {
  if (typeof value === "string") return stripTerminalControlSequences(value);
  if (Array.isArray(value)) return value.map(sanitizeStringValues);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeStringValues(item)])
  );
}
