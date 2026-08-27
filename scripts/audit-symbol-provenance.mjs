import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSymbolOrigins } from "../server/symbolInventory.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDirectory = path.join(projectRoot, "logs", "failed-solves");
const manifestPath = path.join(
  projectRoot,
  "tests",
  "fixtures",
  "validation",
  "historical-unexplained-symbol-audit.json"
);

function candidateProblem(capture = {}, candidate = {}) {
  return capture.input?.canonicalProblem?.latex
    || capture.input?.canonicalLatex
    || capture.input?.canonicalNormalizedSolverInput
    || candidate.originalProblem
    || candidate.problemLatex
    || "";
}

function findingKey(file, symbol) {
  return `${file}\u0000${symbol}`;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const manifestByFinding = new Map(manifest.classifications.map((entry) => [
  findingKey(entry.file, entry.symbol),
  entry,
]));
const logFiles = (await readdir(logDirectory)).filter((file) => file.endsWith(".json")).sort();
const historicalFindings = [];
const currentFindings = [];

for (const file of logFiles) {
  const capture = JSON.parse(await readFile(path.join(logDirectory, file), "utf8"));
  const candidate = capture.modelResult?.sanitizedNormalizedSolutionJson || {};
  const loggedIssues = capture.validation?.solutionIssues || [];
  for (const issue of loggedIssues) {
    const match = String(issue).match(/^unexplained_generated_symbol:(.+)$/u);
    if (!match) continue;
    const symbol = match[1];
    const classified = manifestByFinding.get(findingKey(file, symbol));
    assert.ok(classified, `Unclassified historical finding: ${file}:${symbol}`);
    historicalFindings.push(classified);
  }

  const analysis = analyzeSymbolOrigins(candidateProblem(capture, candidate), candidate);
  for (const symbol of analysis.unexplainedSymbols) {
    currentFindings.push({
      file,
      symbol,
      provenance: analysis.provenanceDiagnostics.find((record) => record.symbol === symbol) || null,
    });
  }
}

assert.equal(
  historicalFindings.length,
  manifest.classifications.length,
  "The audit manifest contains findings that no longer correspond to a stored capture."
);

const counts = Object.fromEntries([
  "true_positive",
  "false_positive_due_to_missing_introduction_recognition",
  "presentation_only",
  "ambiguous",
].map((classification) => [
  classification,
  historicalFindings.filter((finding) => finding.classification === classification).length,
]));

const output = {
  capturesAudited: logFiles.length,
  historicalFindingCount: historicalFindings.length,
  historicalCounts: counts,
  historicalFindings,
  currentFindingCount: currentFindings.length,
  currentFindings,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
