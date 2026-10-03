/** Structural acceptance remains independent of mathematical assurance. */
export function decideCandidateAcceptance({ structural, verification = null, assurance = null }) {
  if (!structural.usable) return { action: "reject", accepted: false, mode: "evidence_only", reason: "structurally_unusable", mathematicalCorrectness: "not_established" };
  return {
    action: "accept",
    accepted: true,
    mode: "bounded_assurance",
    reason: assurance?.status === "contradiction_detected" || (!assurance && verification?.summary.hasContradiction)
      ? "structurally_usable_with_contradiction_evidence" : "structurally_usable_with_verification_evidence",
    presentationAction: assurance?.status === "contradiction_detected"
      ? "requires_assurance_decision" : "present",
    mathematicalCorrectness: "not_established",
    repairRequested: false,
    escalationRequested: false,
  };
}
