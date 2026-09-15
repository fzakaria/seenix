// The page: reading the link, loading a closure, wiring the map to the
// workers, and keeping the panels and the address bar in step.

import { packageColor, parseHexColor } from "./colors.js";
import {
  AUTO_FETCH_BYTES,
  AUTO_FETCH_LOD,
  FEATURED,
  LOD_COARSE,
  MEMORY_BUDGET_BYTES,
  RAW_BUDGET_BYTES,
} from "./config.js";
import { isElf, readElfSections, sectionAt } from "./elf.js";
import { FetchEvent, Fetcher } from "./fetcher.js";
import { count, humanBytes, percent } from "./format.js";
import { d2xy, xy2d } from "./hilbert.js";
import { buildLayout, pathAt } from "./layout.js";
import { MapView } from "./map.js";
import { identify, multiverseUrl, resolvePackage } from "./multiverse.js";
import { buildFileLookup, ordinalAt } from "./narindex.js";
import { mapConcurrent } from "./net.js";
import { el, loadStateText, renderInspect, renderStats } from "./panel.js";
import { refAt } from "./refscan.js";
import { closureFromJson, closureFromPaths } from "./source.js";
import {
  Store,
  fileNameOf,
  getMany,
  opfsDirs,
  put,
  readSlice,
  remove,
  removeNarFiles,
} from "./storage.js";
import {
  DEFAULT_SUBSTITUTERS,
  Verified,
  parseSubstituters,
  verify,
} from "./substituters.js";
import {
  NO_PATH,
  PATH_TABLE_WIDTH,
  PathState,
  RawStore,
} from "./tileformat.js";
import {
  lodFor,
  tileByteRange,
  tileWorldSize,
  visibleTiles,
} from "./tilemath.js";
import { MODES, Mode, readUrl, writeUrl } from "./url.js";

const $ = (id) => document.getElementById(id);

const Tab = Object.freeze({ INSPECT: "inspect", STATS: "stats" });
const DEFAULT_MODE = Mode.BYTES;
const URL_WRITE_MS = 400;
const PANEL_REFRESH_MS = 350;
const FETCH_UPDATE_MS = 150;
const FETCH_TICK_MS = 1000;
const CONFIRM_MS = 5000;
const SEARCH_LIMIT = 8;
const VERIFY_CONCURRENCY = 32;
const FLY_FILL = 0.35;
const FLY_MIN_SIDE = 64;
const SUPPORTED_COMPRESSION = new Set(["xz", "zstd", "bzip2", "none"]);

const opfs = (await opfsDirs()) !== null;

const tileWorker = new Worker(
  new URL("./workers/tile-worker.js", import.meta.url),
  {
    type: "module",
  },
);
const graphWorker = new Worker(
  new URL("./workers/graph-worker.js", import.meta.url),
  {
    type: "module",
  },
);

const state = {
  generation: 0,
  loadToken: 0,
  source: { paths: [], pkgs: [], json: null },
  jsonText: null,
  caches: [],
  mode: DEFAULT_MODE,
  pendingSel: null,
  model: null,
  bits: new Uint8Array(0),
  byHash: new Map(),
  errors: new Map(),
  coarse: new Map(),
  indexes: new Map(),
  lookups: new Map(),
  refs: new Map(),
  verified: [],
  analysis: null,
  selected: -1,
  pathTable: null,
  tableRows: 1,
  tab: Tab.INSPECT,
  pending: { bytes: 0, jobs: [] },
  allArmed: false,
  restored: -1,
};

const fetcher = new Fetcher({
  budget: opfs ? RAW_BUDGET_BYTES : MEMORY_BUDGET_BYTES,
  memory: !opfs,
  onEvent: onFetchEvent,
});

// ---------- status and small helpers ----------

function setStatus(text, { error = false } = {}) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", error);
}

const substituters = () => [...DEFAULT_SUBSTITUTERS, ...state.caches];

const fetchable = (path) =>
  path.substituter !== null &&
  path.url !== null &&
  path.narHash !== null &&
  path.narSize > 0 &&
  SUPPORTED_COMPRESSION.has(path.compression);

function throttle(fn, ms) {
  let timer = null;
  return () => {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied.");
  } catch {
    setStatus("The clipboard is not available here.", { error: true });
  }
}

// ---------- the map ----------

let map = null;
try {
  map = new MapView(
    {
      shell: $("map-shell"),
      canvas: $("map"),
      overlay: $("overlay"),
      minimap: $("minimap"),
    },
    tileWorker,
    {
      onHover,
      onSelect,
      onView: () => {
        scheduleUrl();
        scheduleFetching();
      },
      onFlyToSelected: () => {
        if (state.selected >= 0) {
          flyToPath(state.selected);
        }
      },
      onEscape: () => select(-1),
    },
  );
} catch (err) {
  $("empty").replaceChildren(
    el(
      "p",
      {},
      `The map needs WebGL2, which this browser did not provide: ${err.message}`,
    ),
  );
}

function applyTheme() {
  const color = getComputedStyle(document.documentElement).getPropertyValue(
    "--map-bg",
  );
  map?.setBackground(parseHexColor(color));
}
matchMedia("(prefers-color-scheme: dark)").addEventListener(
  "change",
  applyTheme,
);
applyTheme();

