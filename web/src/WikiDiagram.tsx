import { useId, type MouseEvent } from "react";
import { NODE_HEIGHT, NODE_WIDTH, type Diagram } from "./wiki-diagram";

const PAD = 4;
const MAX_LABEL = 20;

const CAPTION: Record<Diagram["kind"], string> = {
  modules: "How the modules depend on each other.",
  module: "What this module imports, and what imports it.",
  workflow: "The modules this flow reaches, and the imports between them.",
};

function label(title: string): string {
  return title.length > MAX_LABEL ? `${title.slice(0, MAX_LABEL - 1)}…` : title;
}

export function WikiDiagram(props: {
  readonly diagram: Diagram;
  readonly hrefFor: (page: string) => string;
  readonly go: (event: MouseEvent, page: string) => void;
}) {
  const { diagram } = props;
  const id = useId();
  const arrow = `${id}-arrow`;
  const caption = `${CAPTION[diagram.kind]} An arrow points from a module to one it imports, as resolved from the index.`;
  return (
    <figure className="wiki-diagram">
      <div className="wiki-diagram-scroll">
        <svg
          width={diagram.width + PAD * 2}
          height={diagram.height + PAD * 2}
          viewBox={`${-PAD} ${-PAD} ${diagram.width + PAD * 2} ${diagram.height + PAD * 2}`}
          role="img"
          aria-labelledby={`${id}-caption`}
        >
          <defs>
            <marker
              id={arrow}
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="diagram-arrowhead" />
            </marker>
          </defs>
          {diagram.edges.map((edge) => (
            <line
              key={`${edge.from}>${edge.to}`}
              className="diagram-edge"
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              markerEnd={`url(#${arrow})`}
            />
          ))}
          {diagram.nodes.map((node) => {
            const box = (
              <>
                <title>{node.title}</title>
                <rect
                  className={node.focus ? "diagram-node diagram-node-focus" : "diagram-node"}
                  x={node.x}
                  y={node.y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx="6"
                />
                <text
                  className="diagram-label"
                  x={node.x + NODE_WIDTH / 2}
                  y={node.y + NODE_HEIGHT / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {label(node.title)}
                </text>
              </>
            );
            return node.ready && !node.focus ? (
              <a
                key={node.pageId}
                href={props.hrefFor(node.slug)}
                onClick={(event) => props.go(event, node.slug)}
              >
                {box}
              </a>
            ) : (
              <g key={node.pageId}>{box}</g>
            );
          })}
        </svg>
      </div>
      <figcaption id={`${id}-caption`}>{caption}</figcaption>
    </figure>
  );
}
