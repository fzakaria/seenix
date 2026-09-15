// The package lane. The input completes attribute names from the
// nixpkgs-multiverse index, and versions once an "@" is typed; under it,
// the attributes matching the word at the caret, and once one is chosen,
// every version nixpkgs shipped of it. Each version number links to its
// page on nixmultiverse.com, and the rest of the pill maps that version.
//
// A version with no x86_64-linux build is shown struck through rather
// than hidden, so the list matches the version count beside the
// attribute, and a note under the list says why once.

import { PACKAGE_COMPLETIONS, PACKAGE_MATCHES, SYSTEM } from "./config.js";
import { humanBytes } from "./format.js";
import {
  attrNames,
  bootable,
  multiverseUrl,
  searchAttrs,
  versionRowsOf,
} from "./multiverse.js";
import { el, fill } from "./panel.js";

// How long the box sits still before a keystroke becomes a lookup.
const DEBOUNCE_MS = 120;

// Attribute completion starts at this many characters; one character
// matches thousands of names.
const MIN_ATTR_PREFIX = 2;

const VERSION_SEPARATOR = "@";

const NO_BUILD = "no build";
const NO_BUILD_NOTE = `no build: nixpkgs shipped that version and Hydra never built it for ${SYSTEM}, so there is no closure to map. Hydra builds neither unfree nor broken packages, and an attribute can also leave its jobset.`;

const Completion = Object.freeze({ ATTR: "attr", VERSION: "version" });