// ---------- the address bar ----------

function urlState() {
  const path = state.selected >= 0 ? state.model?.paths[state.selected] : null;
  return {
    ...state.source,
    caches: state.caches,
    mode: state.mode === DEFAULT_MODE ? null : state.mode,
    sel: path?.digest ?? null,
    view: state.model && map ? map.view() : null,
  };
}

const scheduleUrl = throttle(() => {
  history.replaceState(null, "", writeUrl(urlState()));
}, URL_WRITE_MS);

function applyUrl(url) {
  state.source = { paths: url.paths, pkgs: url.pkgs, json: url.json };
  state.jsonText = null;
  state.caches = url.caches;
  state.mode = url.mode ?? DEFAULT_MODE;
  state.pendingSel = url.sel;
  state.pendingView = url.view;
  $("caches-input").value = url.caches
    .map((c) => `${c.url} ${c.key}`)
    .join("\n");
  $("store-path").value = url.paths.join(" ");
  $("pkg-input").value = url.pkgs
    .map((p) => (p.version ? `${p.attr}@${p.version}` : p.attr))
    .join(" ");
  $("json-url").value = url.json ?? "";
  renderModes();
  map?.setMode(state.mode);
}

function navigate(source, jsonText = null, caches = state.caches) {
  state.caches = caches;
  $("caches-input").value = caches.map((c) => `${c.url} ${c.key}`).join("\n");
  state.source = source;
  state.jsonText = jsonText;
  state.pendingSel = null;
  state.pendingView = null;
  history.pushState(
    null,
    "",
    writeUrl({ ...source, caches: state.caches, mode: urlState().mode }),
  );
  load();
}

addEventListener("popstate", () => {
  applyUrl(readUrl());
  load();
});

// ---------- loading a closure ----------

async function load() {
  const token = ++state.loadToken;
  const { paths, pkgs, json } = state.source;
  const hasSource =
    paths.length > 0 ||
    pkgs.length > 0 ||
    json !== null ||
    state.jsonText !== null;
  $("empty").hidden = hasSource;
  if (!hasSource) {
    setStatus("");
    return;
  }

  try {
    let result;
    if (state.jsonText !== null || json !== null) {
      setStatus("Reading nix path-info output…");
      const text = state.jsonText ?? (await (await fetch(json)).text());
      result = await closureFromJson(text, substituters(), (done, total) => {
        if (token === state.loadToken) {
          setStatus(
            `Looking up ${count(done)} of ${count(total)} paths in the caches…`,
          );
        }
      });
    } else {
      setStatus("Resolving…");
      const resolved = await Promise.all(
        pkgs.map((p) => resolvePackage(p.attr, p.version)),
      );
      result = await closureFromPaths(
        [...paths, ...resolved],
        substituters(),
        (n) => {
          if (token === state.loadToken) {
            setStatus(`Walking the closure: ${count(n)} paths`);
          }
        },
      );
    }
    if (token !== state.loadToken) {
      return;
    }
    if (result.records.length === 0) {
      throw new Error(result.problems[0] ?? "the closure is empty");
    }

    const started = performance.now();
    const model = buildLayout(result.records, result.roots);
    const elapsed = Math.round(performance.now() - started);
    install(model);

    const local = model.paths.filter((p) => p.substituter === null).length;
    const notes = [
      `${count(model.paths.length)} paths, ${humanBytes(model.total)}, laid out in ${elapsed} ms`,
      local > 0 ? `${count(local)} local-only` : null,
      result.problems.length > 0
        ? `${count(result.problems.length)} problems: ${result.problems[0]}`
        : null,
      state.jsonText !== null ? "a dropped file is not part of the link" : null,
    ];
    setStatus(notes.filter(Boolean).join(" · "), {
      error: result.problems.length > 0,
    });
  } catch (err) {
    if (token === state.loadToken) {
      setStatus(err.message, { error: true });
    }
  }
}

function install(model) {
  state.generation += 1;
  const generation = state.generation;
  const n = model.paths.length;

  state.model = model;
  state.bits = new Uint8Array(n);
  state.byHash = new Map();
  state.errors.clear();
  state.coarse.clear();
  state.indexes.clear();
  state.lookups.clear();
  state.refs.clear();
  state.verified = new Array(n);
  state.analysis = null;
  elfCache.clear();

  for (const path of model.paths) {
    if (path.substituter === null) {
      state.bits[path.id] |= PathState.LOCAL;
    }
    if (path.narHash !== null) {
      const ids = state.byHash.get(path.narHash) ?? [];
      ids.push(path.id);
      state.byHash.set(path.narHash, ids);
    }
  }

  // The path table: package colours and state bits.
  state.tableRows = Math.max(1, Math.ceil(n / PATH_TABLE_WIDTH));
  state.pathTable = new Uint8Array(PATH_TABLE_WIDTH * state.tableRows * 4);
  for (const path of model.paths) {
    state.pathTable.set(
      [...packageColor(path.name, path.digest), state.bits[path.id]],
      path.id * 4,
    );
  }

  tileWorker.postMessage({
    type: "layout",
    generation,
    order: model.order,
    total: model.total,
    offsets: model.offsets,
    names: model.paths.map((p) => (p.narHash ? fileNameOf(p.narHash) : null)),
  });
  fetcher.reset(model.paths.map((p) => [p.digest, p.id]));

  const selected =
    state.pendingSel === null
      ? -1
      : (model.byDigest.get(state.pendingSel) ?? -1);
  if (map !== null) {
    map.setModel(model, generation, state.pendingView ?? null);
    map.setPathTable(state.pathTable, state.tableRows);
    map.setMode(state.mode);
  }
  state.pendingView = null;
  select(selected);

  graphWorker.postMessage({
    generation,
    references: model.paths.map((p) => p.references),
    roots: model.roots,
    sizes: Float64Array.from(model.paths, (p) => p.narSize),
  });
  verifyAll(generation);
  restoreCached(generation);
  renderSearch();
  refreshPanels();
}

