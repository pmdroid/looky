/**
 * A delivered answer: the complete prose first, then caveats, the outcome and
 * its uncertainty, the cited file and line ranges pinned to the answer's SHA,
 * and what the answer covers. All text comes from Looky and is untrusted: it
 * is rendered as text or through the Markdown subset, and only links Looky
 * built from its configured source template are clickable.
 */
import type { RefObject } from "react";
import type { AskProjectResponse } from "./api";
import type { AskSnapshot } from "./ask-runner";
import { LinkPolicy } from "./links";
import { Markdown } from "./markdown";
import { describeOutcome, displayRef, formatDuration, MODE_LABEL, shortSha } from "./presentation";

type Answered = Extract<AskProjectResponse, { status: "answered" }>;

const UNCOMMITTED: Record<Answered["scope"]["uncommittedChanges"], string> = {
  none: "There were no uncommitted changes to leave out.",
  excluded: "Uncommitted changes were left out.",
  unknown: "Uncommitted changes, if any, are not included.",
};

function count(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

function range(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`;
}

export function AnswerView({
  titleRef,
  onDeep,
  ...props
}: {
  readonly snapshot: AskSnapshot;
  readonly response: Answered;
  readonly sourceLinks: readonly (string | null)[];
  /** Receives focus when the answer arrives. */
  readonly titleRef?: RefObject<HTMLHeadingElement | null>;
  /** Offered when Fast suggests Deep; runs only when the person chooses it. */
  readonly onDeep?: () => void;
}) {
  const { response, snapshot } = props;
  const links = new LinkPolicy(props.sourceLinks);
  const outcome = describeOutcome(response.answer.outcome);
  const sha = response.revision.sha;
  const excluded = response.coverage?.excludedFiles ?? 0;

  return (
    <article className="answer" aria-labelledby="answer-title">
      <header className="answer-head">
        <h2 id="answer-title" className="section-title" ref={titleRef} tabIndex={-1}>
          {MODE_LABEL[response.mode.requested]} answer
        </h2>
        <p className="answer-question" dir="auto">
          {snapshot.question}
        </p>
      </header>

      <div className="prose">
        <Markdown text={response.answer.text} links={links} />
      </div>

      {response.answer.caveats.length > 0 ? (
        <section className="answer-section" aria-labelledby="caveats-title">
          <h3 id="caveats-title">Caveats</h3>
          <ul className="caveats">
            {response.answer.caveats.map((caveat, index) => (
              <li key={index} dir="auto">
                {caveat}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="answer-section" aria-labelledby="outcome-title">
        <h3 id="outcome-title">Certainty</h3>
        <p className={`outcome tone-${outcome.tone}`}>
          <strong>{outcome.label}.</strong> {outcome.detail}
        </p>
        {response.suggestedHumanQuestion ? (
          <div className="human-question">
            <p>The code does not say why. A question for the team:</p>
            <blockquote dir="auto">{response.suggestedHumanQuestion.question}</blockquote>
            <p className="hint" dir="auto">
              {response.suggestedHumanQuestion.reason}
            </p>
          </div>
        ) : null}
        {response.suggestedMode === "deep" && response.mode.requested === "fast" ? (
          <div className="deep-offer">
            <p>Deep may establish more with a larger research budget. It runs only if you ask.</p>
            {onDeep ? (
              <button type="button" className="button" onClick={onDeep}>
                Ask in Deep
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="answer-section" aria-labelledby="sources-title">
        <h3 id="sources-title">
          Sources at <code className="sha">{shortSha(sha)}</code>
        </h3>
        {response.evidence.length === 0 ? (
          <p className="hint">No source ranges were cited.</p>
        ) : (
          <ol className="sources">
            {response.evidence.map((ref, index) => {
              const href = links.href(props.sourceLinks[index] ?? "");
              const label = `${ref.path}:${range(ref.startLine, ref.endLine)}`;
              return (
                <li key={`${ref.path}:${ref.startLine}:${ref.endLine}`}>
                  {href ? (
                    <a
                      className="source-link"
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                    >
                      {label}
                    </a>
                  ) : (
                    <code className="source-path">{label}</code>
                  )}
                  {ref.symbol ? <span className="source-symbol"> {ref.symbol}</span> : null}
                  {ref.note ? (
                    <span className="source-note" dir="auto">
                      {ref.note}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="answer-section" aria-labelledby="details-title">
        <h3 id="details-title">About this answer</h3>
        <dl className="facts">
          <div>
            <dt>Repository</dt>
            <dd>{response.revision.repositoryId}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>
              {response.revision.ref ? `${displayRef(response.revision.ref)} at ` : ""}
              <code className="sha sha-full">{sha}</code>
            </dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>
              {MODE_LABEL[response.mode.requested]} requested,{" "}
              {response.mode.executed ? `${MODE_LABEL[response.mode.executed]} ran` : "none ran"}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              Committed files at this SHA only. {UNCOMMITTED[response.scope.uncommittedChanges]}
            </dd>
          </div>
          {response.coverage ? (
            <div>
              <dt>Index</dt>
              <dd>
                {response.coverage.indexedFiles.toLocaleString()} files searchable
                {excluded > 0
                  ? `, ${excluded.toLocaleString()} left out (${Object.entries(
                      response.coverage.excludedByReason,
                    )
                      .map(([reason, count]) => `${reason.replace(/_/g, " ")}: ${count}`)
                      .join(", ")})`
                  : ""}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Research</dt>
            <dd>
              {formatDuration(response.usage.elapsedMs)},{" "}
              {count(response.usage.sourceReads, "source read")},{" "}
              {count(response.usage.modelCalls, "model call")}
              {response.providers.length > 0 ? ` via ${response.providers.join(", ")}` : ""}
            </dd>
          </div>
        </dl>
        {response.limitations.length > 0 ? (
          <ul className="limitations">
            {response.limitations.map((limitation, index) => (
              <li key={index} dir="auto">
                {limitation}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </article>
  );
}
