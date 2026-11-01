/**
 * Whether text explains something in sentences, as opposed to quoting code.
 * Fenced blocks, quoted or numbered source lines, inline code, links and
 * path-like tokens are removed first, so a snippet followed by a citation
 * such as `src/a.ts:1-5` does not count as a sentence because of the dot in
 * its file name. What remains must hold a sentence of at least two words.
 */
export function hasExplanatoryProse(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split("\n")
    .filter((line) => !/^\s*(?:>|\d+[:|]\s)/.test(line))
    .join(" ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, " ")
    .replace(/\[[^\]\n]*\]/g, " ")
    // Path-like tokens go, but a sentence's closing punctuation after them stays.
    .replace(/\S*[/\\]\S*?([.!?]*)(?=\s|$)/g, " $1");
  const sentences = prose.split(/[.!?]+(?=\s|$)/).slice(0, -1);
  return sentences.some(
    (sentence) => (sentence.match(/\b[A-Za-z][A-Za-z'-]+\b/g) ?? []).length >= 2,
  );
}