graphWorker.onmessage = ({ data }) => {
  if (data.generation !== state.generation) {
    return;
  }
  state.analysis = data;
  refreshPanels();
};

async function verifyAll(generation) {
  const subs = substituters();
  await mapConcurrent(state.model.paths, VERIFY_CONCURRENCY, async (path) => {
    if (generation !== state.generation) {
      return;
    }
    const result =
      path.narHash === null
        ? { verdict: Verified.UNSIGNED, keyName: null }
        : await verify(
            {
              storePath: path.storePath,
              narHash: path.narHash,
              narSize: path.narSize,
              references: path.referenceNames ?? [],
              sigs: path.sigs,
            },
            subs,
          );
    if (generation === state.generation) {
      state.verified[path.id] = result;
      refreshPanels();
    }
  });
}

// Summaries, indexes and references from earlier visits, and the NARs
// still on disk.
async function restoreCached(generation) {
  const hashes = [...state.byHash.keys()];
  const [summaries, indexes, refs, raws] = await Promise.all(
    [Store.SUMMARIES, Store.INDEXES, Store.REFS, Store.RAW].map((store) =>
      getMany(store, hashes),
    ),
  );
  if (generation !== state.generation) {
    return;
  }

  for (const hash of hashes) {
    const ids = state.byHash.get(hash);
    if (summaries.has(hash)) {
      applyCoarse(hash, summaries.get(hash));
    }
    if (indexes.has(hash)) {
      applyIndex(hash, indexes.get(hash));
    }
    if (refs.has(hash)) {
      const stored = refs.get(hash);
      state.refs.set(
        hash,
        stored.hits
          .map((hit) => ({
            offset: hit.offset,
            target: state.model.byDigest.get(hit.digest),
          }))
          .filter((hit) => hit.target !== undefined),
      );
    }
    if (opfs && raws.has(hash) && summaries.has(hash)) {
      const record = raws.get(hash);
      setBits(ids, PathState.RAW, 0);
      tileWorker.postMessage({ type: "raw", generation, ids, available: true });
      fetcher.remember(hash, record.bytes, record.lastUsed);
    }
  }

  state.restored = generation;
  map?.invalidate(0, state.model.total);
  refreshPanels();
  scheduleFetching();
}

function setBits(ids, set, clear) {
  for (const id of ids) {
    const bits = (state.bits[id] & ~clear) | set;
    state.bits[id] = bits;
    state.pathTable[id * 4 + 3] = bits;
  }
  map?.setPathTable(state.pathTable, state.tableRows);
}

function invalidatePaths(ids) {
  for (const id of ids) {
    const path = state.model.paths[id];
    map?.invalidate(path.start, path.start + path.narSize);
  }
}

function applyCoarse(hash, records) {
  const ids = state.byHash.get(hash);
  state.coarse.set(hash, records);
  setBits(ids, PathState.SUMMARY, 0);
  tileWorker.postMessage({
    type: "coarse",
    generation: state.generation,
    ids,
    records,
  });
}

function applyIndex(hash, index) {
  const ids = state.byHash.get(hash);
  const lookup = buildFileLookup(index.entries);
  state.indexes.set(hash, index);
  state.lookups.set(hash, lookup);
  const ends = Float64Array.from(
    lookup.ids,
    (i) => index.entries[i].contentOffset + index.entries[i].size,
  );
  tileWorker.postMessage({
    type: "files",
    generation: state.generation,
    ids,
    starts: lookup.starts,
    ends,
  });
}

// ---------- fetching ----------

function jobFor(path, priority) {
  return {
    narHash: path.narHash,
    url: `${path.substituter}/${path.url}`,
    compression: path.compression,
    narSize: path.narSize,
    fileSize: path.fileSize,
    priority,
  };
}

