// The side panel: the pinned path's details, and statistics over the
// whole closure. Both render from a context object app.js assembles, and
// build DOM nodes directly so no store name or imported string is ever
// parsed as HTML.

import { COARSE_CHUNK, SUMMARY_RECORD } from "./config.js";
import { count, humanBytes, percent } from "./format.js";
import { whyChain } from "./graph.js";
import { EntryType } from "./narindex.js";
import { Field } from "./summary.js";
import { Verified } from "./substituters.js";
import { PathState } from "./tileformat.js";

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === "class") {
      node.className = value;
    } else if (key.startsWith("on")) {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value === true ? "" : value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// Segment colours for the statistics bars, in order of share.
const SERIES = [
  "#4f6bed",
  "#3fa34d",
  "#e0a030",
  "#c94f4f",
  "#8e5bd0",
  "#2aa9b8",
  "#9a9a9a",
];

// The byte classes in the colours the map draws them with.
const CLASS_SERIES = [
  { label: "zero bytes", color: "#08080a" },
  { label: "printable ASCII", color: "#4080f2" },
  { label: "high bytes", color: "#eb5933" },
  { label: "control bytes", color: "#33ad59" },
];

const LOCAL_ONLY = "not in any configured cache";
const TOP_PATHS = 8;
const TOP_FILES = 6;
const LIST_LIMIT = 40;

// A link-styled button that selects a path and flies to it.
function pathLink(ctx, id, label = ctx.model.paths[id].name) {
  return el(
    "button",
    {
      class: "path-link",
      type: "button",
      title: ctx.model.paths[id].storePath,
      onclick: () => ctx.select(id, true),
    },
    label,
  );
}

function facts(rows) {
  return el(
    "dl",
    { class: "facts" },
    rows
      .filter(Boolean)
      .flatMap(([term, value]) => [el("dt", {}, term), el("dd", {}, value)]),
  );
}

export function loadStateText(ctx, id) {
  const path = ctx.model.paths[id];
  const bits = ctx.bits[id];
  if (bits & PathState.LOCAL) {
    return LOCAL_ONLY;
  }
  if (bits & PathState.FAILED) {
    return `failed: ${ctx.errors.get(path.narHash) ?? "unknown error"}`;
  }
  if (bits & PathState.LOADING) {
    const job = ctx.jobs.get(path.narHash);
    if (job?.worker && job.narSize > 0) {
      return `downloading ${percent(job.nar, job.narSize)}`;
    }
    return "queued";
  }
  if (bits & PathState.RAW) {
    return "on disk";
  }
  if (bits & PathState.SUMMARY) {
    return "summarised (raw bytes evicted)";
  }
  return "not fetched";
}

function signatureText(ctx, id) {
  const result = ctx.verified[id];
  if (result === undefined) {
    return "checking…";
  }
  if (result.verdict === Verified.SIGNED) {
    return `signed by ${result.keyName}`;
  }
  if (result.verdict === Verified.UNCHECKABLE) {
    return "not checkable in this browser";
  }
  return "unsigned by any configured key";
}

function ratio(path) {
  if (!path.fileSize || !path.narSize) {
    return null;
  }
  return `${(path.narSize / path.fileSize).toFixed(1)}x`;
}

function copyButton(ctx, text) {
  return el(
    "button",
    { class: "copy", type: "button", onclick: () => ctx.copy(text) },
    "copy",
  );
}

export function renderInspect(container, ctx) {
  container.replaceChildren();
  if (ctx.model === null) {
    container.append(
      el("p", { class: "muted" }, "Load a closure to inspect its paths."),
    );
    return;
  }
  if (ctx.selected < 0) {
    container.append(
      el(
        "p",
        { class: "muted" },
        "Hover over the map to see a path; click or tap to pin it here.",
      ),
      el("h3", {}, ctx.model.roots.length === 1 ? "Root" : "Roots"),
      el(
        "ul",
        { class: "plain" },
        ctx.model.roots.map((id) => el("li", {}, pathLink(ctx, id))),
      ),
    );
    return;
  }

  const id = ctx.selected;
  const path = ctx.model.paths[id];
  const analysis = ctx.analysis;

  // Name, store path and what the multiverse knows it as.
  const named = el("p", { class: "muted identify" }, "");
  ctx.identify(path.digest).then((hit) => {
    if (hit === null) {
      return;
    }
    named.replaceChildren(
      "nixpkgs ",
      el(
        "a",
        { href: ctx.multiverseUrl(hit), class: "out" },
        `${hit.attr} ${hit.version}`,
      ),
    );
  });
  container.append(
    el("h2", { class: "path-name" }, path.name),
    el(
      "p",
      { class: "store-path" },
      el("code", {}, path.storePath),
      " ",
      copyButton(ctx, path.storePath),
    ),
    named,
  );

  // Sizes.
  container.append(
    facts([
      ["NAR size", humanBytes(path.narSize)],
      path.fileSize > 0 && [
        "Download",
        `${humanBytes(path.fileSize)} ${path.compression}${ratio(path) ? `, ${ratio(path)}` : ""}`,
      ],
      ["Closure", analysis ? humanBytes(analysis.closure[id]) : "…"],
      ["Retained", analysis ? humanBytes(analysis.retained[id]) : "…"],
      ["Referrers", analysis ? count(analysis.referrers[id].length) : "…"],
      ["Signature", signatureText(ctx, id)],
      ["Bytes", loadStateText(ctx, id)],
    ]),
  );

  // Load actions.
  const bits = ctx.bits[id];
  const actions = el("p", { class: "actions" });
  if (ctx.fetchable(path) && !(bits & (PathState.RAW | PathState.LOADING))) {
    actions.append(
      el(
        "button",
        { type: "button", onclick: () => ctx.fetchPath(id) },
        "Fetch this path",
      ),
    );
  }
  if (bits & PathState.RAW) {
    actions.append(
      el(
        "button",
        { type: "button", onclick: () => ctx.evictPath(id) },
        "Evict raw bytes",
      ),
    );
  }
  actions.append(
    el(
      "button",
      { type: "button", onclick: () => ctx.select(id, true) },
      "Fly to",
    ),
  );
  container.append(actions);

  // Why it is here.
  if (analysis !== null && analysis.why[id] >= -1) {
    const chain = whyChain(analysis.why, id);
    container.append(
      el("h3", {}, "Why is this here"),
      el(
        "ol",
        { class: "crumbs" },
        chain.map((step) =>
          el(
            "li",
            {},
            step === id ? el("span", {}, path.name) : pathLink(ctx, step),
          ),
        ),
      ),
    );
    const root = ctx.model.paths[chain[0]];
    if (chain.length > 1) {
      const command = `nix why-depends --precise ${root.storePath} ${path.storePath}`;
      container.append(
        el("pre", { class: "command" }, command),
        copyButton(ctx, command),
      );
    }
  }

  // Hashes and provenance.
  container.append(
    el("h3", {}, "Narinfo"),
    facts([
      ["NarHash", el("code", {}, path.narHash ?? "unknown")],
      path.deriver && ["Deriver", el("code", {}, path.deriver)],
      path.ca && ["CA", el("code", {}, path.ca)],
      ["Cache", path.substituter ?? LOCAL_LABEL_TEXT],
    ]),
  );

  // Files, when the NAR has been indexed.
  const index = ctx.indexes.get(path.narHash);
  if (index !== undefined) {
    const regular = index.entries.filter((e) => e.type === EntryType.REGULAR);
    const largest = [...regular]
      .sort((a, b) => b.size - a.size)
      .slice(0, TOP_FILES);
    container.append(
      el(
        "h3",
        {},
        `Files (${count(regular.length)}${index.truncated ? "+" : ""})`,
      ),
      el(
        "ul",
        { class: "plain files" },
        largest.map((e) =>
          el(
            "li",
            {},
            el("code", {}, e.path || "(root)"),
            ` ${humanBytes(e.size)}`,
          ),
        ),
      ),
    );
  }

  // References and referrers.
  const list = (title, ids) =>
    el(
      "details",
      { class: "refs" },
      el("summary", {}, `${title} (${count(ids.length)})`),
      el(
        "ul",
        { class: "plain" },
        ids.slice(0, LIST_LIMIT).map((ref) => el("li", {}, pathLink(ctx, ref))),
        ids.length > LIST_LIMIT
          ? el(
              "li",
              { class: "muted" },
              `and ${count(ids.length - LIST_LIMIT)} more`,
            )
          : null,
      ),
    );
  container.append(list("References", path.references));
  if (analysis !== null) {
    container.append(list("Referrers", analysis.referrers[id]));
  }
}

const LOCAL_LABEL_TEXT = "none (local-only)";

// A stacked bar and its legend.
function bar(segments, format) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return el(
    "div",
    { class: "stat-bar" },
    el(
      "div",
      { class: "bar" },
      segments
        .filter((s) => s.value > 0)
        .map((s) =>
          el("span", {
            style: `flex-grow: ${s.value}; background: ${s.color}`,
            title: `${s.label}: ${percent(s.value, total)}`,
          }),
        ),
    ),
    el(
      "ul",
      { class: "legend" },
      segments.map((s) =>
        el(
          "li",
          {},
          el("i", { style: `background: ${s.color}` }),
          el("span", { class: "label" }, s.label),
          el(
            "span",
            { class: "value" },
            `${percent(s.value, total)}${format ? ` · ${format(s)}` : ""}`,
          ),
        ),
      ),
    ),
  );
}

