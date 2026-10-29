import { useEffect, useState } from "react";
import { request } from "../client";
import { contrastRatio } from "../contrast";

type Token = {
  name: string;
  value: string;
  source: string;
  line: number;
  consumers: string[];
  context?: string;
};
type Finding = { source: string; line: number; value: string; kind: string };
type Report = {
  tokens: Token[];
  hardcoded: Finding[];
  coverage: { covered: string[]; uncovered: string[] };
  scales: Record<string, unknown>;
};
const tabs = ["tokens", "hardcoded", "coverage", "contrast", "scales"];
export function AnalysisView() {
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState("tokens");
  const [search, setSearch] = useState("");
  const load = () => {
    setError("");
    void request<Report>("analysis")
      .then(setReport)
      .catch((error) => setError(String(error)));
  };
  useEffect(load, []);
  return (
    <div className="lab-analysis-page">
      <div className="lab-eyebrow">LOOK A LITTLE CLOSER</div>
      <div className="lab-analysis-heading">
        <div>
          <h1>The system, in focus.</h1>
          <p>
            Source-derived observations. A place to notice, not a list of
            verdicts.
          </p>
        </div>
        <button className="lab-secondary" onClick={load}>
          Refresh inventory ↻
        </button>
      </div>
      {error && (
        <p className="lab-alert" role="alert">
          {error}
        </p>
      )}
      {!report && !error && <p className="lab-empty">Reading the system…</p>}
      {report && (
        <>
          <div className="lab-stats">
            <div>
              <strong>{report.tokens.length}</strong>
              <span>Token declarations</span>
            </div>
            <div>
              <strong>{report.hardcoded.length}</strong>
              <span>Literal candidates</span>
            </div>
            <div>
              <strong>{report.coverage.covered.length}</strong>
              <span>Covered source files</span>
            </div>
            <div>
              <strong>{report.coverage.uncovered.length}</strong>
              <span>Without a Lab entry</span>
            </div>
          </div>
          <div
            className="lab-workspace-tabs"
            role="tablist"
            aria-label="Analysis views"
          >
            {tabs.map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={tab === item}
                onClick={() => setTab(item)}
              >
                {item === "hardcoded"
                  ? "Hard-coded values"
                  : item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
          <div className="lab-analysis-body">
            {tab !== "contrast" && (
              <input
                className="lab-analysis-search"
                aria-label="Search analysis"
                placeholder="Filter by token, value or source…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
            {tab === "tokens" && (
              <>
                <p className="lab-analysis-hint">
                  Declarations retain their source context. Consumers include
                  token aliases and theme utilities; they do not prove runtime
                  use.
                </p>
                <div className="lab-table-scroll">
                  <table className="lab-table">
                    <thead>
                      <tr>
                        <th>Token</th>
                        <th>Value</th>
                        <th>Source</th>
                        <th>Direct consumers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.tokens
                        .filter((token) =>
                          `${token.name} ${token.value} ${token.source}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .map((token, index) => (
                          <tr key={`${token.source}-${token.line}-${index}`}>
                            <td>
                              <span
                                className="lab-token-swatch"
                                style={{ background: token.value }}
                              />
                              <code>{token.name}</code>
                            </td>
                            <td>
                              <code>{token.value}</code>
                              {token.context && <small>{token.context}</small>}
                            </td>
                            <td>
                              <code>
                                {token.source}:{token.line}
                              </code>
                            </td>
                            <td>
                              <details>
                                <summary>
                                  {token.consumers.length} files
                                </summary>
                                {token.consumers.map((consumer) => (
                                  <code className="lab-consumer" key={consumer}>
                                    {consumer}
                                  </code>
                                ))}
                              </details>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {tab === "hardcoded" && (
              <>
                <p className="lab-analysis-hint">
                  Heuristic candidates: a literal is not automatically a defect.
                  Layout dimensions and intentional exceptions need judgment.
                </p>
                <table className="lab-table">
                  <thead>
                    <tr>
                      <th>Literal</th>
                      <th>Kind</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.hardcoded
                      .filter((finding) =>
                        JSON.stringify(finding)
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map((finding, index) => (
                        <tr key={index}>
                          <td>
                            <code>{finding.value}</code>
                          </td>
                          <td>{finding.kind}</td>
                          <td>
                            <code>
                              {finding.source}:{finding.line}
                            </code>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </>
            )}
            {tab === "coverage" && (
              <>
                <h2>A map of the gaps.</h2>
                <p className="lab-analysis-hint">
                  Coverage matches a live component or page file to an entry's
                  declared sources. It is not a claim that every interaction is
                  exercised.
                </p>
                {["uncovered", "covered"].map((key) => (
                  <section className="lab-coverage" key={key}>
                    <h3>
                      {key === "uncovered"
                        ? "Room for another entry"
                        : "On the workbench"}
                    </h3>
                    {report.coverage[key as "covered" | "uncovered"]
                      .filter((file) =>
                        file.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((file) => (
                        <code key={file}>{file}</code>
                      ))}
                  </section>
                ))}
              </>
            )}
            {tab === "contrast" && <Contrast tokens={report.tokens} />}
            {tab === "scales" && (
              <div className="lab-scales">
                {Object.entries(report.scales).map(([scale, values]) => (
                  <section key={scale}>
                    <h2>{scale[0].toUpperCase() + scale.slice(1)} scale</h2>
                    <p className="lab-analysis-hint">
                      Observed in live source. Repeated literals suggest
                      opportunities for a shared token.
                    </p>
                    <pre>
                      {JSON.stringify(values, null, 2)
                        .split("\n")
                        .filter(
                          (line) =>
                            !search ||
                            line.toLowerCase().includes(search.toLowerCase()),
                        )
                        .join("\n")}
                    </pre>
                  </section>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
function sampleColor(value: string): [number, number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas color conversion unavailable");
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const pixel = context.getImageData(0, 0, 1, 1).data;
  return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
}
function Contrast({ tokens }: { tokens: Token[] }) {
  const names = [
    ...new Set(
      tokens
        .filter((token) => /oklch|^#|^rgb|^hsl|^color\(/.test(token.value))
        .map((token) => token.name),
    ),
  ];
  const [foreground, setForeground] = useState("--muted-foreground");
  const [background, setBackground] = useState("--background");
  const [theme, setTheme] = useState("light");
  const [result, setResult] = useState({
    ratio: 0,
    foreground: "#000",
    background: "#fff",
  });
  useEffect(() => {
    const element = document.createElement("div");
    element.className = theme === "dark" ? "dark" : "";
    element.style.cssText = "position:fixed;visibility:hidden";
    document.body.append(element);
    element.style.color = `var(${foreground})`;
    element.style.backgroundColor = `var(${background})`;
    const computed = getComputedStyle(element);
    const front = computed.color;
    const back = computed.backgroundColor;
    const [r, g, b, a] = sampleColor(front);
    const [rawR, rawG, rawB, backAlpha] = sampleColor(back);
    const [baseR, baseG, baseB] = sampleColor(
      computed.getPropertyValue("--background").trim() || "#fff",
    );
    const [br, bg, bb] = [
      rawR * backAlpha + baseR * (1 - backAlpha),
      rawG * backAlpha + baseG * (1 - backAlpha),
      rawB * backAlpha + baseB * (1 - backAlpha),
    ];
    const mixed: [number, number, number] = [
      r * a + br * (1 - a),
      g * a + bg * (1 - a),
      b * a + bb * (1 - a),
    ];
    setResult({
      ratio: contrastRatio(mixed, [br, bg, bb]),
      foreground: front,
      background: `rgb(${br} ${bg} ${bb})`,
    });
    element.remove();
  }, [foreground, background, theme]);
  return (
    <section className="lab-contrast">
      <h2>Make every word readable.</h2>
      <p className="lab-analysis-hint">
        WCAG 2.x sRGB luminance. OKLCH tokens are converted by the browser;
        alpha is composited over the chosen background and the theme's base
        surface.
      </p>
      <div className="lab-contrast-controls">
        <label>
          Foreground
          <select
            value={foreground}
            onChange={(event) => setForeground(event.target.value)}
          >
            {names.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Background
          <select
            value={background}
            onChange={(event) => setBackground(event.target.value)}
          >
            {names.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Theme
          <select
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
          >
            <option>light</option>
            <option>dark</option>
          </select>
        </label>
      </div>
      <div
        className="lab-contrast-sample"
        style={{ background: result.background, color: result.foreground }}
      >
        <h3>A thought worth keeping.</h3>
        <p>The small details make room for the words.</p>
      </div>
      <div className="lab-contrast-result">
        <strong>
          {result.ratio.toFixed(2)}
          <small>:1</small>
        </strong>
        <span>
          Normal text AA: <b>{result.ratio >= 4.5 ? "Pass" : "Fail"}</b>
        </span>
        <span>
          Large text AA: <b>{result.ratio >= 3 ? "Pass" : "Fail"}</b>
        </span>
        <span>
          Normal text AAA: <b>{result.ratio >= 7 ? "Pass" : "Fail"}</b>
        </span>
      </div>
    </section>
  );
}