function onFetchEvent(type, job, data) {
  if (state.model === null) {
    return;
  }
  const ids = state.byHash.get(job.narHash) ?? [];

  if (type === FetchEvent.QUEUED || type === FetchEvent.STARTED) {
    setBits(ids, PathState.LOADING, PathState.FAILED);
  } else if (type === FetchEvent.DROPPED) {
    setBits(ids, 0, PathState.LOADING);
  } else if (type === FetchEvent.FAILED) {
    state.errors.set(job.narHash, data.message);
    setBits(ids, PathState.FAILED, PathState.LOADING);
  } else if (type === FetchEvent.DONE) {
    finishFetch(job.narHash, ids, data);
  } else if (type === FetchEvent.EVICT) {
    setBits(ids, 0, PathState.RAW);
    tileWorker.postMessage({
      type: "raw",
      generation: state.generation,
      ids,
      available: false,
    });
    tileWorker.postMessage({
      type: "forget",
      generation: state.generation,
      name: fileNameOf(job.narHash),
    });
    removeNarFiles(job.narHash);
    remove(Store.RAW, job.narHash);
    invalidatePaths(ids);
  }
  refreshPanels();
  renderSession();
}

function finishFetch(hash, ids, data) {
  state.errors.delete(hash);
  applyCoarse(hash, data.coarse);
  applyIndex(hash, data.index);
  state.refs.set(hash, data.refs.hits);

  if (data.rawStored === RawStore.MEMORY) {
    tileWorker.postMessage(
      {
        type: "memory",
        generation: state.generation,
        name: fileNameOf(hash),
        raw: data.raw,
        fine: data.fine,
      },
      [data.raw.buffer, data.fine.buffer],
    );
  }
  if (data.rawStored !== null) {
    tileWorker.postMessage({
      type: "raw",
      generation: state.generation,
      ids,
      available: true,
    });
  }
  setBits(ids, data.rawStored !== null ? PathState.RAW : 0, PathState.LOADING);
  invalidatePaths(ids);

  // Persist what is small and permanent, and the record of what is on
  // disk.
  const paths = state.model.paths;
  put(Store.SUMMARIES, hash, data.coarse);
  put(Store.INDEXES, hash, data.index);
  put(Store.REFS, hash, {
    hits: data.refs.hits.map((hit) => ({
      offset: hit.offset,
      digest: paths[hit.target].digest,
    })),
    truncated: data.refs.truncated,
  });
  if (data.rawStored === RawStore.OPFS) {
    put(Store.RAW, hash, {
      bytes: fetcher.stored.get(hash)?.bytes ?? 0,
      lastUsed: Date.now(),
    });
  }
}

// The paths the viewport covers at the current LOD, each with its
// distance from the centre in device pixels.
function visiblePaths() {
  const { order, offsets, total } = state.model;
  const camera = map.camera;
  const k = lodFor(camera.zoom, order);
  const size = tileWorldSize(k);
  const visible = new Map();
  for (const { tx, ty } of visibleTiles(camera.viewRect(), order, k)) {
    const [start, end] = tileByteRange(order, k, tx, ty);
    if (start >= total) {
      continue;
    }
    const [cx, cy] = camera.toDevice((tx + 0.5) * size, (ty + 0.5) * size);
    const distance = Math.hypot(cx - camera.width / 2, cy - camera.height / 2);
    const last = pathAt(offsets, Math.min(end, total) - 1);
    for (let id = Math.max(0, pathAt(offsets, start)); id <= last; id += 1) {
      const known = visible.get(id);
      if (known === undefined || distance < known) {
        visible.set(id, distance);
      }
    }
  }
  return { k, visible };
}

function updateFetching() {
  if (state.model === null || map === null) {
    return;
  }

  // Until the NARs already on disk are known, every path looks unfetched,
  // and fetching now would download them again over the files being read.
  if (state.restored !== state.generation) {
    return;
  }
  const { k, visible } = visiblePaths();
  const needRaw = k < LOD_COARSE;
  const jobs = new Map();
  let bytes = 0;
  const visibleHashes = new Set();

  for (const [id, distance] of visible) {
    const path = state.model.paths[id];
    if (path.narHash !== null) {
      visibleHashes.add(path.narHash);
    }
    const bits = state.bits[id];
    if (!fetchable(path) || bits & (PathState.LOADING | PathState.FAILED)) {
      continue;
    }
    const have = needRaw ? bits & PathState.RAW : bits & PathState.SUMMARY;
    if (have) {
      continue;
    }
    const known = jobs.get(path.narHash);
    if (known !== undefined) {
      known.priority = Math.min(known.priority, distance);
      continue;
    }
    jobs.set(path.narHash, jobFor(path, distance));
    bytes += path.fileSize || path.narSize;
  }

  fetcher.viewport(visibleHashes);
  if (needRaw) {
    fetcher.touch(visibleHashes);
  }
  if (k <= AUTO_FETCH_LOD && bytes > 0 && bytes <= AUTO_FETCH_BYTES) {
    fetcher.request([...jobs.values()], false);
    state.pending = { bytes: 0, jobs: [] };
  } else {
    state.pending = { bytes, jobs: [...jobs.values()] };
  }
  fetcher.pump(visibleHashes);
  renderFetchButtons();
}

const scheduleFetching = throttle(updateFetching, FETCH_UPDATE_MS);
setInterval(() => {
  if (fetcher.jobs.size > 0) {
    updateFetching();
  }
}, FETCH_TICK_MS);

