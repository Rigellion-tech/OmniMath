import React from "react";
import MathText from "./MathText";
import InlineMath from "./InlineMath";
import { conversationBlocks } from "@/lib/conversationBlocks";

function InlineContent({ text }) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith("**") && part.endsWith("**")
    ? <strong key={index}><MathText>{part.slice(2, -2)}</MathText></strong>
    : <MathText key={index}>{part}</MathText>);
}

const ConversationText = React.memo(/** @param {{children: React.ReactNode}} props */ function ConversationText({ children }) {
  const blocks = conversationBlocks(children);
  return <div className="omni-conversation-prose">{blocks.map((block, index) => {
    if (block.type === "math") return <InlineMath key={index} math={block.text} displayMode className="omni-conversation-equation" />;
    if (block.type === "heading") return <h3 key={index}><InlineContent text={block.text} /></h3>;
    if (block.type === "list" || block.type === "ordered-list") {
      const Tag = block.type === "list" ? "ul" : "ol";
      return <Tag key={index} {...(Tag === "ol" ? { start: block.start } : {})}>{block.items.map((text, i) => <li key={i}><InlineContent text={text} /></li>)}</Tag>;
    }
    return <p key={index}><InlineContent text={block.text} /></p>;
  })}</div>;
});

export default ConversationText;
