/** Render the ignored action-evidence JSON as one self-contained, read-only HTML page. */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  actionEvidenceHtmlPath,
  actionEvidenceJsonPath,
  readActionEvidence,
  type ActionEvidence,
} from "./action-evidence-file.ts";

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, highlight: highlightCode });
markdown.disable("image");

export async function renderActionEvidencePage(
  inputPath = actionEvidenceJsonPath,
  outputPath = actionEvidenceHtmlPath,
): Promise<string> {
  const evidence = await readActionEvidence(inputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, page(evidence), "utf8");
  return outputPath;
}

function page(evidence: ActionEvidence): string {
  const callsByName = new Map(evidence.calls.map((call) => [call.name, call]));
  const failed = evidence.calls.filter((call) => call.response.isError && !call.expectedError).length;
  const expectedFailures = evidence.calls.filter((call) => call.expectedError).length;
  const cards = evidence.tools.map((tool, index) => toolCard(tool, callsByName.get(tool.name), index)).join("\n");
  const navigation = evidence.tools
    .map(
      (tool, index) =>
        `<a href="#tool-${index}" data-tool-link data-search="${attribute(`${tool.name} ${tool.description ?? ""}`)}"><span>${String(index + 1).padStart(2, "0")}</span><code>${escapeHtml(tool.name)}</code></a>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mine AI MCP evidence</title>
  <style>
    :root { color-scheme: light; --bg: #fbfbfa; --surface: #fff; --sidebar: #f6f6f3; --soft: #f7f8fa; --line: #e4e4df; --line-strong: #d5d5ce; --text: #1e2522; --muted: #68716c; --faint: #929a95; --green: #18794e; --green-bg: #e8f5ee; --blue: #2457a7; --blue-bg: #eaf1fb; --violet: #6941a5; --violet-bg: #f1ebfa; --amber: #9a5700; --amber-bg: #fff1d6; --red: #b42318; --red-bg: #feebe9; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.65 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-rendering: optimizeLegibility; }
    code, pre { font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace; }
    a { color: var(--blue); }
    .layout { display: grid; grid-template-columns: 272px minmax(0, 1fr); min-height: 100vh; }
    aside { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 30px 20px 24px; border-right: 1px solid var(--line); background: var(--sidebar); }
    .brand { display: flex; align-items: center; gap: 11px; margin-bottom: 8px; }
    .brand-mark { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid var(--line-strong); border-radius: 9px; background: var(--surface); color: var(--green); font: 700 12px/1 ui-monospace, monospace; box-shadow: 0 1px 2px rgb(20 30 25 / 5%); }
    aside h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
    aside .caption { margin: 0 0 24px 45px; color: var(--faint); font-size: 12px; }
    .search-label { display: block; margin: 0 0 7px; color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
    input { width: 100%; margin-bottom: 18px; padding: 9px 11px; color: var(--text); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 7px; outline: none; font: inherit; font-size: 13px; }
    input:focus { border-color: #8ba7d3; box-shadow: 0 0 0 3px rgb(36 87 167 / 9%); }
    nav { display: grid; gap: 2px; }
    nav a { display: grid; grid-template-columns: 24px 1fr; gap: 4px; align-items: center; padding: 7px 9px; color: var(--muted); text-decoration: none; border-radius: 6px; }
    nav a > span { color: var(--faint); font: 10px/1 ui-monospace, monospace; }
    nav a code { overflow: hidden; font-size: 11px; text-overflow: ellipsis; }
    nav a:hover, nav a:focus, nav a.active { color: var(--text); background: #eaeae5; }
    nav a.active { box-shadow: inset 2px 0 var(--green); }
    .sidebar-note { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--faint); font-size: 11px; }
    main { width: min(1060px, 100%); padding: 68px clamp(30px, 6vw, 88px) 120px; }
    .page-header { margin-bottom: 76px; }
    .eyebrow { display: flex; align-items: center; gap: 8px; margin: 0 0 18px; color: var(--green); font-size: 11px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
    .eyebrow::before { content: ""; width: 18px; height: 1px; background: currentColor; }
    .page-header h2 { max-width: 720px; margin: 0 0 18px; font-size: clamp(34px, 5vw, 52px); font-weight: 620; line-height: 1.08; letter-spacing: -.045em; }
    .page-header > p { max-width: 720px; margin: 0; color: var(--muted); font-size: 17px; }
    .page-header code { padding: 1px 4px; color: var(--violet); background: var(--violet-bg); border-radius: 4px; font-size: .88em; }
    .stats { display: flex; flex-wrap: wrap; gap: 22px; margin-top: 30px; padding-top: 22px; border-top: 1px solid var(--line); }
    .stat { display: grid; gap: 1px; color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
    .stat strong { color: var(--text); font-size: 14px; font-weight: 600; letter-spacing: 0; text-transform: none; }
    article { margin: 0 0 92px; padding: 0 0 76px; border-bottom: 1px solid var(--line); scroll-margin-top: 34px; }
    .tool-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 11px; }
    article h3 { margin: 0; font-size: 25px; font-weight: 610; letter-spacing: -.025em; }
    article h3 code { color: var(--text); font-family: inherit; }
    .anchor { margin-left: 6px; color: var(--line-strong); text-decoration: none; }
    .anchor:hover { color: var(--blue); }
    article > p { max-width: 780px; margin: 0; color: var(--muted); font-size: 15px; }
    .badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 750; letter-spacing: .045em; text-transform: uppercase; white-space: nowrap; }
    .badge::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .badge.good { color: var(--green); background: var(--green-bg); }
    .badge.bad { color: var(--red); background: var(--red-bg); }
    .badge.info { color: var(--blue); background: var(--blue-bg); }
    .badge.task { color: var(--violet); background: var(--violet-bg); }
    .badge.neutral { color: #59615d; background: #ededeb; }
    section { margin-top: 38px; }
    .section-heading { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
    .section-heading h4 { margin: 0; font-size: 14px; font-weight: 650; }
    .section-tag { padding: 2px 6px; border-radius: 4px; font: 750 9px/1.6 ui-monospace, monospace; letter-spacing: .08em; }
    .section-tag.input { color: var(--blue); background: var(--blue-bg); }
    .section-tag.output { color: var(--green); background: var(--green-bg); }
    .section-note { margin-left: auto; color: var(--faint); font-size: 12px; }
    .response-section { margin-top: 30px; }
    .response-section .section-heading { margin-bottom: 14px; }
    .response-section .section-heading h4 { font-size: 16px; }
    .response-source { padding: 1px 5px; color: var(--green); background: var(--green-bg); border-radius: 4px; font-size: 11px; }
    .request-block { overflow: hidden; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 11px 13px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    tr:last-child td { border-bottom: 0; }
    th { color: var(--faint); background: var(--soft); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    td:first-child code { color: var(--violet); font-weight: 650; }
    .presence { display: inline-flex; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
    .presence.required { color: var(--blue); background: var(--blue-bg); }
    .presence.optional { color: #646c67; background: #efefec; }
    .type { color: var(--amber); font-family: ui-monospace, monospace; font-size: 12px; }
    .default-value { font-size: 12px; white-space: nowrap; }
    .no-default { color: var(--faint); }
    .code-panel { overflow: hidden; margin-top: 12px; border: 1px solid var(--line); border-radius: 9px; background: #f8f9fb; }
    .code-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--line); color: var(--faint); background: #f3f4f6; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .code-panel-header span:last-child { color: var(--blue); }
    pre { overflow: auto; margin: 0; padding: 15px 17px; color: #313936; background: transparent; font-size: 12px; line-height: 1.65; white-space: pre; tab-size: 2; }
    .json-key { color: #6941a5; }
    .json-string { color: #0f766e; }
    .json-number { color: #a34f00; }
    .json-boolean { color: #2457a7; }
    .json-null { color: #7b827e; font-style: italic; }
    .response-envelope { overflow: hidden; border: 1px solid #cfe3d7; border-top: 3px solid #5ca67b; background: #f6fbf8; border-radius: 9px; box-shadow: 0 8px 24px rgb(36 82 55 / 6%); }
    .response-meta { display: flex; align-items: center; gap: 10px; padding: 11px 17px; border-bottom: 1px solid #dcebe2; background: #f0f8f3; }
    .response-status { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase; }
    .response-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .response-status.succeeded { color: var(--green); background: var(--green-bg); }
    .response-status.partial { color: var(--amber); background: var(--amber-bg); }
    .response-status.failed { color: var(--red); background: var(--red-bg); }
    .response-status.unknown { color: var(--muted); background: #e9ebe9; }
    .response-duration { display: inline-flex; align-items: baseline; gap: 7px; margin-left: auto; color: var(--text); }
    .response-duration strong { font-size: 13px; font-weight: 650; }
    .response-duration small { color: var(--faint); font: 10px/1 ui-monospace, monospace; }
    .markdown { padding: 25px 30px 28px; color: #25302a; }
    .markdown > :first-child { margin-top: 0; }
    .markdown > :last-child { margin-bottom: 0; }
    .markdown h2, .markdown h3 { color: #17201b; font-weight: 620; letter-spacing: -.02em; }
    .markdown h2 { font-size: 19px; }
    .markdown h3 { font-size: 16px; }
    .markdown code { padding: 1px 4px; color: var(--violet); background: #ece7f3; border-radius: 4px; font-size: .9em; }
    .markdown pre { position: relative; padding: 36px 18px 17px; color: #dbe7df; background: #202a25; border-radius: 7px; white-space: pre; }
    .markdown pre code { display: block; padding: 0; color: inherit; background: transparent; border-radius: 0; font-size: 12px; }
    .code-language { position: absolute; top: 10px; right: 12px; color: #8da097; font: 700 9px/1 ui-monospace, monospace; letter-spacing: .1em; }
    .hljs-comment, .hljs-quote { color: #8b9b93; font-style: italic; }
    .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type { color: #ff8a80; }
    .hljs-string, .hljs-regexp, .hljs-attribute { color: #a8d8a8; }
    .hljs-number, .hljs-symbol, .hljs-bullet { color: #79b8ff; }
    .hljs-title, .hljs-section, .hljs-selector-id { color: #d2a8ff; }
    .hljs-built_in, .hljs-builtin-name, .hljs-variable, .hljs-template-variable { color: #f6bd60; }
    .hljs-meta, .hljs-selector-attr, .hljs-selector-pseudo { color: #7ee2c5; }
    .hljs-operator, .hljs-punctuation { color: #c9d7cf; }
    .markdown table { color: #25302a; background: var(--surface); }
    .markdown th { color: #55615a; background: #edf3ef; }
    .protocol { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 38px; }
    details { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); }
    details.raw-response { grid-column: 1 / -1; }
    summary { cursor: pointer; padding: 9px 12px; color: var(--muted); font-size: 12px; list-style-position: inside; }
    summary:hover { color: var(--text); background: var(--soft); }
    details pre { border-top: 1px solid var(--line); background: #f8f9fb; }
    details.raw-response pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .empty { color: var(--muted); font-style: italic; }
    .no-results { margin: 40px 0; padding: 24px; color: var(--muted); border: 1px dashed var(--line-strong); border-radius: 8px; text-align: center; }
    [hidden] { display: none !important; }
    @media (max-width: 820px) { .layout { display: block; } aside { position: static; width: auto; height: auto; border-right: 0; border-bottom: 1px solid var(--line); } aside .caption { margin-left: 45px; } nav { grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); } .sidebar-note { display: none; } main { padding: 42px 24px 80px; } .page-header { margin-bottom: 58px; } .tool-heading { display: block; } .badges { justify-content: flex-start; margin: 14px 0; } .protocol { grid-template-columns: 1fr; } }
    @media (max-width: 560px) { .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } .request-block { overflow-x: auto; } table { min-width: 640px; } .section-note { display: none; } }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <div class="brand"><span class="brand-mark">AI</span><h1>Mine AI MCP</h1></div>
      <p class="caption">MCP reference</p>
      <label class="search-label" for="tool-search">Catalogue</label>
      <input id="tool-search" type="search" placeholder="Filter tools…" aria-label="Filter tools">
      <nav>${navigation}</nav>
      <p class="sidebar-note">Generated from observed calls.<br>No examples are maintained by hand.</p>
    </aside>
    <main>
      <header class="page-header">
        <p class="eyebrow">Observed interface</p>
        <h2>Minecraft actions,<br>as they actually respond.</h2>
        <p>Real MCP schemas and default-Markdown responses captured by <code>${escapeHtml(evidence.scenario)}</code> against Minecraft ${escapeHtml(evidence.minecraftVersion)}.</p>
        <div class="stats">
          <span class="stat">Catalogue<strong>${evidence.tools.length} published tools</strong></span>
          <span class="stat">Evidence<strong>${evidence.calls.length} captured calls</strong></span>
          <span class="stat">Unexpected failures<strong>${failed}</strong></span>
          <span class="stat">Arranged failure responses<strong>${expectedFailures}</strong></span>
          <span class="stat">Generated<strong>${escapeHtml(formatDate(evidence.generatedAt))}</strong></span>
        </div>
      </header>
      <p class="no-results" id="no-results" hidden>No tools match that filter.</p>
      ${cards}
    </main>
  </div>
  <script>
    const search = document.querySelector('#tool-search');
    const cards = [...document.querySelectorAll('[data-tool-card]')];
    const links = [...document.querySelectorAll('[data-tool-link]')];
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      for (const element of [...cards, ...links]) {
        element.hidden = query.length > 0 && !element.dataset.search.includes(query);
      }
      document.querySelector('#no-results').hidden = cards.some(card => !card.hidden);
    });
    const observed = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      links.forEach(link => link.classList.toggle('active', link.hash === '#' + visible.target.id));
    }, { rootMargin: '-10% 0px -70% 0px', threshold: [0, .2, .5] });
    cards.forEach(card => observed.observe(card));
  </script>
</body>
</html>\n`;
}

function toolCard(tool: Tool, call: ActionEvidence["calls"][number] | undefined, index: number): string {
  const markdownText = call ? textContent(call.response.content) : "";
  const search = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  return `<article id="tool-${index}" data-tool-card data-search="${attribute(search)}">
    <div class="tool-heading">
      <h3><code>${escapeHtml(tool.name)}</code><a class="anchor" href="#tool-${index}" aria-label="Link to ${attribute(tool.name)}">#</a></h3>
      <div class="badges">${badges(tool, call)}</div>
    </div>
    <p>${escapeHtml(tool.description ?? "No description published.")}</p>
    <section>
      <div class="section-heading"><span class="section-tag input">INPUT</span><h4>Request</h4><span class="section-note">Published arguments and captured example</span></div>
      <div class="request-block">${argumentTable(tool)}</div>
      <div class="code-panel">
        <div class="code-panel-header"><span>Captured request</span><span>JSON</span></div>
        <pre>${highlightJson(call?.arguments ?? null)}</pre>
      </div>
    </section>
    <section class="response-section">
      <div class="section-heading"><span class="section-tag output">MODEL RESPONSE</span><h4>Rendered Markdown</h4><span class="section-note">Always visible from <code class="response-source">response.content[].text</code></span></div>
      ${renderModelResponse(markdownText)}
      ${call?.expectedError ? `<p>Arranged boundary: <code>${escapeHtml(call.expectedError)}</code>. This captures a failure response; successful physical execution is covered by the action's dedicated scenarios.</p>` : ""}
    </section>
    <div class="protocol">
      <details class="raw-response" open><summary>Raw MCP response</summary><pre>${highlightJson(call?.response ?? null)}</pre></details>
      <details><summary>Published input schema</summary><pre>${highlightJson(tool.inputSchema)}</pre></details>
      <details><summary>Published output schema</summary><pre>${highlightJson(tool.outputSchema ?? null)}</pre></details>
    </div>
  </article>`;
}

function badges(tool: Tool, call: ActionEvidence["calls"][number] | undefined): string {
  const values = [
    call?.response.isError ? ["failed", "bad"] : ["succeeded", "good"],
    tool.annotations?.readOnlyHint ? ["information", "info"] : ["task", "task"],
    tool.annotations?.destructiveHint ? ["destructive", "bad"] : ["non-destructive", "neutral"],
  ];
  return values.map(([label, className]) => `<span class="badge ${className}">${label}</span>`).join("");
}

function argumentTable(tool: Tool): string {
  const schema = object(tool.inputSchema);
  const properties = object(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(isString) : []);
  const rows = Object.entries(properties).map(([name, rawSchema]) => {
    const field = object(rawSchema);
    const presence = required.has(name) ? "required" : "optional";
    const defaultValue = Object.hasOwn(field, "default")
      ? `<code class="default-value">${highlightJson(field.default)}</code>`
      : '<span class="no-default">—</span>';
    return `<tr><td><code>${escapeHtml(name)}</code></td><td><span class="presence ${presence}">${presence}</span></td><td><span class="type">${escapeHtml(typeLabel(field))}</span></td><td>${defaultValue}</td><td>${escapeHtml(typeof field.description === "string" ? field.description : "")}</td></tr>`;
  });
  if (rows.length === 0) return '<p class="empty">No arguments.</p>';
  return `<table><thead><tr><th>Name</th><th>Presence</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function typeLabel(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join(" | ");
  if (typeof schema.const === "string") return JSON.stringify(schema.const);
  if (typeof schema.type === "string") return schema.type;
  for (const branchName of ["anyOf", "oneOf"] as const) {
    const branches = schema[branchName];
    if (Array.isArray(branches)) return branches.map((branch) => typeLabel(object(branch))).join(" | ");
  }
  return "value";
}

function highlightCode(source: string, info: string): string {
  const requestedLanguage = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const language = requestedLanguage && hljs.getLanguage(requestedLanguage) ? requestedLanguage : "plaintext";
  const highlighted =
    language === "plaintext" ? escapeHtml(source) : hljs.highlight(source, { language, ignoreIllegals: true }).value;
  const label = requestedLanguage || "text";
  return `<pre class="highlighted-code"><span class="code-language">${escapeHtml(label.toUpperCase())}</span><code class="hljs language-${attribute(language)}">${highlighted}</code></pre>`;
}

function textContent(content: ActionEvidence["calls"][number]["response"]["content"]): string {
  return content
    .filter((entry): entry is Extract<(typeof content)[number], { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n\n");
}

function renderModelResponse(source: string): string {
  if (!source) return '<p class="empty">No model-visible text response captured.</p>';

  const response = parseResponseEnvelope(source);
  if (!response) return `<div class="response-envelope"><div class="markdown">${markdown.render(source)}</div></div>`;

  const status = response.status.toLowerCase();
  const statusClass = ["succeeded", "partial", "failed"].includes(status) ? status : "unknown";
  const duration = formatDuration(response.durationMs);
  return `<div class="response-envelope">
    <div class="response-meta">
      <span class="response-status ${statusClass}">${escapeHtml(response.status)}</span>
      <span class="response-duration"><strong>${escapeHtml(duration.label)}</strong>${duration.exact ? `<small>${escapeHtml(duration.exact)}</small>` : ""}</span>
    </div>
    <div class="markdown">${markdown.render(response.body)}</div>
  </div>`;
}

function parseResponseEnvelope(source: string): { status: string; durationMs: number; body: string } | null {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const statusIndex = lines.findIndex((line) => /^\*\*Status:\*\*/.test(line));
  const durationIndex = lines.findIndex((line) => /^\*\*Duration:\*\*/.test(line));
  const statusMatch = statusIndex >= 0 ? /^\*\*Status:\*\*\s*(\S+)/.exec(lines[statusIndex] ?? "") : null;
  const durationMatch = durationIndex >= 0 ? /^\*\*Duration:\*\*\s*(\d+)\s*ms/.exec(lines[durationIndex] ?? "") : null;
  if (!statusMatch?.[1] || !durationMatch?.[1]) return null;

  let bodyStart = Math.max(statusIndex, durationIndex) + 1;
  while (lines[bodyStart]?.trim() === "") bodyStart += 1;
  return {
    status: statusMatch[1],
    durationMs: Number(durationMatch[1]),
    body: lines.slice(bodyStart).join("\n"),
  };
}

function formatDuration(milliseconds: number): { label: string; exact: string | null } {
  if (milliseconds === 0) return { label: "Under 1 ms", exact: "0 ms" };
  if (milliseconds < 1_000) return { label: `${milliseconds} ms`, exact: null };

  const exact = `${milliseconds.toLocaleString("en-US")} ms`;
  if (milliseconds < 60_000) {
    const seconds = (milliseconds / 1_000).toFixed(1).replace(/\.0$/, "");
    return { label: `${seconds} ${seconds === "1" ? "second" : "seconds"}`, exact };
  }

  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return { label: `${minutes} min ${seconds} sec`, exact };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function highlightJson(value: unknown): string {
  const source = json(value);
  const tokenPattern =
    /"(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let cursor = 0;
  let highlighted = "";

  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index;
    highlighted += escapeHtml(source.slice(cursor, index));
    highlighted += `<span class="json-${jsonTokenKind(source, token, index)}">${escapeHtml(token)}</span>`;
    cursor = index + token.length;
  }

  return highlighted + escapeHtml(source.slice(cursor));
}

function jsonTokenKind(source: string, token: string, index: number): string {
  if (token.startsWith('"')) {
    return source
      .slice(index + token.length)
      .trimStart()
      .startsWith(":")
      ? "key"
      : "string";
  }
  if (token === "true" || token === "false") return "boolean";
  if (token === "null") return "null";
  return "number";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function attribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  renderActionEvidencePage()
    .then((outputPath) => console.log(outputPath))
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    });
}
