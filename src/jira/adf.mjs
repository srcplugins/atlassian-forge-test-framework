/** One paragraph of plain text as an Atlassian Document. */
export const adf = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Paragraphs, "- " bullets and "## " headings to ADF. */
export function adfFromText(text) {
  const content = [];
  for (const block of text.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim());
    if (lines.every((l) => l.startsWith('- ')))
      content.push({
        type: 'bulletList',
        content: lines.map((l) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: l.slice(2) }] }],
        })),
      });
    else if (lines.length === 1 && lines[0].startsWith('## '))
      content.push({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: lines[0].slice(3) }],
      });
    else content.push({ type: 'paragraph', content: [{ type: 'text', text: lines.join(' ') }] });
  }
  return { type: 'doc', version: 1, content };
}

/** Plain text of an ADF document, for comparing declared and observed content. */
export function adfText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return (node.content ?? [])
    .map(adfText)
    .join(node.type === 'doc' ? '\n' : ' ')
    .trim();
}
