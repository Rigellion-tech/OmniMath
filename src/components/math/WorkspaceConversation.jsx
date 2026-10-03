import React, { useMemo } from "react";
import ScopedConversation from "./ScopedConversation";
import { useAuthToken } from "@/lib/auth";
import { buildProvenanceSnapshot, getTargetRevision } from "@/lib/explanationProvenance";

const WORKSPACE_ACTIONS = [
  { label: "Simplify", question: "Explain the whole solution more simply." },
  { label: "Different method", question: "Solve this problem with a different valid method." },
  { label: "Verify", question: "Verify the whole solution and clearly state any limits of the check." },
  { label: "Expand", question: "Expand the reasoning that was abbreviated in this solution." },
  { label: "Intuition", question: "Give an intuitive explanation of the whole solution." },
  { label: "Assumptions", question: "List the assumptions used by this solution and explain why each is needed." },
  { label: "Sanity check", question: "Sanity-check the final result using units, scale, signs, or another independent check." },
  { label: "Practice", question: "Create one similar practice problem and include a short answer key." },
];

function wholeProblemText(problem = {}) {
  return String(
    problem.canonicalProblem?.canonicalText
    || problem.imageSource?.canonicalProblem?.canonicalText
    || problem.imageSource?.finalProblemText
    || problem.extractedProblemText
    || problem.originalProblem
    || problem.problem
    || problem.canonicalProblem?.canonicalLatex
    || problem.problemLatex
    || problem.expression
    || ""
  ).trim();
}

export default function WorkspaceConversation({
  sessionId,
  problem,
  conversation,
  onConversationChange,
  presentationDepth = "standard",
  tools = [],
}) {
  const { getToken } = useAuthToken();
  const item = useMemo(() => {
    const sourceText = wholeProblemText(problem);
    const targetId = `workspace:${sessionId}`;
    const semanticIdentity = {
      targetId,
      semanticId: targetId,
      semanticType: "workspace",
      role: "workspace",
      sourceText,
    };
    const baseItem = {
      id: `workspace-${sessionId}`,
      referenceType: "workspace",
      selectedText: sourceText,
      display: sourceText,
      semanticIdentity,
      context: { problem, solution: problem },
    };
    const generatedSnapshot = buildProvenanceSnapshot({ item: baseItem, problem });
    const provenanceSnapshot = {
      ...generatedSnapshot,
      confidence: { ...generatedSnapshot.confidence, kind: "explicit" },
    };
    return {
      ...baseItem,
      targetRevision: getTargetRevision(provenanceSnapshot),
      provenanceSnapshot,
    };
  }, [problem, sessionId]);

  return (
    <section className="omni-workspace-conversation" aria-label="Conversation about this solution">
      <ScopedConversation
        key={`${item.id}:${item.targetRevision}`}
        item={item}
        problem={problem}
        getToken={getToken}
        displayedExplanation={problem.description || problem.title || ""}
        scope="workspace"
        initialMessages={conversation?.messages || []}
        initialDraft={conversation?.draft || ""}
        onConversationChange={(value) => onConversationChange?.({ ...value, revision: item.targetRevision })}
        presentationDepth={presentationDepth}
        quickActions={WORKSPACE_ACTIONS}
        tools={tools}
      />
    </section>
  );
}
