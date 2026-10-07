import { useRef, useState } from 'react';
import { compareContracts, MAX_INPUT_BYTES, type Change, type Report } from './core';
import { BASELINE_SAMPLE, CANDIDATE_SAMPLE } from './sample';
import './styles.css';

function Icon({
  name,
  size = 18,
}: {
  name: 'brackets' | 'arrow' | 'upload' | 'download' | 'swap' | 'check' | 'code' | 'external';
  size?: number;
}) {
  const paths = {
    brackets: (
      <>
        <path d="M8 4H4v16h4M16 4h4v16h-4M10 12h4" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h16m-6-6 6 6-6 6" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),
    swap: (
      <>
        <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    code: (
      <>
        <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20" />
      </>
    ),
    external: (
      <>
        <path d="M14 4h6v6m0-6L10 14M10 4H4v16h16v-6" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

const initialReport = compareContracts(BASELINE_SAMPLE, CANDIDATE_SAMPLE);
const fmt = (value: number) => String(value).padStart(2, '0');

export default function App() {
  const [baseline, setBaseline] = useState(BASELINE_SAMPLE);
  const [candidate, setCandidate] = useState(CANDIDATE_SAMPLE);
  const [names, setNames] = useState(['workspace-v1.json', 'workspace-v2.json']);
  const [example, setExample] = useState(true);
  const [report, setReport] = useState<Report | null>(initialReport);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'breaking' | 'compatible'>('all');
  const [operation, setOperation] = useState('all');
  const [selected, setSelected] = useState<string | undefined>(
    initialReport.changes.find((c) => c.rule === 'parameter.required')?.id ??
      initialReport.changes[0]?.id,
  );
  const [guide, setGuide] = useState(false);
  const [loading, setLoading] = useState<boolean[]>([false, false]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const fileEpochs = useRef([0, 0]);
  const invalidate = () => {
    setReport(null);
    setError('');
    setExample(false);
    setSelected(undefined);
  };
  const update = (side: number, value: string) => {
    fileEpochs.current[side]++;
    setLoading((items) => items.map((item, i) => (i === side ? false : item)));
    invalidate();
    (side === 0 ? setBaseline : setCandidate)(value);
    setNames((items) => items.map((name, index) => (index === side ? 'Pasted contract' : name)));
  };
  async function load(side: number, file?: File) {
    if (!file) return;
    invalidate();
    const epoch = ++fileEpochs.current[side];
    setLoading((items) => items.map((item, i) => (i === side ? true : item)));
    try {
      if (file.size > MAX_INPUT_BYTES) throw new Error('Files must be 512 KiB or smaller.');
      const text = await file.text();
      if (fileEpochs.current[side] !== epoch) return;
      (side === 0 ? setBaseline : setCandidate)(text);
      setNames((items) => items.map((name, index) => (index === side ? file.name : name)));
    } catch (cause) {
      if (fileEpochs.current[side] === epoch)
        setError(cause instanceof Error ? cause.message : 'The file could not be read.');
    } finally {
      if (fileEpochs.current[side] === epoch)
        setLoading((items) => items.map((item, i) => (i === side ? false : item)));
    }
  }
  function compare() {
    setError('');
    try {
      const next = compareContracts(baseline, candidate);
      setReport(next);
      setFilter('all');
      setOperation('all');
      setSelected(next.changes.find((c) => c.severity === 'breaking')?.id ?? next.changes[0]?.id);
      setEditing(null);
    } catch (cause) {
      setReport(null);
      setError(cause instanceof Error ? cause.message : 'Unable to compare these contracts.');
    }
  }
  function resetExample() {
    fileEpochs.current = fileEpochs.current.map((x) => x + 1);
    setLoading([false, false]);
    setBaseline(BASELINE_SAMPLE);
    setCandidate(CANDIDATE_SAMPLE);
    setNames(['workspace-v1.json', 'workspace-v2.json']);
    setExample(true);
    setReport(initialReport);
    setError('');
    setEditing(null);
    setFilter('all');
    setOperation('all');
    setSelected(initialReport.changes.find((c) => c.rule === 'parameter.required')?.id);
  }
  function swap() {
    fileEpochs.current = fileEpochs.current.map((x) => x + 1);
    setLoading([false, false]);
    setBaseline(candidate);
    setCandidate(baseline);
    setNames([...names].reverse());
    invalidate();
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contractscope-report.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const operations = [...new Set(report?.changes.map((change) => change.operation) ?? [])];
  const visible =
    report?.changes.filter(
      (change) =>
        (filter === 'all' || change.severity === filter) &&
        (operation === 'all' || change.operation === operation),
    ) ?? [];
  const detail = visible.find((change) => change.id === selected) ?? visible[0];
  const isLoading = loading.some(Boolean);

  return (
    <>
      <header className="topbar">
        <a
          className="wordmark"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          <span className="mark">
            <Icon name="brackets" size={25} />
          </span>
          contractscope<span className="version">v0.1</span>
        </a>
        <nav aria-label="Main navigation">
          <span className="nav-current">Workbench</span>
          <button className="nav-link" onClick={() => setGuide(!guide)} aria-expanded={guide}>
            Rule guide
          </button>
          <a
            className="nav-link"
            href="https://github.com/miiduoa/contractscope"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <Icon name="external" size={13} />
          </a>
        </nav>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">
              <span className="tiny-line" /> OPENAPI CHANGE REVIEW
            </p>
            <h1>
              Know what changes.
              <br />
              <span>Before they ship.</span>
            </h1>
          </div>
          <div className="intro-right">
            <p>
              Compare API contracts. Find changes that affect your callers. See exactly what needs a
              closer look.
            </p>
            <div className="privacy">
              <span className="status-light" /> Files stay in this browser{' '}
              <span className="dot">·</span> JSON / YAML
            </div>
          </div>
        </section>

        {guide && (
          <section className="guide" aria-label="Rule guide">
            <div className="section-label">THE COMPATIBILITY DIRECTION</div>
            <div className="guide-columns">
              <div>
                <h3>Requests may accept more.</h3>
                <p>
                  Adding a required input or removing an accepted enum value breaks callers. Making
                  an input optional widens the accepted set.
                </p>
              </div>
              <div>
                <h3>Responses may promise more.</h3>
                <p>
                  Removing a guaranteed field or adding a possible enum value can break callers.
                  Adding a field to a closed response object also violates its old schema.
                </p>
              </div>
              <div>
                <h3>Unknown means unreviewed.</h3>
                <p>
                  Open objects, composition, external or cyclic refs, validation bounds, security,
                  and wire formats produce coverage warnings. This is a structural review, not a
                  release approval.
                </p>
              </div>
            </div>
            <a href="https://spec.openapis.org/oas/v3.1.1.html" target="_blank" rel="noreferrer">
              OpenAPI 3.1.1 specification <Icon name="external" size={13} />
            </a>
          </section>
        )}

        <section className="inputs" aria-label="Contract inputs">
          {[baseline, candidate].map((text, side) => (
            <article className={`input-card ${side === 1 ? 'candidate' : ''}`} key={side}>
              <div className="card-top">
                <span className="section-label">
                  <span className="number">0{side + 1}</span>
                  {side === 0 ? 'BASELINE' : 'CANDIDATE'}
                </span>
                <span className="card-caption">
                  {side === 0 ? 'What clients rely on' : 'What you want to ship'}
                </span>
              </div>
              <div className="file-row">
                <span className="file-icon">
                  <Icon name="code" size={23} />
                </span>
                <div className="file-info">
                  <strong title={names[side]}>
                    {loading[side] ? 'Reading file…' : names[side]}
                  </strong>
                  <span>
                    {report
                      ? `${side === 0 ? report.baseline.version : report.candidate.version} · ${side === 0 ? report.baseline.operationCount : report.candidate.operationCount} operations`
                      : `${(new TextEncoder().encode(text).byteLength / 1024).toFixed(1)} KiB · waiting for comparison`}
                  </span>
                </div>
                <button
                  className="button upload"
                  onClick={() => inputRefs.current[side]?.click()}
                  aria-label={`Choose ${side === 0 ? 'baseline' : 'candidate'} file`}
                >
                  <Icon name="upload" size={16} /> Choose file
                </button>
              </div>
              <input
                className="visually-hidden"
                aria-label={`${side === 0 ? 'Baseline' : 'Candidate'} contract file`}
                ref={(element) => {
                  inputRefs.current[side] = element;
                }}
                type="file"
                accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                onChange={(event) => {
                  void load(side, event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <div className="card-bottom">
                <span>
                  {example ? (
                    <>
                      <span className="example-dot" /> EXAMPLE CONTRACT
                    </>
                  ) : (
                    'LOCAL INPUT · 512 KiB MAX'
                  )}
                </span>
                <button
                  className="text-button"
                  onClick={() => setEditing(editing === side ? null : side)}
                  aria-expanded={editing === side}
                >
                  {editing === side ? 'Close source' : 'Edit or paste source'} <span>↗</span>
                </button>
              </div>
            </article>
          ))}
        </section>
        {editing !== null && (
          <section className="editor-panel">
            <label htmlFor="source-editor">
              {editing === 0 ? 'Baseline' : 'Candidate'} source{' '}
              <span>JSON or YAML · edits clear the previous result</span>
            </label>
            <textarea
              id="source-editor"
              value={editing === 0 ? baseline : candidate}
              onChange={(event) => update(editing, event.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <div className="editor-footer">
              The comparator supports OpenAPI 3.0.x and 3.1.x. Other versions are rejected.
            </div>
          </section>
        )}
        <div className="actionbar">
          <div className="action-left">
            <button className="button secondary" onClick={swap} disabled={isLoading}>
              <Icon name="swap" size={15} /> Swap direction
            </button>
            <button className="text-button quiet" onClick={resetExample}>
              Load example
            </button>
          </div>
          <div className="action-right">
            {!report && !error && (
              <span className="pending">Inputs changed. Compare to refresh.</span>
            )}
            <button className="button primary" onClick={compare} disabled={isLoading}>
              Compare contracts <Icon name="arrow" size={17} />
            </button>
          </div>
        </div>
        {error && (
          <div className="error" role="alert">
            <strong>Could not compare these contracts.</strong>
            <pre>{error}</pre>
            <p>Correct the source and compare again. No previous result is shown.</p>
          </div>
        )}

        {report && (
          <section className="results" aria-label="Comparison results">
            <div className="results-heading">
              <div>
                <p className="section-label">
                  COMPARISON REPORT {example && <span className="example-label">EXAMPLE</span>}
                </p>
                <h2>
                  {report.summary.breaking
                    ? 'Some promises have changed.'
                    : report.warnings.length
                      ? 'This contract needs a closer look.'
                      : report.changes.length
                        ? 'The supported rules found no breaks.'
                        : 'No structural changes found.'}
                </h2>
              </div>
              <button className="button export" onClick={download}>
                <Icon name="download" size={16} /> Export JSON
              </button>
            </div>
            <div className="summary-strip">
              <div className="metric breaking">
                <span className="metric-number">{fmt(report.summary.breaking)}</span>
                <div>
                  <strong>Breaking</strong>
                  <span>Existing callers may be affected</span>
                </div>
              </div>
              <div className="metric compatible">
                <span className="metric-number">{fmt(report.summary.compatible)}</span>
                <div>
                  <strong>Compatible changes</strong>
                  <span>Within the supported rules</span>
                </div>
              </div>
              <div className={`metric coverage ${report.warnings.length ? 'has-warnings' : ''}`}>
                <span className="metric-number">{fmt(report.warnings.length)}</span>
                <div>
                  <strong>Coverage warnings</strong>
                  <span>
                    {report.warnings.length
                      ? 'A complete verdict is unavailable'
                      : 'All encountered rules supported'}
                  </span>
                </div>
              </div>
            </div>
            <div className="report-toolbar">
              <div className="filter-tabs" role="group" aria-label="Filter changes">
                {(['all', 'breaking', 'compatible'] as const).map((value) => (
                  <button
                    aria-pressed={filter === value}
                    className={filter === value ? 'active' : ''}
                    key={value}
                    onClick={() => setFilter(value)}
                  >
                    {value === 'all'
                      ? 'All changes'
                      : value === 'breaking'
                        ? 'Breaking'
                        : 'Compatible'}
                    <span>{value === 'all' ? report.changes.length : report.summary[value]}</span>
                  </button>
                ))}
              </div>
              <span className={`coverage-note ${report.warnings.length ? 'warning-text' : ''}`}>
                <Icon name={report.warnings.length ? 'code' : 'check'} size={14} />{' '}
                {report.warnings.length ? 'Incomplete coverage' : 'Supported scope reviewed'}
              </span>
            </div>
            <div className="review-grid">
              <aside className="operation-nav" aria-label="Filter by operation">
                <div className="section-label">OPERATIONS</div>
                <button
                  onClick={() => setOperation('all')}
                  className={operation === 'all' ? 'active' : ''}
                  aria-pressed={operation === 'all'}
                >
                  <span>All operations</span>
                  <b>{report.changes.length}</b>
                </button>
                {operations.map((id) => (
                  <button
                    key={id}
                    className={operation === id ? 'active endpoint' : 'endpoint'}
                    onClick={() => setOperation(id)}
                    aria-pressed={operation === id}
                  >
                    <span>
                      <Method operation={id} />
                      <code>{id.slice(id.indexOf(' ') + 1)}</code>
                    </span>
                    <b>{report.changes.filter((c) => c.operation === id).length}</b>
                  </button>
                ))}
                <div className="direction-note">
                  <span>COMPARISON DIRECTION</span>
                  <p>
                    {report.baseline.version}
                    <br />
                    <span>↓</span>
                    <br />
                    {report.candidate.version}
                  </p>
                </div>
              </aside>
              <div className="change-list" aria-label="Changes">
                {visible.length ? (
                  visible.map((change) => (
                    <button
                      key={change.id}
                      className={`change-item ${detail?.id === change.id ? 'selected' : ''}`}
                      onClick={() => setSelected(change.id)}
                      aria-pressed={detail?.id === change.id}
                    >
                      <span className={`change-dot ${change.severity}`} />
                      <span className="change-content">
                        <span className="change-meta">
                          <Method operation={change.operation} />
                          <code>{change.operation.slice(change.operation.indexOf(' ') + 1)}</code>
                          <span className="change-index">{change.id.replace('change-', '#')}</span>
                        </span>
                        <strong>{change.title}</strong>
                        <span className="change-description">{change.rationale}</span>
                      </span>
                      <span className="row-arrow">↗</span>
                    </button>
                  ))
                ) : (
                  <div className="empty-state">
                    <Icon name="check" size={27} />
                    <h3>
                      {report.changes.length ? 'Nothing in this view.' : 'No changes detected.'}
                    </h3>
                    <p>
                      {report.warnings.length
                        ? 'Review the coverage warnings below before drawing a conclusion.'
                        : report.changes.length
                          ? 'Choose another severity or operation to see its changes.'
                          : 'The supported structural rules found no differences.'}
                    </p>
                  </div>
                )}
              </div>
              <aside className="detail-panel" aria-label="Selected change">
                {detail ? (
                  <ChangeDetail change={detail} />
                ) : (
                  <div className="detail-empty">
                    <Icon name="brackets" size={32} />
                    <p>Select a change to inspect the rule and its compatibility direction.</p>
                  </div>
                )}
              </aside>
            </div>
            {report.warnings.length > 0 && (
              <section className="warnings">
                <h3>
                  Coverage needs attention <span>{report.warnings.length}</span>
                </h3>
                <p>
                  These parts were not fully evaluated. Detected changes remain useful, but this
                  report cannot establish compatibility.
                </p>
                <ul>
                  {report.warnings.map((warning, index) => (
                    <li key={index}>
                      <span className="warning-source">{warning.source}</span>
                      <code>{warning.location}</code>
                      <p>{warning.message}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="report-footnote">
              <span>Structural compatibility ≠ behavioral compatibility.</span>
              <span>
                Authentication, business behavior, deployment, and generated SDKs need separate
                review.
              </span>
            </div>
          </section>
        )}
        {!report && !error && (
          <section className="waiting">
            <Icon name="brackets" size={32} />
            <h2>Ready when your contracts are.</h2>
            <p>
              Compare the baseline with the candidate to see the directional impact of each
              supported change.
            </p>
          </section>
        )}
      </main>
      <footer>
        <span>
          <Icon name="brackets" size={17} /> contractscope
        </span>
        <p>Small rules. Explicit limits. Reviewable decisions.</p>
        <a
          href="https://github.com/miiduoa/contractscope/blob/main/docs/design.zh-TW.md"
          target="_blank"
          rel="noreferrer"
        >
          設計筆記 <Icon name="external" size={12} />
        </a>
      </footer>
    </>
  );
}

function Method({ operation }: { operation: string }) {
  const method = operation.split(' ')[0];
  return <span className={`method method-${method.toLowerCase()}`}>{method}</span>;
}
function ChangeDetail({ change }: { change: Change }) {
  return (
    <>
      <div className="detail-top">
        <span className="section-label">CHANGE DETAIL</span>
        <span className={`severity-label ${change.severity}`}>
          {change.severity === 'breaking' ? 'BREAKING' : 'COMPATIBLE'}
        </span>
      </div>
      <h3>{change.title}</h3>
      <p className="detail-rationale">{change.rationale}</p>
      <div className="value-comparison">
        <div>
          <span>BASELINE</span>
          <code>{change.before ?? '—'}</code>
        </div>
        <span className="value-arrow">↓</span>
        <div>
          <span>CANDIDATE</span>
          <code>{change.after ?? '—'}</code>
        </div>
      </div>
      <div className="detail-location">
        <span className="section-label">WHERE TO LOOK</span>
        <code>{change.operation}</code>
        <code className="pointer">{change.location}</code>
      </div>
      <div className="rule-reference">
        <span className="section-label">RULE</span>
        <code>{change.rule}</code>
      </div>
      <div className="detail-advice">
        <span className={`change-dot ${change.severity}`} />
        <p>
          {change.severity === 'breaking'
            ? 'Check affected callers before releasing. A version change alone does not make existing callers compatible.'
            : 'Compatible under the supported structural rules. Review any coverage warnings before releasing.'}
        </p>
      </div>
    </>
  );
}
