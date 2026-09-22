/** No generation/provider dependencies. Evidence-only compatibility policy v1.
 * Acceptance authorizes returning a structurally usable result, not calling it
 * correct. Future contradiction/repair policy must be a deliberate version change.
 */
export function decideCandidateAcceptance({ structural, verification = null }) {
  if (!structural.usable) return { action: "reject", accepted: false, mode: "evidence_only", reason: "structurally_unusable", mathematicalCorrectness: "not_established" };
  return {
    action: "accept",
    accepted: true,
    mode: "evidence_only",
    reason: verification?.summary.hasContradiction ? "structurally_usable_with_contradiction_evidence" : "structurally_usable_with_verification_evidence",
    mathematicalCorrectness: "not_established",
    repairRequested: false,
    escalationRequested: false,
  };
}