export class PackagePicker {
  // `current` answers whether a version is already on the map, and
  // `onPick` maps one.
  constructor({ input, dropdown, results, current, onPick }) {
    this.input = input;
    this.dropdown = dropdown;
    this.results = results;
    this.current = current;
    this.onPick = onPick;
    this.suggestions = [];
    this.selected = -1;
    this.expanded = null;

    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.update(), DEBOUNCE_MS);
    });
    input.addEventListener("blur", () => setTimeout(() => this.hide(), 150));
    input.addEventListener("keydown", (event) => this.onKeyDown(event));
    dropdown.addEventListener("mousedown", (event) => {
      const item = event.target.closest("li[data-i]");
      if (item !== null) {
        event.preventDefault();
        this.accept(Number(item.dataset.i));
      }
    });
  }

  // The word the caret sits in: an attribute being typed, or a version
  // being typed after "@", with where the completable part starts.
  fragment() {
    const upto = this.input.value.slice(0, this.input.selectionStart);
    const wordStart = upto.search(/\S+$/);
    if (wordStart === -1) {
      return null;
    }
    const word = upto.slice(wordStart);
    const at = word.indexOf(VERSION_SEPARATOR);
    if (at === -1) {
      return {
        mode: Completion.ATTR,
        attr: word,
        start: wordStart,
        prefix: word,
      };
    }
    return {
      mode: Completion.VERSION,
      attr: word.slice(0, at),
      start: wordStart + at + 1,
      prefix: word.slice(at + 1),
    };
  }

  // Completions for the caret's word, and the list under the input.
  async update() {
    const fragment = this.fragment();
    await Promise.all([this.complete(fragment), this.list(fragment)]);
  }

  async complete(fragment) {
    if (
      fragment === null ||
      (fragment.mode === Completion.ATTR &&
        fragment.prefix.length < MIN_ATTR_PREFIX)
    ) {
      this.hide();
      return;
    }

    let pool;
    if (fragment.mode === Completion.ATTR) {
      const names = await attrNames();
      pool = Object.keys(names)
        .filter((name) => name.startsWith(fragment.prefix))
        .sort((a, b) => a.length - b.length || a.localeCompare(b));
    } else {
      pool = (await versionRowsOf(fragment.attr))
        .filter(bootable)
        .map((row) => row.version)
        .filter((version) => version.startsWith(fragment.prefix));
    }

    this.suggestions = pool
      .slice(0, PACKAGE_COMPLETIONS)
      .map((text) => ({ text, fragment }));
    this.selected = -1;
    if (
      this.suggestions.length === 0 ||
      document.activeElement !== this.input
    ) {
      this.hide();
      return;
    }
    this.dropdown.replaceChildren(
      ...this.suggestions.map(({ text }, i) =>
        el(
          "li",
          { "data-i": String(i) },
          fragment.mode === Completion.VERSION
            ? el("span", { class: "muted" }, VERSION_SEPARATOR)
            : null,
          text,
        ),
      ),
    );
    this.dropdown.hidden = false;
  }

  // Attributes matching the word, or one attribute's versions once its
  // name is followed by "@".
  async list(fragment) {
    if (fragment === null || fragment.attr === "") {
      this.expanded = null;
      fill(this.results);
      return;
    }
    if (fragment.mode === Completion.VERSION) {
      await this.expand(fragment.attr);
      return;
    }
    this.expanded = null;
    const matches = await searchAttrs(fragment.attr, PACKAGE_MATCHES);
    if (matches.length === 0) {
      fill(this.results, el("p", { class: "muted" }, "no such attribute"));
      return;
    }
    fill(
      this.results,
      ...matches.map((match) =>
        el(
          "button",
          {
            class: "attr",
            type: "button",
            onclick: () => this.choose(match.attr),
          },
          el("span", { class: "name" }, match.attr),
          el("span", { class: "muted" }, `${match.versionCount} versions`),
        ),
      ),
    );
  }

  // Put an attribute in the box and show its versions.
  choose(attr) {
    this.replaceWord(`${attr}${VERSION_SEPARATOR}`);
    this.expand(attr);
  }

  async expand(attr) {
    if (this.expanded === attr) {
      return;
    }
    this.expanded = attr;
    fill(this.results, el("p", { class: "muted" }, `loading ${attr}…`));
    const versions = await versionRowsOf(attr);
    if (this.expanded !== attr) {
      return;
    }
    if (versions.length === 0) {
      fill(
        this.results,
        el(
          "p",
          { class: "muted" },
          `${attr} is not in the nixpkgs-multiverse index.`,
        ),
      );
      return;
    }

    const unbuilt = versions.filter((v) => !bootable(v)).length;
    const summary = [`${versions.length} versions`];
    if (unbuilt > 0) {
      summary.push(`${unbuilt} with no ${SYSTEM} build`);
    }
    fill(
      this.results,
      el(
        "p",
        { class: "muted" },
        indexLink({ attr }, `${attr} on nixmultiverse.com`),
        ` · ${summary.join(" · ")}`,
      ),
      ...versions.map((version) => this.pill(version)),
      unbuilt > 0 ? el("p", { class: "muted note" }, NO_BUILD_NOTE) : null,
    );
  }

  // One version: its number linked to the index, and the map target
  // beside it, showing the closure size when the index knows it.
  pill(version) {
    const number = indexLink(
      version,
      `${version.attr} ${version.version} on nixmultiverse.com`,
      version.version,
    );
    number.classList.add("name");

    if (!bootable(version)) {
      return el(
        "span",
        { class: "pick dead" },
        number,
        el(
          "button",
          {
            class: "take",
            type: "button",
            disabled: true,
            title: NO_BUILD_NOTE,
          },
          NO_BUILD,
        ),
      );
    }

    const on = this.current(version);
    return el(
      "span",
      { class: on ? "pick on" : "pick" },
      number,
      el(
        "button",
        {
          class: "take",
          type: "button",
          title: `map ${version.storePath}`,
          onclick: () => this.onPick(version),
        },
        version.closureSize > 0
          ? `map ${humanBytes(version.closureSize)}`
          : "map",
      ),
    );
  }

  replaceWord(text) {
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    const wordStart = value.slice(0, caret).search(/\S*$/);
    this.input.value = value.slice(0, wordStart) + text + value.slice(caret);
    const position = wordStart + text.length;
    this.input.setSelectionRange(position, position);
    this.input.focus();
  }

  hide() {
    this.suggestions = [];
    this.selected = -1;
    this.dropdown.hidden = true;
  }

  accept(i) {
    const { text, fragment } = this.suggestions[i];
    const value = this.input.value;
    const caret = this.input.selectionStart;
    this.input.value =
      value.slice(0, fragment.start) + text + value.slice(caret);
    const position = fragment.start + text.length;
    this.input.setSelectionRange(position, position);
    this.input.focus();
    this.hide();
    if (fragment.mode === Completion.ATTR) {
      this.expand(text);
    }
  }

  move(delta) {
    const count = this.suggestions.length;
    if (count === 0) {
      return;
    }
    this.selected = (this.selected + delta + count) % count;
    for (const [i, item] of [...this.dropdown.children].entries()) {
      item.classList.toggle("selected", i === this.selected);
    }
  }

  onKeyDown(event) {
    if (this.dropdown.hidden) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      this.hide();
      return;
    }
    // Tab takes the first completion; Enter only a highlighted one, so
    // Enter with nothing highlighted still submits the form.
    if (
      event.key === "Tab" ||
      (event.key === "Enter" && this.selected !== -1)
    ) {
      event.preventDefault();
      this.accept(this.selected === -1 ? 0 : this.selected);
    }
  }
}

// A link to what nixmultiverse.com says about an attribute or a version.
function indexLink(target, title, text = target.attr) {
  return el(
    "a",
    {
      class: "out",
      href: multiverseUrl(target),
      title,
      rel: "noopener",
      target: "_blank",
    },
    text,
  );
}