// Everything that still needs its bytes, smallest download first.
function everythingPending() {
  const jobs = new Map();
  for (const path of state.model?.paths ?? []) {
    const bits = state.bits[path.id];
    if (
      !fetchable(path) ||
      bits & (PathState.RAW | PathState.LOADING) ||
      jobs.has(path.narHash)
    ) {
      continue;
    }
    jobs.set(path.narHash, jobFor(path, path.fileSize || path.narSize));
  }
  return [...jobs.values()];
}

function renderFetchButtons() {
  const visibleButton = $("fetch-visible");
  visibleButton.hidden = state.pending.bytes === 0;
  visibleButton.textContent = `Fetch visible (${humanBytes(state.pending.bytes)})`;

  const all = everythingPending();
  const allBytes = all.reduce(
    (sum, job) => sum + (job.fileSize || job.narSize),
    0,
  );
  const allButton = $("fetch-all");
  allButton.hidden = state.model === null || all.length === 0;
  allButton.textContent = state.allArmed
    ? `Confirm: download ${humanBytes(allBytes)}`
    : `Fetch everything (${humanBytes(allBytes)})`;
  allButton.classList.toggle("armed", state.allArmed);
  $("cancel-fetch").hidden = !fetcher.explicitPending;
}

$("fetch-visible").addEventListener("click", () => {
  fetcher.request(state.pending.jobs, true);
  fetcher.pump();
  state.pending = { bytes: 0, jobs: [] };
  renderFetchButtons();
});

$("fetch-all").addEventListener("click", () => {
  if (!state.allArmed) {
    state.allArmed = true;
    renderFetchButtons();
    setTimeout(() => {
      state.allArmed = false;
      renderFetchButtons();
    }, CONFIRM_MS);
    return;
  }
  state.allArmed = false;
  navigator.storage?.persist?.();
  fetcher.request(everythingPending(), true);
  fetcher.pump();
  renderFetchButtons();
});

$("cancel-fetch").addEventListener("click", () => {
  fetcher.cancelExplicit();
  renderFetchButtons();
});

function renderSession() {
  const parts = [
    `${humanBytes(fetcher.sessionBytes)} downloaded this session`,
    `${humanBytes(fetcher.storedTotal)} of ${humanBytes(fetcher.budget)} raw ${opfs ? "on disk" : "in memory"}`,
  ];
  if (fetcher.loading > 0 || fetcher.queued > 0) {
    parts.push(`${fetcher.loading} downloading, ${fetcher.queued} queued`);
  }
  $("session").textContent = parts.join(" · ");
}

// ---------- hover, selection, tooltip ----------

// What is at a world position: the path, the offset in its NAR, the file
// and the store-path reference there when known.
function hitTest(wx, wy) {
  const { order, total, offsets } = state.model;
  const side = 2 ** order;
  const x = Math.floor(wx);
  const y = Math.floor(wy);
  if (x < 0 || y < 0 || x >= side || y >= side) {
    return null;
  }
  const d = xy2d(order, x, y);
  if (d >= total) {
    return null;
  }
  const id = pathAt(offsets, d);
  const path = state.model.paths[id];
  const local = d - offsets[id];
  const lookup = state.lookups.get(path.narHash);
  const ordinal = lookup === undefined ? 0 : ordinalAt(lookup, local);
  const entry = ordinal === 0 ? null : lookup.entries[lookup.ids[ordinal - 1]];
  const hits = state.refs.get(path.narHash);
  const ref = hits === undefined ? null : refAt(hits, local);
  return { id, path, d, local, ordinal, entry, ref, x, y };
}

// The centre of a path's region, roughly: the world pixel of its middle
// byte.
function pathCenter(id) {
  const path = state.model.paths[id];
  const [x, y] = d2xy(
    state.model.order,
    path.start + Math.floor(path.narSize / 2),
  );
  return [x + 0.5, y + 0.5];
}

function flyToPath(id) {
  const path = state.model.paths[id];
  const [cx, cy] = pathCenter(id);
  const side = Math.max(FLY_MIN_SIDE, Math.sqrt(path.narSize));
  const camera = map.camera;
  map.flyTo(
    cx,
    cy,
    Math.log2((Math.min(camera.width, camera.height) * FLY_FILL) / side),
  );
}

const hex = (n) => `0x${n.toString(16)}`;

// ELF section tables by NAR hash and file, read once.
const elfCache = new Map();

async function readNar(path, offset, length) {
  if (opfs) {
    const dirs = await opfsDirs();
    return readSlice(dirs.raw, fileNameOf(path.narHash), offset, length);
  }
  return readThroughWorker(fileNameOf(path.narHash), "raw", offset, length);
}

const readRequests = new Map();
let nextRead = 0;
function readThroughWorker(name, kind, offset, length) {
  nextRead += 1;
  const requestId = nextRead;
  return new Promise((resolve, reject) => {
    readRequests.set(requestId, { resolve, reject });
    tileWorker.postMessage({
      type: "read",
      requestId,
      name,
      kind,
      offset,
      length,
    });
  });
}
// A NAR on disk that the tile worker could not read is evicted, which
// clears its state and files, so the next view that needs it fetches it.
tileWorker.addEventListener("message", ({ data }) => {
  if (data.type !== "unreadable" || data.generation !== state.generation) {
    return;
  }
  const hash = [...state.byHash.keys()].find(
    (h) => fileNameOf(h) === data.name,
  );
  if (hash === undefined) {
    return;
  }
  console.warn(
    `seenix: ${data.name} is unreadable (${data.message}); fetching it again`,
  );
  fetcher.evict(hash);
  setBits(state.byHash.get(hash), 0, PathState.RAW);
  invalidatePaths(state.byHash.get(hash));
  scheduleFetching();
});

