/** Small conversation-only formatter. It never annotates the solution's semantic tree. */
export function conversationBlocks(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const display = trimmed.startsWith("$$") ? ["$$", "$$"]
      : trimmed.startsWith("\\[") ? ["\\[", "\\]"] : null;
    if (display) {
      flush();
      let text = trimmed.slice(display[0].length);
      while (!text.includes(display[1]) && index + 1 < lines.length) text += `\n${lines[++index]}`;
      const end = text.indexOf(display[1]);
      // An unfinished streamed block stays local and becomes math once its delimiter arrives.
      if (end < 0) blocks.push({ type: "paragraph", text: `${display[0]}${text}` });
      else {
        blocks.push({ type: "math", text: text.slice(0, end).trim() });
        const rest = text.slice(end + display[1].length).trim();
        if (rest) paragraph.push(rest);
      }
      continue;
    }
    const standalone = trimmed.match(/^\$(?!\$)([\s\S]+)\$$/) || trimmed.match(/^\\\(([\s\S]+)\\\)$/);
    if (standalone) { flush(); blocks.push({ type: "math", text: standalone[1] }); continue; }
    const heading = trimmed.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
    if (heading) { flush(); blocks.push({ type: "heading", text: heading[1] }); continue; }
    const list = line.match(/^\s*(?:([-*])\s+|(\d+)[.)]\s+)(.+)$/);
    if (list) {
      flush();
      const type = list[2] ? "ordered-list" : "list";
      const previous = blocks.at(-1);
      if (previous?.type === type) previous.items.push(list[3]);
      else blocks.push({ type, items: [list[3]], start: list[2] ? Number(list[2]) : undefined });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
