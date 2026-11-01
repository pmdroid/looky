/**
 * A small Markdown subset for answer prose, rendered straight to React
 * elements. There is no HTML path: raw HTML in the text is shown as text,
 * React escapes every string, and links go through a {@link LinkPolicy}.
 *
 * Supported: paragraphs, headings, bullet and numbered lists, block quotes,
 * fenced code, inline code, bold, italic, backslash escapes and links.
 */
import { Fragment, type ReactNode } from "react";
import type { LinkPolicy } from "./links";

export type Block =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "heading"; readonly level: number; readonly text: string }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: string[];
    }
  | { readonly type: "quote"; readonly blocks: Block[] }
  | { readonly type: "code"; readonly text: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const MAX_DEPTH = 4;

export function parseBlocks(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]! });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        body.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      blocks.push(
        depth < MAX_DEPTH
          ? { type: "quote", blocks: parseBlocks(body.join("\n"), depth + 1) }
          : { type: "paragraph", text: body.join(" ") },
      );
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      const start = numbered ? Number(numbered[1]) : 1;
      while (index < lines.length) {
        const current = lines[index]!;
        const match = pattern.exec(current);
        if (match) {
          items.push(ordered ? match[2]! : match[1]!);
        } else if (current.trim() !== "" && /^\s+/.test(current) && items.length > 0) {
          // An indented continuation line belongs to the previous item.
          items[items.length - 1] += ` ${current.trim()}`;
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      if (
        current.trim() === "" ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current)
      ) {
        break;
      }
      body.push(current.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

const INLINE = new RegExp(
  [
    String.raw`\\([\\\x60*_{}\[\]()#+\-.!>|~])`, // 1 escape
    String.raw`(\x60+)([^\x60]|[\s\S]*?[^\x60])\2(?!\x60)`, // 2,3 code
    String.raw`\[((?:[^\[\]\n]|\\[\[\]])+)\]\(\s*<?([^()\s<>]+)>?(?:\s+"[^"\n]*")?\s*\)`, // 4,5 link
    String.raw`\*\*(?=\S)([\s\S]+?)\*\*`, // 6 strong
    String.raw`(?<![\p{L}\p{N}_])__(?=\S)([\s\S]+?)__(?![\p{L}\p{N}_])`, // 7 strong
    String.raw`\*(?=[^\s*])([^*\n]+?)\*`, // 8 em
    String.raw`(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]+?)_(?![\p{L}\p{N}_])`, // 9 em
  ].join("|"),
  "gu",
);

export function renderInline(
  text: string,
  links: LinkPolicy,
  depth = 0,
  allowLinks = true,
): ReactNode[] {
  if (depth > MAX_DEPTH) return [text];
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) nodes.push(text.slice(last, at));
    last = at + match[0].length;
    const [, escaped, , code, linkText, href, strong1, strong2, em1, em2] = match;
    key += 1;
    if (escaped !== undefined) {
      nodes.push(escaped);
    } else if (code !== undefined) {
      nodes.push(
        <code key={key}>{code.trim() === "" ? code : code.replace(/^ (.*) $/s, "$1")}</code>,
      );
    } else if (linkText !== undefined && href !== undefined) {
      const children = renderInline(linkText, links, depth + 1, false);
      const target = allowLinks ? links.href(href) : undefined;
      nodes.push(
        target ? (
          <a key={key} href={target} target="_blank" rel="noopener noreferrer nofollow">
            {children}
          </a>
        ) : (
          <Fragment key={key}>{children}</Fragment>
        ),
      );
    } else if (strong1 !== undefined || strong2 !== undefined) {
      nodes.push(
        <strong key={key}>
          {renderInline((strong1 ?? strong2)!, links, depth + 1, allowLinks)}
        </strong>,
      );
    } else if (em1 !== undefined || em2 !== undefined) {
      nodes.push(<em key={key}>{renderInline((em1 ?? em2)!, links, depth + 1, allowLinks)}</em>);
    }
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlocks(
  blocks: readonly Block[],
  links: LinkPolicy,
  headingBase: number,
): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "paragraph":
        return (
          <p key={index} dir="auto">
            {renderInline(block.text, links)}
          </p>
        );
      case "heading": {
        const level = Math.min(6, headingBase + block.level - 1);
        const Tag = `h${level}` as "h3";
        return (
          <Tag key={index} dir="auto">
            {renderInline(block.text, links)}
          </Tag>
        );
      }
      case "list": {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex} dir="auto">
            {renderInline(item, links)}
          </li>
        ));
        return block.ordered ? (
          <ol key={index} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
      case "quote":
        return (
          <blockquote key={index}>{renderBlocks(block.blocks, links, headingBase)}</blockquote>
        );
      case "code":
        return (
          // Focusable so a code block wider than the screen can be scrolled from the keyboard.
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          <pre key={index} tabIndex={0}>
            <code>{block.text}</code>
          </pre>
        );
    }
  });
}

export function Markdown(props: {
  readonly text: string;
  readonly links: LinkPolicy;
  /** Level used for a `#` heading inside the text. */
  readonly headingBase?: number;
}) {
  return <>{renderBlocks(parseBlocks(props.text), props.links, props.headingBase ?? 3)}</>;
}