tileWorker.addEventListener("message", ({ data }) => {
  if (data.type !== "read") {
    return;
  }
  const request = readRequests.get(data.requestId);
  readRequests.delete(data.requestId);
  if (data.error) {
    request?.reject(new Error(data.error));
  } else {
    request?.resolve(data.bytes);
  }
});

function elfSections(path, entry) {
  const key = `${path.narHash}/${entry.contentOffset}`;
  if (!elfCache.has(key)) {
    const read = (offset, length) =>
      readNar(
        path,
        entry.contentOffset + offset,
        Math.max(0, Math.min(length, entry.size - offset)),
      );
    elfCache.set(
      key,
      read(0, 4)
        .then((head) => (isElf(head) ? readElfSections(read) : null))
        .catch(() => null),
    );
  }
  return elfCache.get(key);
}

let tooltipTarget = null;

function tooltipContent(hit) {
  const { path, id } = hit;
  const analysis = state.analysis;
  const sizes = [
    `${humanBytes(path.narSize)} self`,
    analysis ? `retained ${humanBytes(analysis.retained[id])}` : null,
    analysis ? `closure ${humanBytes(analysis.closure[id])}` : null,
  ].filter(Boolean);

  const lines = [
    el("div", { class: "tip-name" }, path.name),
    el("div", {}, sizes.join(" · ")),
  ];
  const fileLine = el("div", { class: "tip-file" });
  if (hit.entry !== null) {
    fileLine.textContent = `${hit.entry.path || "(file)"} +${hex(hit.local - hit.entry.contentOffset)}`;
    lines.push(fileLine);
    if (state.bits[id] & PathState.RAW) {
      elfSections(path, hit.entry).then((elf) => {
        if (tooltipTarget !== hit || elf === null) {
          return;
        }
        if (!elf.ok) {
          fileLine.textContent += ` · ${elf.reason}`;
          return;
        }
        const section = sectionAt(
          elf.sections,
          hit.local - hit.entry.contentOffset,
        );
        if (section !== null) {
          fileLine.textContent = `${hit.entry.path} · ${section.name} +${hex(hit.local - hit.entry.contentOffset - section.offset)}`;
        }
      });
    }
  } else {
    lines.push(el("div", { class: "muted" }, `NAR offset ${hex(hit.local)}`));
  }
  if (hit.ref !== null) {
    lines.push(
      el(
        "div",
        { class: "tip-ref" },
        `→ ${state.model.paths[hit.ref.target].storePath}`,
      ),
    );
  }
  const bits = state.bits[id];
  if (!(bits & PathState.RAW)) {
    lines.push(
      el("div", { class: "muted" }, loadStateText(panelContext(), id)),
    );
  }
  return lines;
}

function showTooltip(hit, point) {
  const tooltip = $("tooltip");
  tooltipTarget = hit;
  tooltip.replaceChildren(...tooltipContent(hit));
  tooltip.hidden = false;
  if (point.pointerType !== "mouse") {
    tooltip.style.transform = "";
    return;
  }
  const shell = $("map-shell");
  const margin = 14;
  const x = Math.min(
    point.cssX + margin,
    shell.clientWidth - tooltip.offsetWidth - 4,
  );
  const y =
    point.cssY + margin + tooltip.offsetHeight > shell.clientHeight
      ? point.cssY - tooltip.offsetHeight - margin
      : point.cssY + margin;
  tooltip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
}

function hideTooltip() {
  tooltipTarget = null;
  $("tooltip").hidden = true;
}

function onHover(point) {
  if (state.model === null || point === null) {
    hideTooltip();
    map?.setHover(NO_PATH, 0, null);
    return;
  }
  const hit = hitTest(point.wx, point.wy);
  if (hit === null) {
    hideTooltip();
    map.setHover(NO_PATH, 0, null);
    return;
  }
  const refLine =
    hit.ref === null
      ? null
      : { from: [hit.x + 0.5, hit.y + 0.5], to: pathCenter(hit.ref.target) };
  map.setHover(hit.id, hit.ordinal, refLine);
  showTooltip(hit, point);
}

function onSelect(point) {
  if (state.model === null) {
    return;
  }
  const hit = hitTest(point.wx, point.wy);
  select(hit === null ? -1 : hit.id);
  if (point.pointerType !== "mouse") {
    if (hit === null) {
      hideTooltip();
    } else {
      showTooltip(hit, point);
    }
  }
}

function select(id, fly = false) {
  state.selected = id;
  map?.setSelected(id);
  if (id >= 0) {
    setTab(Tab.INSPECT);
  }
  if (fly && id >= 0 && map !== null) {
    flyToPath(id);
  }
  refreshPanels();
  scheduleUrl();
}