function groupBy(paths, keyOf) {
  const groups = new Map();
  for (const path of paths) {
    const key = keyOf(path);
    const group = groups.get(key) ?? {
      label: key,
      paths: 0,
      narSize: 0,
      fileSize: 0,
    };
    group.paths += 1;
    group.narSize += path.narSize;
    group.fileSize += path.fileSize;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.narSize - a.narSize)
    .map((group, i) => ({
      ...group,
      value: group.narSize,
      color: SERIES[Math.min(i, SERIES.length - 1)],
    }));
}

export function renderStats(container, ctx) {
  container.replaceChildren();
  if (ctx.model === null) {
    container.append(
      el("p", { class: "muted" }, "Load a closure to see its statistics."),
    );
    return;
  }
  const { paths } = ctx.model;
  const narTotal = ctx.model.total;
  const fileTotal = paths.reduce((sum, p) => sum + p.fileSize, 0);

  container.append(
    el("h3", {}, "Closure"),
    facts([
      ["Paths", count(paths.length)],
      ["Unpacked", humanBytes(narTotal)],
      fileTotal > 0 && [
        "Download",
        `${humanBytes(fileTotal)} (${(narTotal / fileTotal).toFixed(1)}x)`,
      ],
      ["World", `2^${ctx.model.order} × 2^${ctx.model.order} pixels`],
    ]),
  );

  // Where the bytes come from.
  const bySubstituter = groupBy(paths, (p) => p.substituter ?? LOCAL_ONLY);
  container.append(
    el("h3", {}, "Substituters"),
    bar(bySubstituter, (g) => `${count(g.paths)} paths`),
  );

  const byCompression = groupBy(paths, (p) =>
    p.substituter === null ? "local-only" : p.compression,
  );
  container.append(
    el("h3", {}, "Compression"),
    bar(byCompression, (g) =>
      g.fileSize > 0
        ? `${humanBytes(g.fileSize)} download`
        : `${count(g.paths)} paths`,
    ),
  );

  // Signatures.
  const verdicts = { signed: 0, unsigned: 0, uncheckable: 0, pending: 0 };
  for (let id = 0; id < paths.length; id += 1) {
    const result = ctx.verified[id];
    if (result === undefined) {
      verdicts.pending += 1;
    } else if (result.verdict === Verified.SIGNED) {
      verdicts.signed += 1;
    } else if (result.verdict === Verified.UNCHECKABLE) {
      verdicts.uncheckable += 1;
    } else {
      verdicts.unsigned += 1;
    }
  }
  container.append(
    el("h3", {}, "Signatures"),
    facts([
      ["Signed", count(verdicts.signed)],
      verdicts.unsigned > 0 && ["Unsigned", count(verdicts.unsigned)],
      verdicts.uncheckable > 0 && ["Uncheckable", count(verdicts.uncheckable)],
      verdicts.pending > 0 && ["Checking", count(verdicts.pending)],
    ]),
  );

  // The biggest paths, by their own size and by what they keep alive.
  const ranked = (valueOf) =>
    el(
      "ol",
      { class: "ranked" },
      paths
        .map((p) => [p.id, valueOf(p.id)])
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_PATHS)
        .map(([id, value]) =>
          el(
            "li",
            {},
            pathLink(ctx, id),
            el("span", { class: "value" }, humanBytes(value)),
          ),
        ),
    );
  container.append(
    el("h3", {}, "Largest paths"),
    ranked((id) => paths[id].narSize),
  );
  if (ctx.analysis !== null) {
    container.append(
      el("h3", {}, "Largest retained size"),
      ranked((id) => ctx.analysis.retained[id]),
    );
  }

  // What the fetched bytes are made of.
  const mix = [0, 0, 0, 0];
  let entropy = 0;
  let summarised = 0;
  let summarisedPaths = 0;
  for (const [hash, records] of ctx.coarse) {
    const ids = ctx.byHash.get(hash) ?? [];
    if (ids.length === 0) {
      continue;
    }
    summarisedPaths += ids.length;
    const narSize = paths[ids[0]].narSize;
    const chunks = records.length / SUMMARY_RECORD;
    for (let i = 0; i < chunks; i += 1) {
      const at = i * SUMMARY_RECORD;
      const weight =
        i === chunks - 1 ? narSize - i * COARSE_CHUNK : COARSE_CHUNK;
      const zero = records[at + Field.ZERO];
      const ascii = records[at + Field.ASCII];
      const high = records[at + Field.HIGH];
      mix[0] += zero * weight;
      mix[1] += ascii * weight;
      mix[2] += high * weight;
      mix[3] += Math.max(0, 255 - zero - ascii - high) * weight;
      entropy += records[at + Field.ENTROPY] * weight;
      summarised += weight;
    }
  }
  container.append(el("h3", {}, "Bytes fetched"));
  if (summarised === 0) {
    container.append(
      el(
        "p",
        { class: "muted" },
        "Nothing fetched yet. Zoom in, or fetch paths from the toolbar.",
      ),
    );
  } else {
    container.append(
      facts([
        [
          "Summarised",
          `${humanBytes(summarised)} of ${humanBytes(narTotal)} (${percent(summarised, narTotal)})`,
        ],
        ["Paths", `${count(summarisedPaths)} of ${count(paths.length)}`],
        [
          "Mean entropy",
          `${((entropy / summarised / 255) * 8).toFixed(2)} bits/byte`,
        ],
      ]),
      bar(CLASS_SERIES.map((s, i) => ({ ...s, value: mix[i] }))),
    );
  }

  // Files across the indexed NARs.
  const kinds = { regular: 0, executable: 0, symlink: 0, directory: 0 };
  const biggest = [];
  let indexed = 0;
  for (const [hash, index] of ctx.indexes) {
    const ids = ctx.byHash.get(hash);
    if (ids === undefined) {
      continue;
    }
    indexed += 1;
    for (const entry of index.entries) {
      if (entry.type === EntryType.REGULAR) {
        kinds.regular += 1;
        kinds.executable += entry.executable ? 1 : 0;
        biggest.push({ id: ids[0], entry });
      } else if (entry.type === EntryType.SYMLINK) {
        kinds.symlink += 1;
      } else {
        kinds.directory += 1;
      }
    }
  }
  if (indexed > 0) {
    biggest.sort((a, b) => b.entry.size - a.entry.size);
    container.append(
      el("h3", {}, `Files in ${count(indexed)} indexed NARs`),
      facts([
        ["Regular", count(kinds.regular)],
        ["Executable", count(kinds.executable)],
        ["Symlinks", count(kinds.symlink)],
        ["Directories", count(kinds.directory)],
      ]),
      el(
        "ol",
        { class: "ranked" },
        biggest
          .slice(0, TOP_FILES)
          .map(({ id, entry }) =>
            el(
              "li",
              {},
              pathLink(ctx, id, `${paths[id].name}/${entry.path}`),
              el("span", { class: "value" }, humanBytes(entry.size)),
            ),
          ),
      ),
    );
  }

  // Declared references against the ones found in the bytes.
  let declared = 0;
  let found = 0;
  let scanned = 0;
  for (const [hash, hits] of ctx.refs) {
    const ids = ctx.byHash.get(hash);
    if (ids === undefined) {
      continue;
    }
    scanned += 1;
    const path = paths[ids[0]];
    declared += path.references.length + (path.selfRef ? 1 : 0);
    found += new Set(hits.map((hit) => hit.target)).size;
  }
  if (scanned > 0) {
    container.append(
      el("h3", {}, "References"),
      facts([
        [
          "Declared",
          `${count(declared)} across ${count(scanned)} scanned paths`,
        ],
        ["Found in bytes", count(found)],
      ]),
    );
  }

  // This session.
  container.append(
    el("h3", {}, "This session"),
    facts([
      ["Downloaded", humanBytes(ctx.fetcher.sessionBytes)],
      [
        "Raw on disk",
        `${humanBytes(ctx.fetcher.storedTotal)} of ${humanBytes(ctx.fetcher.budget)}`,
      ],
      [
        "Storage",
        ctx.opfs
          ? "origin private file system"
          : "memory (no OPFS in this browser)",
      ],
    ]),
  );
}