// ---------- panels ----------

function panelContext() {
  return {
    model: state.model,
    bits: state.bits,
    byHash: state.byHash,
    errors: state.errors,
    coarse: state.coarse,
    indexes: state.indexes,
    refs: state.refs,
    verified: state.verified,
    analysis: state.analysis,
    selected: state.selected,
    jobs: fetcher.jobs,
    fetcher,
    opfs,
    identify,
    multiverseUrl,
    fetchable,
    copy,
    select,
    fetchPath(id) {
      fetcher.request([jobFor(state.model.paths[id], -1)], true);
      fetcher.pump();
    },
    evictPath(id) {
      fetcher.evict(state.model.paths[id].narHash);
    },
  };
}

const refreshPanels = throttle(() => {
  const ctx = panelContext();
  if (state.tab === Tab.INSPECT) {
    renderInspect($("inspect"), ctx);
  } else {
    renderStats($("stats"), ctx);
  }
  renderFetchButtons();
  renderSession();
}, PANEL_REFRESH_MS);

function setTab(tab) {
  state.tab = tab;
  for (const link of document.querySelectorAll("#panel-tabs a")) {
    link.classList.toggle("active", link.dataset.tab === tab);
  }
  $("inspect").hidden = tab !== Tab.INSPECT;
  $("stats").hidden = tab !== Tab.STATS;
  refreshPanels();
}

for (const link of document.querySelectorAll("#panel-tabs a")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    setTab(link.dataset.tab);
  });
}

// ---------- toolbar ----------

// What each mode's colours mean: a title for the button and the dots
// under the toolbar.
const HATCH = { hatch: true, label: "hatched: not fetched yet" };
const PADDING = { padding: true, label: "background: past the last byte" };
const MODE_HELP = {
  [Mode.BYTES]: {
    title:
      "each byte by value, once zoomed in; a mix of byte classes further out",
    dots: [
      { color: "#000000", label: "0x00" },
      { color: "#33ad59", label: "control" },
      { color: "#4080f2", label: "printable ASCII" },
      { color: "#eb5933", label: "high bytes" },
      { color: "#ffffff", label: "0xff" },
      HATCH,
      PADDING,
    ],
  },
  [Mode.CLASSES]: {
    title: "the mix of zero, control, ASCII and high bytes at every zoom",
    dots: [
      { color: "#08080a", label: "zero" },
      { color: "#33ad59", label: "control" },
      { color: "#4080f2", label: "ASCII" },
      { color: "#eb5933", label: "high" },
      HATCH,
      PADDING,
    ],
  },
  [Mode.ENTROPY]: {
    title:
      "Shannon entropy per 256 bytes: compressed data bright, text and padding dark",
    dots: [
      { color: "#0a0829", label: "low: padding, text" },
      { color: "#bd3861", label: "middling: code" },
      { color: "#f78c24", label: "high" },
      { color: "#fdf399", label: "compressed or random" },
      HATCH,
      PADDING,
    ],
  },
  [Mode.PACKAGE]: {
    title: "one hue per package, brighter where fetched bytes are dense",
    dots: [{ color: "#7a8fd6", label: "one hue per package" }, HATCH, PADDING],
  },
};

function renderModes() {
  for (const button of document.querySelectorAll("#modes button")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.mode === state.mode),
    );
    button.title = MODE_HELP[button.dataset.mode].title;
  }
  $("mode-legend").replaceChildren(
    ...MODE_HELP[state.mode].dots.map((dot) =>
      el(
        "li",
        {},
        el(
          "i",
          dot.hatch
            ? { class: "hatch" }
            : dot.padding
              ? { class: "padding" }
              : { style: `background: ${dot.color}` },
        ),
        dot.label,
      ),
    ),
  );
}

for (const mode of MODES) {
  $("modes").append(
    el(
      "button",
      {
        type: "button",
        "data-mode": mode,
        onclick: () => {
          state.mode = mode;
          renderModes();
          map?.setMode(mode);
          scheduleUrl();
        },
      },
      mode,
    ),
  );
}
renderModes();

function searchRow(path) {
  return el(
    "li",
    {
      "data-id": path.id,
      onpointerdown: (event) => {
        event.preventDefault();
        pick(path.id);
      },
    },
    el("span", {}, path.name),
    el("span", { class: "muted" }, humanBytes(path.narSize)),
  );
}

// Matches for the query, or with nothing typed yet, the roots and the
// largest paths, so the box shows what there is to find.
function renderSearch() {
  const input = $("search");
  const query = input.value.trim().toLowerCase();
  const results = $("search-results");
  if (state.model === null || document.activeElement !== input) {
    results.hidden = true;
    return;
  }

  const { paths, roots } = state.model;
  if (query === "") {
    const rootSet = new Set(roots);
    const largest = [...paths]
      .filter((p) => !rootSet.has(p.id))
      .sort((a, b) => b.narSize - a.narSize)
      .slice(0, SEARCH_LIMIT - Math.min(roots.length, 2));
    results.replaceChildren(
      el("li", { class: "heading" }, roots.length === 1 ? "root" : "roots"),
      ...roots.slice(0, 2).map((id) => searchRow(paths[id])),
      el("li", { class: "heading" }, "largest paths"),
      ...largest.map(searchRow),
    );
    results.hidden = false;
    return;
  }

  const matches = paths
    .filter((p) => p.name.toLowerCase().includes(query))
    .sort(
      (a, b) =>
        a.name.indexOf(query) - b.name.indexOf(query) || b.narSize - a.narSize,
    )
    .slice(0, SEARCH_LIMIT);
  results.replaceChildren(
    ...(matches.length > 0
      ? matches.map(searchRow)
      : [el("li", { class: "heading" }, `no path named like "${query}"`)]),
  );
  results.hidden = false;
}

function pick(id) {
  $("search").value = "";
  $("search").blur();
  $("search-results").hidden = true;
  select(id, true);
}

$("search").addEventListener("input", renderSearch);
$("search").addEventListener("focus", renderSearch);
$("search").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  const first = $("search-results").querySelector("li[data-id]");
  if (first !== null) {
    pick(Number(first.dataset.id));
  }
});
$("search").addEventListener("blur", () => {
  $("search-results").hidden = true;
});

$("save-png").addEventListener("click", async () => {
  if (map === null || state.model === null) {
    return;
  }
  const blob = await map.snapshot();
  const link = el("a", {
    href: URL.createObjectURL(blob),
    download: `seenix-${state.model.paths[state.model.roots[0] ?? 0].name}-${state.mode}.png`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
});

$("fit").addEventListener("click", () => map?.fit());

// ---------- sources ----------

for (const link of document.querySelectorAll("#lanes a")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    for (const other of document.querySelectorAll("#lanes a")) {
      other.classList.toggle("active", other === link);
    }
    for (const lane of document.querySelectorAll(".lane")) {
      lane.hidden = lane.dataset.lane !== link.dataset.lane;
    }
  });
}

const words = (text) => text.split(/\s+/).filter(Boolean);

$("path-form").addEventListener("submit", (event) => {
  event.preventDefault();
  navigate({ paths: words($("store-path").value), pkgs: [], json: null });
});

$("pkg-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const pkgs = words($("pkg-input").value).map((spec) => {
    const at = spec.lastIndexOf("@");
    return at <= 0
      ? { attr: spec, version: null }
      : { attr: spec.slice(0, at), version: spec.slice(at + 1) };
  });
  navigate({ paths: [], pkgs, json: null });
});

$("json-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = $("json-url").value.trim();
  if (url !== "") {
    navigate({ paths: [], pkgs: [], json: url });
  }
});

async function loadFile(file) {
  navigate({ paths: [], pkgs: [], json: null }, await file.text());
}

$("json-file").addEventListener("change", () => {
  const file = $("json-file").files[0];
  if (file !== undefined) {
    loadFile(file);
  }
});

const shell = $("map-shell");
shell.addEventListener("dragover", (event) => {
  event.preventDefault();
  $("drop-hint").hidden = false;
});
shell.addEventListener("dragleave", () => {
  $("drop-hint").hidden = true;
});
shell.addEventListener("drop", (event) => {
  event.preventDefault();
  $("drop-hint").hidden = true;
  const file = event.dataTransfer.files[0];
  if (file !== undefined) {
    loadFile(file);
  }
});

$("caches-input").addEventListener("input", () => {
  try {
    state.caches = parseSubstituters($("caches-input").value);
    $("caches-status").textContent =
      state.caches.length === 0
        ? ""
        : `${state.caches.length} extra caches; they apply to the next closure loaded.`;
    $("caches-status").classList.remove("error");
    scheduleUrl();
  } catch (err) {
    $("caches-status").textContent = err.message;
    $("caches-status").classList.add("error");
  }
});

// The featured closures, as links that load in place. One that names a
// cache puts it in the link, the same as the caches lane would.
function featuredLink(featured) {
  const source = { paths: [featured.path], pkgs: [], json: null };
  const caches = featured.cache ? parseSubstituters(featured.cache) : [];
  return el(
    "a",
    {
      href: writeUrl({ ...source, caches }),
      title: featured.title,
      onclick: (event) => {
        event.preventDefault();
        navigate(source, null, caches);
      },
    },
    featured.label,
  );
}

function renderFeatured() {
  const links = FEATURED.map(featuredLink);
  $("examples").append(
    ...links.flatMap((link, i) => (i === 0 ? [link] : [" · ", link])),
  );
  $("empty-examples").append(
    ...FEATURED.map((featured) => el("li", {}, featuredLink(featured))),
  );
}

// The site build substitutes the derivation's own $out into STORE_PATH, so
// the footer names the store path serving the page. A local checkout still
// carries the placeholder, and the line stays hidden.
const STORE_PATH = "__STORE_PATH__";
if (!STORE_PATH.startsWith("__")) {
  $("store-path-footer").textContent = STORE_PATH;
  $("store").hidden = false;
}

renderFeatured();
applyUrl(readUrl());
renderSession();
load();

// Exposed for the browser smoke test and for poking at from a console.
window.seenix = { state, fetcher, map, hitTest, percent };
