import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const CLIENT_PATH = path.join(ROOT, "src", "client", "factory-client.ts");
const COMMANDS = JSON.stringify([
  { name: "help", label: "/help", usage: "/help or /?", description: "Show slash command help." },
  { name: "react", label: "/react", usage: "/react [message]", description: "React to the selected objective." },
  { name: "abort-job", label: "/abort-job", usage: "/abort-job [reason]", description: "Abort the active job." },
]);

type Listener = (event: MockEvent) => void;

class MockEvent {
  defaultPrevented = false;
  type = "";
  target: unknown;
  currentTarget: unknown;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  bubbles?: boolean;
  data?: string;
  constructor(init: Partial<MockEvent> = {}) {
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class MockClassList {
  private readonly classes = new Set<string>();
  add(...values: ReadonlyArray<string>) { values.forEach((value) => this.classes.add(value)); }
  remove(...values: ReadonlyArray<string>) { values.forEach((value) => this.classes.delete(value)); }
  toggle(value: string, force?: boolean) {
    if (force === undefined ? !this.classes.has(value) : force) this.classes.add(value);
    else this.classes.delete(value);
  }
  contains(value: string) { return this.classes.has(value); }
}

class MockElement {
  private _innerHTML = "";
  id = "";
  dataset: Record<string, string> = {};
  classList = new MockClassList();
  style: Record<string, string> = {};
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  scrollTop = 0;
  scrollHeight = 400;
  clientHeight = 240;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<Listener>>();
  parentElement: MockElement | null = null;
  firstElementChild: MockElement | null = null;
  selectionStart = 0;
  selectionEnd = 0;
  constructor(readonly tagName: string) {}
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value: string) {
    this._innerHTML = value;
    this.firstElementChild = parseFirstElement(value, this);
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(type: string, handler: Listener) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type: string, handler: Listener) {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    this.listeners.set(type, handlers.filter((candidate) => candidate !== handler));
  }
  dispatchEvent(event: MockEvent) {
    event.target = event.target ?? this;
    event.currentTarget = this;
    for (const handler of this.listeners.get(event.type as string) ?? []) handler(event);
    return !event.defaultPrevented;
  }
  focus() {
    const doc = (globalThis as { __mockDocument?: { activeElement?: unknown } }).__mockDocument;
    if (doc) doc.activeElement = this;
  }
  closest(selector: string) {
    let node: MockElement | null = this;
    while (node) {
      if (selector === "[data-command-index]" && node.getAttribute("data-command-index") !== null) return node;
      if (selector === "[data-receipt-row]" && node.getAttribute("data-receipt-row") !== null) return node;
      if (selector === "[data-factory-href],a[href]") {
        if (node.getAttribute("data-factory-href") !== null) return node;
        if (node.tagName === "A" && node.getAttribute("href")) return node;
      }
      node = node.parentElement;
    }
    return null;
  }
  contains(node: unknown) {
    let current = node instanceof MockElement ? node : null;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }
  querySelector() { return null; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  scrollTo(options: { readonly top?: number }) {
    this.scrollTop = typeof options?.top === "number" ? options.top : this.scrollHeight;
  }
}

class MockButton extends MockElement {
  constructor() { super("BUTTON"); }
}

class MockInput extends MockElement {
  constructor() { super("INPUT"); }
}

class MockSelect extends MockElement {
  constructor() { super("SELECT"); }
}

class MockTextArea extends MockElement {
  scrollHeight = 140;
  constructor() { super("TEXTAREA"); }
}

class MockForm extends MockElement {
  action = "/factory/compose?profile=generalist";
  method = "post";
  constructor() { super("FORM"); }
  requestSubmit() { this.dispatchEvent(new MockEvent({ type: "submit", target: this })); }
}

class MockEventSource {
  static readonly instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MockEvent) => void>>();
  closed = false;
  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (event: MockEvent) => void) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  emit(type: string, data = "") {
    if (this.closed) return;
    const event = new MockEvent({ type, data });
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  close() {
    this.closed = true;
  }
}

const parseFirstElement = (value: string, parent: MockElement): MockElement | null => {
  const match = value.match(/<([a-zA-Z0-9-]+)([^>]*)>/);
  if (!match || !match[1]) return null;
  const element = new MockElement(match[1].toUpperCase());
  const attrs = match[2] ?? "";
  for (const attr of attrs.matchAll(/([a-zA-Z0-9:-]+)="([^"]*)"/g)) {
    if (!attr[1]) continue;
    element.setAttribute(attr[1], attr[2] ?? "");
  }
  element.parentElement = parent;
  return element;
};

let bundledClientSource: string | undefined;

const loadClient = async () => {
  if (bundledClientSource) return bundledClientSource;
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-factory-client-"));
  const build = await Bun.build({
    entrypoints: [CLIENT_PATH],
    outdir,
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join("\n"));
  }
  bundledClientSource = fs.readFileSync(path.join(outdir, "factory-client.js"), "utf-8");
  return bundledClientSource;
};

const flushAsync = async (delayMs = 0) => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, delayMs));
};

const chatMarkup = (input: {
  readonly profileLabel?: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly activeRunId?: string;
  readonly knownRunIds?: ReadonlyArray<string>;
  readonly terminalRunIds?: ReadonlyArray<string>;
  readonly transcriptSignature?: string;
  readonly lastItemKind?: "user" | "assistant" | "system" | "work" | "objective_event";
} = {}) =>
  `<div data-active-profile="generalist" data-active-profile-label="${input.profileLabel ?? "Generalist"}" data-chat-id="${input.chatId ?? ""}" data-objective-id="${input.objectiveId ?? ""}" data-active-run-id="${input.activeRunId ?? ""}" data-known-run-ids="${(input.knownRunIds ?? []).join(",")}" data-terminal-run-ids="${(input.terminalRunIds ?? []).join(",")}" data-transcript-signature="${input.transcriptSignature ?? "0:empty"}" data-last-item-kind="${input.lastItemKind ?? ""}"></div>`;

const WORKBENCH_CHAT_DESCRIPTOR = "body:agent-refresh@180,body:job-refresh@180";
const WORKBENCH_BACKGROUND_DESCRIPTOR = "";
const WORKBENCH_HEADER_DESCRIPTOR = "";
const WORKBENCH_RAIL_DESCRIPTOR = "body:profile-board-refresh@320";
const WORKBENCH_PROFILE_BOARD_BLOCK_DESCRIPTOR = "body:profile-board-refresh@320";
const WORKBENCH_SUMMARY_DESCRIPTOR = "body:profile-board-refresh@320,body:objective-runtime-refresh@320";
const WORKBENCH_ACTIVITY_DESCRIPTOR = "body:objective-runtime-refresh@320";

const workbenchChatDescriptor = (inspectorTab: string, objectiveId?: string) =>
  inspectorTab === "chat"
    ? WORKBENCH_CHAT_DESCRIPTOR
    : [
        "body:profile-board-refresh@300",
        ...(objectiveId ? ["body:objective-runtime-refresh@300"] : []),
      ].join(",");

const workbenchHeaderPath = (search: string) => `/factory/island/workbench/header${search}`;

const workbenchBlockPath = (search: string, block: "summary" | "activity" | "objectives" | "history") => {
  const parsed = new URL("http://receipt.test/factory" + search);
  parsed.pathname = "/factory/island/workbench/block";
  parsed.searchParams.set("block", block);
  return `${parsed.pathname}${parsed.search}`;
};

const workbenchPanelMarkup = (search: string, objectiveId?: string, content = "workbench panel") =>
  `<div class="flex min-w-0 flex-col gap-4 lg:grid lg:grid-cols-[minmax(320px,0.88fr)_minmax(0,1.12fr)]" data-workbench-objective-id="${objectiveId ?? ""}">
    <section id="factory-workbench-rail-shell" data-refresh-path="/factory/island/workbench/rail${search}" data-refresh-on="${WORKBENCH_RAIL_DESCRIPTOR}">
      <section id="factory-workbench-rail-scroll" data-preserve-scroll-key="rail" class="factory-scrollbar flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
        <div id="factory-workbench-block-summary" data-workbench-projections="profile-board objective-runtime" data-refresh-path="${workbenchBlockPath(search, "summary")}"><div>${content} summary</div></div>
        <div id="factory-workbench-block-objectives" data-workbench-projections="profile-board" data-refresh-path="${workbenchBlockPath(search, "objectives")}"><div>${content} objectives</div></div>
        <div id="factory-workbench-block-history" data-workbench-projections="profile-board" data-refresh-path="${workbenchBlockPath(search, "history")}"><div>${content} history</div></div>
      </section>
    </section>
    <section id="factory-workbench-focus-shell" data-refresh-path="/factory/island/workbench/focus${search}" data-refresh-on="${WORKBENCH_SUMMARY_DESCRIPTOR}">
      <section id="factory-workbench-focus-scroll" data-preserve-scroll-key="focus" class="factory-scrollbar min-h-0 min-w-0 overflow-y-auto">
        <div id="factory-workbench-block-activity" data-workbench-projections="objective-runtime" data-refresh-path="${workbenchBlockPath(search, "activity")}"><div>${content} activity</div></div>
      </section>
    </section>
  </div>`;

const workbenchShellMarkup = (input: {
  readonly search?: string;
  readonly profileLabel?: string;
  readonly chatHtml?: string;
  readonly workbenchHtml?: string;
  readonly placeholder?: string;
} = {}) => {
  const search = input.search ?? "?profile=generalist&chat=chat_demo";
  const parsed = new URL("http://receipt.test/factory" + search);
  const profileId = parsed.searchParams.get("profile") || "generalist";
  const profileLabel = input.profileLabel ?? "Generalist";
  const chatId = parsed.searchParams.get("chat") || "";
  const objectiveId = parsed.searchParams.get("objective") || undefined;
  const inspectorTab = parsed.searchParams.get("inspectorTab") || "overview";
  const focusKind = parsed.searchParams.get("focusKind") || "";
  const focusId = parsed.searchParams.get("focusId") || "";
  const chatEvents = new URLSearchParams();
  chatEvents.set("profile", profileId);
  if (chatId) chatEvents.set("chat", chatId);
  if (objectiveId) chatEvents.set("objective", objectiveId);
  if (focusKind === "job" && focusId) chatEvents.set("job", focusId);
  return `<!doctype html>
<html>
<head>
  <title>Receipt Factory Workbench</title>
</head>
<body data-factory-workbench="true" data-route-key="/factory${search}" data-chat-id="${chatId}" data-objective-id="${objectiveId ?? ""}" data-inspector-tab="${inspectorTab}" data-focus-kind="${focusKind}" data-focus-id="${focusId}">
  <div id="factory-workbench-header" data-refresh-path="${workbenchHeaderPath(search)}" data-refresh-on="${WORKBENCH_HEADER_DESCRIPTOR}">
    <select id="factory-workbench-profile-select" data-factory-profile-select="true">
      <option value="/factory?profile=${profileId}&chat=${chatId || "chat_demo"}" selected>${profileLabel}</option>
      <option value="/factory?profile=software&chat=${chatId || "chat_demo"}">Software</option>
    </select>
  </div>
  <div id="factory-workbench-background-root" data-events-path="/factory/background/events${search}">
    <div id="factory-workbench-panel" data-refresh-path="/factory/island/workbench${search}" data-refresh-on="${WORKBENCH_BACKGROUND_DESCRIPTOR}">${input.workbenchHtml ?? workbenchPanelMarkup(search, objectiveId)}</div>
  </div>
  <aside id="factory-workbench-chat-pane">
    <div id="factory-workbench-chat-region" data-refresh-path="/factory/island/workbench/chat-shell${search}">
      <div id="factory-workbench-chat-header" data-refresh-path="/factory/island/chat/header${search}"><span>${profileLabel}</span></div>
      <div id="factory-workbench-chat-body" data-refresh-path="/factory/island/workbench/chat-body${search}" data-refresh-on="${workbenchChatDescriptor(inspectorTab, objectiveId)}">
        <div id="factory-workbench-chat-root" data-events-path="/factory/chat/events?${chatEvents.toString()}">
          <div id="factory-workbench-chat-scroll">
            <div id="factory-workbench-chat" data-refresh-path="/factory/island/chat${search}">${input.chatHtml ?? chatMarkup({ profileLabel, chatId: chatId || undefined, objectiveId })}</div>
            <div id="factory-chat-live">
              <div id="factory-chat-streaming">
                <section id="factory-chat-stream-shell" data-factory-stream-shell data-stream-state="idle">
                  <span id="factory-chat-streaming-label-text">${profileLabel}</span>
                  <span id="factory-chat-streaming-status">Streaming</span>
                  <div id="factory-chat-streaming-loader" class="hidden"><span id="factory-chat-streaming-loader-label">Sending</span></div>
                  <div id="factory-chat-streaming-content"></div>
                </section>
              </div>
              <div id="factory-chat-stream-reset-listener"></div>
              <div id="factory-chat-optimistic"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <form id="factory-composer" action="/factory/compose${search}" data-composer-commands='${COMMANDS}'></form>
    <input id="factory-composer-current-job" value="" />
    <textarea id="factory-prompt" placeholder="${input.placeholder ?? ""}"></textarea>
    <div id="factory-composer-completions" class="hidden"></div>
    <div id="factory-composer-status"></div>
    <button id="factory-composer-submit">Send</button>
  </aside>
</body>
</html>`;
};

const workbenchShellSnapshot = (input: {
  readonly search?: string;
  readonly profileLabel?: string;
  readonly chatHtml?: string;
  readonly workbenchHtml?: string;
  readonly placeholder?: string;
  readonly location?: string;
} = {}) => {
  const search = input.search ?? "?profile=generalist&chat=chat_demo";
  const parsed = new URL("http://receipt.test/factory" + search);
  const profileId = parsed.searchParams.get("profile") || "generalist";
  const profileLabel = input.profileLabel ?? "Generalist";
  const chatId = parsed.searchParams.get("chat") || "";
  const objectiveId = parsed.searchParams.get("objective") || undefined;
  const inspectorTab = parsed.searchParams.get("inspectorTab") || "overview";
  const focusKind = parsed.searchParams.get("focusKind");
  const focusId = parsed.searchParams.get("focusId");
  const filter = parsed.searchParams.get("filter") || "objective.running";
  const chatEvents = new URLSearchParams();
  chatEvents.set("profile", profileId);
  if (chatId) chatEvents.set("chat", chatId);
  if (objectiveId) chatEvents.set("objective", objectiveId);
  if (focusKind === "job" && focusId) chatEvents.set("job", focusId);
  return {
    pageTitle: "Receipt Factory Workbench",
    routeKey: `/factory${search}`,
    ...(input.location ? { location: input.location } : {}),
    route: {
      profileId,
      chatId,
      ...(objectiveId ? { objectiveId } : {}),
      ...(inspectorTab !== "overview" ? { inspectorTab } : {}),
      ...(focusKind === "task" || focusKind === "job" ? { focusKind } : {}),
      ...(focusId ? { focusId } : {}),
      filter,
    },
    backgroundEventsPath: `/factory/background/events${search}`,
    chatEventsPath: `/factory/chat/events?${chatEvents.toString()}`,
    workbenchHeaderPath: workbenchHeaderPath(search),
    workbenchIslandPath: `/factory/island/workbench${search}`,
    chatIslandPath: `/factory/island/chat${search}`,
    workbenchHeaderHtml: `<div>${profileLabel}</div>`,
    chatHeaderHtml: `<span>${profileLabel}</span>`,
    workbenchHtml: input.workbenchHtml ?? workbenchPanelMarkup(search, objectiveId),
    chatHtml: input.chatHtml ?? chatMarkup({ profileLabel, chatId: chatId || undefined, objectiveId }),
    composeAction: `/factory/compose${search}`,
    composerPlaceholder: input.placeholder ?? "",
    streamingLabel: profileLabel,
  };
};

const stripHtml = (value: string): string =>
  value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

const extractElementMarkup = (markup: string, id: string): { readonly tag: string; readonly attrs: string; readonly inner: string } | null => {
  const pattern = new RegExp(`<([a-zA-Z0-9-]+)([^>]*)id="${id}"([^>]*)>([\\s\\S]*?)</\\1>`);
  const match = markup.match(pattern);
  if (!match || !match[1]) return null;
  return {
    tag: match[1].toUpperCase(),
    attrs: `${match[2] ?? ""} id="${id}"${match[3] ?? ""}`,
    inner: match[4] ?? "",
  };
};

const buildParsedDocument = (markup: string) => {
  const elements = new Map<string, MockElement>();
  const body = new MockElement("BODY");
  const bodyMatch = markup.match(/<body([^>]*)>/);
  for (const attr of (bodyMatch?.[1] ?? "").matchAll(/([a-zA-Z0-9:-]+)="([^"]*)"/g)) {
    if (!attr[1]) continue;
    body.setAttribute(attr[1], attr[2] ?? "");
  }
  const ids = [
    "factory-prompt",
    "factory-composer",
    "factory-composer-current-job",
    "factory-chat",
    "factory-chat-streaming",
    "factory-chat-streaming-label-text",
    "factory-chat-streaming-content",
    "factory-chat-stream-reset-listener",
    "factory-workbench-background-root",
    "factory-workbench-header",
    "factory-workbench-panel",
    "factory-workbench-rail-scroll",
    "factory-workbench-focus-scroll",
    "factory-workbench-block-summary",
    "factory-workbench-block-activity",
    "factory-workbench-block-objectives",
    "factory-workbench-block-history",
    "factory-workbench-chat-header",
    "factory-workbench-chat-root",
    "factory-workbench-chat-scroll",
    "factory-workbench-chat",
    "factory-chat-live",
  ];
  for (const id of ids) {
    const extracted = extractElementMarkup(markup, id);
    if (!extracted) continue;
    const element = new MockElement(extracted.tag);
    element.id = id;
    for (const attr of extracted.attrs.matchAll(/([a-zA-Z0-9:-]+)="([^"]*)"/g)) {
      if (!attr[1] || attr[1] === "id") continue;
      element.setAttribute(attr[1], attr[2] ?? "");
    }
    element.innerHTML = extracted.inner;
    element.textContent = stripHtml(extracted.inner);
    elements.set(id, element);
  }
  return {
    title: /<title>([^<]*)<\/title>/.exec(markup)?.[1] ?? "",
    body,
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => {
      if (selector === '[data-preserve-scroll-key="rail"]') return elements.get("factory-workbench-rail-scroll") ?? null;
      if (selector === '[data-preserve-scroll-key="focus"]') return elements.get("factory-workbench-focus-scroll") ?? null;
      return null;
    },
  };
};

const splitTriggerList = (value: string | null): ReadonlyArray<string> =>
  String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

const sseTriggerEvents = (value: string | null): ReadonlyArray<string> =>
  splitTriggerList(value).flatMap((part) => {
    const match = part.match(/^sse:([a-z0-9:-]+)/i);
    return match && match[1] ? [match[1]] : [];
  });

const bodyTriggerEvents = (value: string | null): ReadonlyArray<string> =>
  splitTriggerList(value).flatMap((part) => {
    if (/^sse:/i.test(part)) return [];
    const match = part.match(/^([a-z0-9:-]+)\s+from:body\b/i);
    return match && match[1] ? [match[1]] : [];
  });

const createWorkbenchHarness = async (options: {
  readonly initialLocation?: string;
  readonly sessionStorageState?: Record<string, string>;
  readonly beforeBoot?: (input: {
    readonly body: MockElement;
    readonly workbenchHeader: MockElement;
    readonly workbenchPanel: MockElement;
    readonly workbenchRailShell: MockElement;
    readonly workbenchRailScroll: MockElement;
    readonly workbenchFocusShell: MockElement;
    readonly workbenchFocusScroll: MockElement;
    readonly workbenchSummary: MockElement;
    readonly workbenchActivity: MockElement;
    readonly workbenchObjectives: MockElement;
    readonly workbenchHistory: MockElement;
    readonly chatRegion: MockElement;
    readonly chatBody: MockElement;
    readonly chat: MockElement;
  }) => void;
  readonly fetchImpl?: (url: string, init: { readonly body?: FormData; readonly signal?: AbortSignal }) => Promise<{
    readonly ok: boolean;
    readonly headers: { readonly get: (name: string) => string | null };
    readonly json: () => Promise<unknown>;
    readonly text: () => Promise<string>;
  }>;
} = {}) => {
  MockEventSource.instances.length = 0;

  const textarea = new MockTextArea();
  textarea.id = "factory-prompt";
  textarea.value = "/";

  const workbenchPanel = new MockElement("DIV");
  workbenchPanel.id = "factory-workbench-panel";

  const workbenchHeader = new MockElement("DIV");
  workbenchHeader.id = "factory-workbench-header";

  const backgroundRoot = new MockElement("DIV");
  backgroundRoot.id = "factory-workbench-background-root";

  const workbenchRailScroll = new MockElement("SECTION");
  workbenchRailScroll.id = "factory-workbench-rail-scroll";
  workbenchRailScroll.setAttribute("data-preserve-scroll-key", "rail");
  workbenchRailScroll.scrollHeight = 1080;
  workbenchRailScroll.clientHeight = 360;

  const workbenchRailShell = new MockElement("SECTION");
  workbenchRailShell.id = "factory-workbench-rail-shell";

  const workbenchFocusScroll = new MockElement("SECTION");
  workbenchFocusScroll.id = "factory-workbench-focus-scroll";
  workbenchFocusScroll.setAttribute("data-preserve-scroll-key", "focus");
  workbenchFocusScroll.scrollHeight = 1240;
  workbenchFocusScroll.clientHeight = 420;

  const workbenchFocusShell = new MockElement("SECTION");
  workbenchFocusShell.id = "factory-workbench-focus-shell";

  const workbenchSummary = new MockElement("DIV");
  workbenchSummary.id = "factory-workbench-block-summary";

  const workbenchActivity = new MockElement("DIV");
  workbenchActivity.id = "factory-workbench-block-activity";

  const workbenchObjectives = new MockElement("DIV");
  workbenchObjectives.id = "factory-workbench-block-objectives";

  const workbenchHistory = new MockElement("DIV");
  workbenchHistory.id = "factory-workbench-block-history";

  const workbenchChatHeader = new MockElement("DIV");
  workbenchChatHeader.id = "factory-workbench-chat-header";

  const chatPane = new MockElement("ASIDE");
  chatPane.id = "factory-workbench-chat-pane";

  const chatRegion = new MockElement("DIV");
  chatRegion.id = "factory-workbench-chat-region";

  const chatBody = new MockElement("DIV");
  chatBody.id = "factory-workbench-chat-body";

  const chatRoot = new MockElement("DIV");
  chatRoot.id = "factory-workbench-chat-root";

  const scroll = new MockElement("DIV");
  scroll.id = "factory-workbench-chat-scroll";
  scroll.scrollHeight = 640;
  scroll.clientHeight = 320;

  const chat = new MockElement("DIV");
  chat.id = "factory-workbench-chat";
  chat.innerHTML = chatMarkup({ chatId: "chat_demo" });

  const chatLive = new MockElement("DIV");
  chatLive.id = "factory-chat-live";

  const streamingShell = new MockElement("DIV");
  streamingShell.id = "factory-chat-streaming";

  const streamingCard = new MockElement("SECTION");
  streamingCard.id = "factory-chat-stream-shell";
  streamingCard.setAttribute("data-factory-stream-shell", "true");
  streamingCard.setAttribute("data-stream-state", "idle");

  const streamingLabel = new MockElement("SPAN");
  streamingLabel.id = "factory-chat-streaming-label-text";
  streamingLabel.textContent = "Generalist";

  const streamingStatus = new MockElement("SPAN");
  streamingStatus.id = "factory-chat-streaming-status";
  streamingStatus.textContent = "Streaming";

  const streamingLoader = new MockElement("DIV");
  streamingLoader.id = "factory-chat-streaming-loader";
  streamingLoader.classList.add("hidden");

  const streamingLoaderLabel = new MockElement("SPAN");
  streamingLoaderLabel.id = "factory-chat-streaming-loader-label";
  streamingLoaderLabel.textContent = "Sending";

  const streaming = new MockElement("DIV");
  streaming.id = "factory-chat-streaming-content";
  streaming.setAttribute("sse-swap", "factory-stream-token");
  streaming.setAttribute("hx-swap", "beforeend");

  const streamingReset = new MockElement("DIV");
  streamingReset.id = "factory-chat-stream-reset-listener";
  streamingReset.setAttribute("sse-swap", "factory-stream-reset");
  streamingReset.setAttribute("hx-swap", "none");

  const optimistic = new MockElement("DIV");
  optimistic.id = "factory-chat-optimistic";

  const popup = new MockElement("DIV");
  popup.id = "factory-composer-completions";
  popup.classList.add("hidden");

  const status = new MockElement("DIV");
  status.id = "factory-composer-status";

  const submit = new MockButton();
  submit.id = "factory-composer-submit";
  submit.textContent = "Send";

  const currentJob = new MockInput();
  currentJob.id = "factory-composer-current-job";
  currentJob.value = "";

  const form = new MockForm();
  form.id = "factory-composer";
  form.setAttribute("data-composer-commands", COMMANDS);

  const elements = new Map<string, MockElement>([
    [workbenchPanel.id, workbenchPanel],
    [workbenchHeader.id, workbenchHeader],
    [backgroundRoot.id, backgroundRoot],
    [workbenchRailShell.id, workbenchRailShell],
    [workbenchRailScroll.id, workbenchRailScroll],
    [workbenchFocusShell.id, workbenchFocusShell],
    [workbenchFocusScroll.id, workbenchFocusScroll],
    [workbenchSummary.id, workbenchSummary],
    [workbenchActivity.id, workbenchActivity],
    [workbenchObjectives.id, workbenchObjectives],
    [workbenchHistory.id, workbenchHistory],
    [chatPane.id, chatPane],
    [chatRegion.id, chatRegion],
    [chatBody.id, chatBody],
    [workbenchChatHeader.id, workbenchChatHeader],
    [chatRoot.id, chatRoot],
    [scroll.id, scroll],
    [chat.id, chat],
    [chatLive.id, chatLive],
    [streamingShell.id, streamingShell],
    [streamingCard.id, streamingCard],
    [streamingLabel.id, streamingLabel],
    [streamingStatus.id, streamingStatus],
    [streamingLoader.id, streamingLoader],
    [streamingLoaderLabel.id, streamingLoaderLabel],
    [streaming.id, streaming],
    [streamingReset.id, streamingReset],
    [optimistic.id, optimistic],
    [textarea.id, textarea],
    [popup.id, popup],
    [status.id, status],
    [submit.id, submit],
    [currentJob.id, currentJob],
    [form.id, form],
  ]);

  const body = new MockElement("BODY");
  body.setAttribute("data-factory-workbench", "true");
  const initialLocation = new URL(options.initialLocation ?? "http://receipt.test/factory?profile=generalist&chat=chat_demo");
  body.setAttribute("data-route-key", `/factory${initialLocation.search}`);
  body.setAttribute("data-chat-id", initialLocation.searchParams.get("chat") || "");
  body.setAttribute("data-objective-id", initialLocation.searchParams.get("objective") || "");
  body.setAttribute("data-inspector-tab", initialLocation.searchParams.get("inspectorTab") || "overview");
  body.setAttribute("data-focus-kind", initialLocation.searchParams.get("focusKind") || "");
  body.setAttribute("data-focus-id", initialLocation.searchParams.get("focusId") || "");
  const initialInspectorTab = initialLocation.searchParams.get("inspectorTab") || "overview";
  backgroundRoot.setAttribute("data-events-path", `/factory/background/events${initialLocation.search}`);
  workbenchHeader.setAttribute("data-refresh-path", workbenchHeaderPath(initialLocation.search));
  workbenchHeader.setAttribute("data-refresh-on", WORKBENCH_HEADER_DESCRIPTOR);
  workbenchPanel.setAttribute("data-refresh-path", `/factory/island/workbench${initialLocation.search}`);
  workbenchPanel.setAttribute("data-refresh-on", WORKBENCH_BACKGROUND_DESCRIPTOR);
  workbenchRailShell.setAttribute("data-refresh-path", `/factory/island/workbench/rail${initialLocation.search}`);
  workbenchRailShell.setAttribute("data-refresh-on", WORKBENCH_RAIL_DESCRIPTOR);
  workbenchRailShell.setAttribute("hx-swap", "outerHTML");
  workbenchFocusShell.setAttribute("data-refresh-path", `/factory/island/workbench/focus${initialLocation.search}`);
  workbenchFocusShell.setAttribute("data-refresh-on", WORKBENCH_SUMMARY_DESCRIPTOR);
  workbenchFocusShell.setAttribute("hx-swap", "outerHTML");
  workbenchSummary.setAttribute("data-refresh-path", workbenchBlockPath(initialLocation.search, "summary"));
  workbenchActivity.setAttribute("data-refresh-path", workbenchBlockPath(initialLocation.search, "activity"));
  workbenchObjectives.setAttribute("data-refresh-path", workbenchBlockPath(initialLocation.search, "objectives"));
  workbenchHistory.setAttribute("data-refresh-path", workbenchBlockPath(initialLocation.search, "history"));
  const chatEvents = new URLSearchParams();
  chatEvents.set("profile", initialLocation.searchParams.get("profile") || "generalist");
  if (initialLocation.searchParams.get("chat")) chatEvents.set("chat", initialLocation.searchParams.get("chat")!);
  if (initialLocation.searchParams.get("objective")) chatEvents.set("objective", initialLocation.searchParams.get("objective")!);
  if (initialLocation.searchParams.get("focusKind") === "job" && initialLocation.searchParams.get("focusId")) {
    chatEvents.set("job", initialLocation.searchParams.get("focusId")!);
  }
  chatRoot.setAttribute("data-events-path", `/factory/chat/events?${chatEvents.toString()}`);
  chatRegion.setAttribute("data-refresh-path", `/factory/island/workbench/chat-shell${initialLocation.search}`);
  chatBody.setAttribute("data-refresh-path", `/factory/island/workbench/chat-body${initialLocation.search}`);
  chatBody.setAttribute(
    "data-refresh-on",
    workbenchChatDescriptor(initialInspectorTab, initialLocation.searchParams.get("objective") || undefined),
  );
  chatBody.setAttribute("hx-swap", "outerHTML");
  workbenchChatHeader.setAttribute("data-refresh-path", `/factory/island/chat/header${initialLocation.search}`);
  chat.setAttribute("data-refresh-path", `/factory/island/chat${initialLocation.search}`);
  form.action = "/factory/compose" + initialLocation.search;
  options.beforeBoot?.({
    body,
    workbenchHeader,
    workbenchPanel,
    workbenchRailShell,
    workbenchRailScroll,
    workbenchFocusShell,
    workbenchFocusScroll,
    workbenchSummary,
    workbenchActivity,
    workbenchObjectives,
    workbenchHistory,
    chatRegion,
    chatBody,
    chat,
  });

  const documentListeners = new Map<string, Array<Listener>>();
  const document = {
    readyState: "complete",
    body,
    scrollingElement: body,
    activeElement: undefined as unknown,
    title: "Receipt Factory Workbench",
    addEventListener: (type: string, handler: Listener) => {
      const handlers = documentListeners.get(type) ?? [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
      if (type === "DOMContentLoaded") handler(new MockEvent({ type: "DOMContentLoaded" }));
    },
    dispatchEvent: (event: MockEvent) => {
      for (const handler of documentListeners.get(event.type) ?? []) handler(event);
    },
    querySelector: (selector: string) => {
      if (selector === "[data-factory-workbench]") return body;
      if (selector === '[data-preserve-scroll-key="rail"]') return workbenchRailScroll;
      if (selector === '[data-preserve-scroll-key="focus"]') return workbenchFocusScroll;
      return null;
    },
    getElementById: (id: string) => elements.get(id) ?? null,
  };

  const fetchCalls: Array<{ readonly url: string; readonly body: FormData | undefined }> = [];
  const locationState = {
    assigned: [] as string[],
    reloads: 0,
    href: initialLocation.href,
    origin: initialLocation.origin,
    pathname: initialLocation.pathname,
    search: initialLocation.search,
    hash: initialLocation.hash,
    assign(url: string) {
      this.assigned.push(url);
      const next = new URL(url, this.href);
      this.href = next.href;
      this.pathname = next.pathname;
      this.search = next.search;
      this.hash = next.hash;
    },
    reload() { this.reloads += 1; },
  };
  const historyState = {
    pushed: [] as string[],
    replaced: [] as string[],
    pushState(_state: unknown, _title: string, url: string) {
      this.pushed.push(url);
      const next = new URL(url, locationState.href);
      locationState.href = next.href;
      locationState.pathname = next.pathname;
      locationState.search = next.search;
      locationState.hash = next.hash;
    },
    replaceState(_state: unknown, _title: string, url: string) {
      this.replaced.push(url);
      const next = new URL(url, locationState.href);
      locationState.href = next.href;
      locationState.pathname = next.pathname;
      locationState.search = next.search;
      locationState.hash = next.hash;
    },
  };
  const windowListeners = new Map<string, Array<Listener>>();
  const sessionStorageState = new Map<string, string>(Object.entries(options.sessionStorageState ?? {}));
  const dispatchAfterSwap = (target: MockElement) => {
    document.dispatchEvent(new MockEvent({ type: "htmx:afterSwap", target }));
  };
  const performSwap = (target: MockElement, markup: string) => {
    const mode = target.getAttribute("hx-swap") || "innerHTML";
    if (mode === "beforeend") target.innerHTML = `${target.innerHTML}${markup}`;
    else if (mode !== "none") target.innerHTML = markup;
    dispatchAfterSwap(target);
  };
  const refreshElement = async (target: MockElement) => {
    const url = target.getAttribute("hx-get");
    if (!url) return;
    const fetchFn = sandbox.fetch as (url: string, init: { readonly body?: FormData; readonly signal?: AbortSignal }) => Promise<{
      readonly ok: boolean;
      readonly text: () => Promise<string>;
    }>;
    const response = await fetchFn(url, {});
    if (!response.ok) throw new Error("Request failed.");
    const markup = await response.text();
    performSwap(target, markup);
  };
  const processedBodyTriggers = new Set<string>();
  const htmx = {
    process: (root: Element) => {
      if (!(root instanceof MockElement)) return;
      const candidates = Array.from(elements.values()).filter((element) =>
        root === body || root === element || root.contains(element),
      );
      for (const candidate of candidates) {
        const refreshPath = candidate.getAttribute("data-refresh-path");
        if (refreshPath && candidate.getAttribute("hx-get") === null) {
          candidate.setAttribute("hx-get", refreshPath);
        }
        const descriptor = candidate.getAttribute("data-refresh-on");
        if (candidate.getAttribute("hx-trigger") === null && descriptor) {
          const hxTrigger = splitTriggerList(descriptor).flatMap((part) => {
            const bodyMatch = part.match(/^body:([^@]+)(?:@(\d+))?$/i);
            if (bodyMatch && bodyMatch[1]) {
              return [`${bodyMatch[1]} from:body`];
            }
            const sseMatch = part.match(/^sse:([^@]+)(?:@(\d+))?$/i);
            if (sseMatch && sseMatch[1]) {
              return [`sse:${sseMatch[1]}`];
            }
            return [];
          }).join(", ");
          if (hxTrigger) candidate.setAttribute("hx-trigger", hxTrigger);
        }
        for (const eventName of bodyTriggerEvents(candidate.getAttribute("hx-trigger"))) {
          const key = `${candidate.id}:${eventName}`;
          if (processedBodyTriggers.has(key)) continue;
          processedBodyTriggers.add(key);
          body.addEventListener(eventName, () => {
            void refreshElement(candidate);
          });
        }
      }
    },
  };
  const sandbox = {
    document,
    window: undefined as unknown,
    HTMLTextAreaElement: MockTextArea,
    HTMLFormElement: MockForm,
    HTMLButtonElement: MockButton,
    HTMLInputElement: MockInput,
    HTMLSelectElement: MockSelect,
    HTMLElement: MockElement,
    Element: MockElement,
    Node: MockElement,
    URL,
    URLSearchParams,
    AbortController,
    EventSource: MockEventSource,
    DOMParser: class {
      parseFromString(markup: string) {
        return buildParsedDocument(markup);
      }
    },
    CustomEvent: class { constructor(public readonly type: string, public readonly detail?: unknown) {} },
    Event: class extends MockEvent { constructor(type: string, init: Partial<MockEvent> = {}) { super({ ...init, type }); } },
    FormData: class {
      constructor(public readonly form: MockForm) {}
    },
    fetch: async (url: string, init: { readonly body?: FormData; readonly signal?: AbortSignal }) => {
      fetchCalls.push({ url, body: init.body });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      if (url.indexOf("/factory/compose") >= 0) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({ location: "/factory?profile=generalist&chat=chat_demo" }),
          text: async () => "",
        };
      }
      const parsed = new URL(url, initialLocation.origin);
      if (parsed.pathname === "/factory/island/chat") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || undefined,
            objectiveId: parsed.searchParams.get("objective") || undefined,
          }),
        };
      }
      if (parsed.pathname === "/factory/island/workbench/header") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div>Header ${parsed.searchParams.get("profile") || "generalist"}</div>`,
        };
      }
      if (parsed.pathname === "/factory/island/chat/header") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div>${parsed.searchParams.get("profile") || "generalist"} chat header</div>`,
        };
      }
      if (parsed.pathname === "/factory/island/workbench/block") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div>${parsed.searchParams.get("block") || "summary"} refreshed</div>`,
        };
      }
      if (parsed.pathname === "/factory/island/workbench/rail") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<section id="factory-workbench-rail-shell" data-refresh-path="/factory/island/workbench/rail${parsed.search}" data-refresh-on="${WORKBENCH_RAIL_DESCRIPTOR}">
            <section id="factory-workbench-rail-scroll" data-preserve-scroll-key="rail"><div>rail refreshed</div></section>
          </section>`,
        };
      }
      if (parsed.pathname === "/factory/island/workbench/focus") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<section id="factory-workbench-focus-shell" data-refresh-path="/factory/island/workbench/focus${parsed.search}" data-refresh-on="${WORKBENCH_SUMMARY_DESCRIPTOR}">
            <section id="factory-workbench-focus-scroll" data-preserve-scroll-key="focus"><div>focus refreshed</div></section>
          </section>`,
        };
      }
      if (parsed.pathname === "/factory/island/workbench/chat-shell") {
        const profileLabel = "Generalist";
        const chatId = parsed.searchParams.get("chat") || undefined;
        const objectiveId = parsed.searchParams.get("objective") || undefined;
        const inspectorTab = parsed.searchParams.get("inspectorTab") || "overview";
        const chatEvents = new URLSearchParams();
        chatEvents.set("profile", parsed.searchParams.get("profile") || "generalist");
        if (chatId) chatEvents.set("chat", chatId);
        if (objectiveId) chatEvents.set("objective", objectiveId);
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div id="factory-workbench-chat-region" data-refresh-path="/factory/island/workbench/chat-shell${parsed.search}">
            <div id="factory-workbench-chat-header" data-refresh-path="/factory/island/chat/header${parsed.search}"><span>${profileLabel}</span></div>
            <div id="factory-workbench-chat-body" data-refresh-path="/factory/island/workbench/chat-body${parsed.search}" data-refresh-on="${workbenchChatDescriptor(inspectorTab, objectiveId)}">
              <div id="factory-workbench-chat-root" data-events-path="/factory/chat/events?${chatEvents.toString()}">
                <div id="factory-workbench-chat-scroll">
                  <div id="factory-workbench-chat" data-refresh-path="/factory/island/chat${parsed.search}">${chatMarkup({ profileLabel, chatId, objectiveId })}</div>
                  <div id="factory-chat-live">
                    <div id="factory-chat-streaming">
                      <section id="factory-chat-stream-shell" data-factory-stream-shell data-stream-state="idle">
                        <span id="factory-chat-streaming-label-text">${profileLabel}</span>
                        <span id="factory-chat-streaming-status">Streaming</span>
                        <div id="factory-chat-streaming-loader" class="hidden"><span id="factory-chat-streaming-loader-label">Sending</span></div>
                        <div id="factory-chat-streaming-content"></div>
                      </section>
                    </div>
                    <div id="factory-chat-stream-reset-listener"></div>
                    <div id="factory-chat-optimistic"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>`,
        };
      }
      if (parsed.pathname === "/factory/island/workbench/chat-body") {
        const profileLabel = "Generalist";
        const chatId = parsed.searchParams.get("chat") || undefined;
        const objectiveId = parsed.searchParams.get("objective") || undefined;
        const inspectorTab = parsed.searchParams.get("inspectorTab") || "overview";
        const chatEvents = new URLSearchParams();
        chatEvents.set("profile", parsed.searchParams.get("profile") || "generalist");
        if (chatId) chatEvents.set("chat", chatId);
        if (objectiveId) chatEvents.set("objective", objectiveId);
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div id="factory-workbench-chat-body" data-refresh-path="/factory/island/workbench/chat-body${parsed.search}" data-refresh-on="${workbenchChatDescriptor(inspectorTab, objectiveId)}">
            <div id="factory-workbench-chat-root" data-events-path="/factory/chat/events?${chatEvents.toString()}">
              <div id="factory-workbench-chat-scroll">
                <div id="factory-workbench-chat" data-refresh-path="/factory/island/chat${parsed.search}">${chatMarkup({ profileLabel, chatId, objectiveId })}</div>
                <div id="factory-chat-live">
                  <div id="factory-chat-streaming">
                    <section id="factory-chat-stream-shell" data-factory-stream-shell data-stream-state="idle">
                      <span id="factory-chat-streaming-label-text">${profileLabel}</span>
                      <span id="factory-chat-streaming-status">Streaming</span>
                      <div id="factory-chat-streaming-loader" class="hidden"><span id="factory-chat-streaming-loader-label">Sending</span></div>
                      <div id="factory-chat-streaming-content"></div>
                    </section>
                  </div>
                  <div id="factory-chat-stream-reset-listener"></div>
                  <div id="factory-chat-optimistic"></div>
                </div>
              </div>
            </div>
          </div>`,
        };
      }
      if (parsed.pathname === "/factory/island/workbench") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => workbenchPanelMarkup(parsed.search || "?profile=generalist&chat=chat_demo", parsed.searchParams.get("objective") || undefined, "workbench refreshed"),
        };
      }
      if (parsed.pathname === "/factory/api/workbench-shell") {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => workbenchShellSnapshot({
            search: parsed.search || "?profile=generalist&chat=chat_demo",
            chatHtml: chatMarkup({
              profileLabel: "Generalist",
              chatId: parsed.searchParams.get("chat") || undefined,
              objectiveId: parsed.searchParams.get("objective") || undefined,
            }),
            workbenchHtml: workbenchPanelMarkup(parsed.search || "?profile=generalist&chat=chat_demo", parsed.searchParams.get("objective") || undefined),
          }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => workbenchShellMarkup({
          search: parsed.search || "?profile=generalist&chat=chat_demo",
          chatHtml: chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || undefined,
            objectiveId: parsed.searchParams.get("objective") || undefined,
          }),
          workbenchHtml: workbenchPanelMarkup(parsed.search || "?profile=generalist&chat=chat_demo", parsed.searchParams.get("objective") || undefined),
        }),
      };
    },
    requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout,
    clearTimeout,
    sessionStorage: {
      getItem: (key: string) => sessionStorageState.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionStorageState.set(key, value); },
      removeItem: (key: string) => { sessionStorageState.delete(key); },
    },
    history: historyState,
    location: locationState,
    htmx,
    addEventListener: (type: string, handler: Listener) => {
      const handlers = windowListeners.get(type) ?? [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
  } as Record<string, unknown>;
  (globalThis as { __mockDocument?: unknown }).__mockDocument = document;
  sandbox.window = sandbox;
  vm.runInNewContext(await loadClient(), sandbox);
  const latestSourceFor = (fragment: string) =>
    [...MockEventSource.instances].reverse().find((source) => !source.closed && source.url.indexOf(fragment) >= 0) ?? null;
  return {
    document,
    textarea,
    optimistic,
    status,
    submit,
    form,
    scroll,
    workbenchPanel,
    workbenchRailScroll,
    workbenchFocusScroll,
    chat,
    streaming,
    streamingShell: streamingCard,
    streamingLoader,
    streamingStatus,
    fetchCalls,
    locationState,
    historyState,
    sessionStorageState,
    backgroundSource: () => latestSourceFor("/factory/background/events"),
    chatSource: () => latestSourceFor("/factory/chat/events"),
    dispatchWindowEvent: (type: string) => {
      for (const handler of windowListeners.get(type) ?? []) handler(new MockEvent({ type }));
    },
  };
};

test("factory workbench client: profile-board and objective-runtime events refresh only the matching workbench islands", async () => {
  const { document, backgroundSource, chatSource, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  document.body.scrollTop = 220;

  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action");
  expect(chatSource()).toBeNull();

  backgroundSource()?.emit("profile-board-refresh", "generalist");
  await flushAsync(380);

  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/rail?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/focus?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/chat-body?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(1);
  expect(document.body.scrollTop).toBe(220);

  backgroundSource()?.emit("objective-runtime-refresh", "objective_demo");
  await flushAsync(380);

  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/rail?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/focus?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(2);
  expect(document.body.scrollTop).toBe(220);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/chat-body?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(2);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(0);
});

test("factory workbench client: SSE refresh routing follows data-refresh-on declarations", async () => {
  const { backgroundSource, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
    beforeBoot: ({
      workbenchHeader,
      workbenchPanel,
      workbenchFocusShell,
      workbenchRailShell,
      chatBody,
    }) => {
      workbenchHeader.setAttribute("data-refresh-on", "");
      workbenchPanel.setAttribute("data-refresh-on", "");
      workbenchFocusShell.setAttribute("data-refresh-on", "body:summary-only@0");
      workbenchRailShell.setAttribute("data-refresh-on", "");
      chatBody.setAttribute("data-refresh-on", "");
    },
  });

  backgroundSource()?.emit("summary-only", "objective_demo");
  await flushAsync();

  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/focus?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/rail?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/chat-shell?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action")).toHaveLength(0);
});

test("factory workbench client: objective navigation updates background scope without rewriting the chat stream", async () => {
  const { document, historyState, locationState, fetchCalls, backgroundSource, chatSource } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_a",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_b");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action"]);
  expect(historyState.replaced).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action");
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat/header?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action")).toBe(true);
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action");
  expect(chatSource()).toBeNull();
});

test("factory workbench client: page-only navigation preserves the requested pagination state", async () => {
  const { document, historyState, locationState, fetchCalls, backgroundSource } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&page=2");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&page=2"]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&page=2");
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&page=2")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&page=2")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat/header?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&page=2")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&page=2")).toBe(true);
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&page=2");
});

test("factory workbench client: profile dropdown updates the page route and stream bindings together", async () => {
  const { document, historyState, locationState, fetchCalls, backgroundSource, chatSource } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  const select = new MockSelect();
  select.setAttribute("data-factory-profile-select", "true");
  select.value = "/factory?profile=software&chat=chat_demo";

  document.dispatchEvent(new MockEvent({ type: "change", target: select }));
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=software&chat=chat_demo&detailTab=action"]);
  expect(historyState.replaced).toEqual([]);
  expect(locationState.pathname).toBe("/factory");
  expect(locationState.search).toBe("?profile=software&chat=chat_demo&detailTab=action");
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench/header?profile=software&chat=chat_demo&detailTab=action")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=software&chat=chat_demo&detailTab=action")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat/header?profile=software&chat=chat_demo&detailTab=action")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=software&chat=chat_demo&detailTab=action")).toBe(true);
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=software&chat=chat_demo&detailTab=action");
  expect(chatSource()).toBeNull();
});

test("factory workbench client: chat events stream tokens and refresh the transcript", async () => {
  let chatRefreshes = 0;
  const { chatSource, streaming, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&inspectorTab=chat",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      if (parsed.pathname === "/factory/island/workbench/chat-body") {
        chatRefreshes += 1;
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div id="factory-workbench-chat-body" data-refresh-path="/factory/island/workbench/chat-body${parsed.search}" data-refresh-on="${WORKBENCH_CHAT_DESCRIPTOR}">
            <div id="factory-workbench-chat-root" data-events-path="/factory/chat/events?profile=generalist&chat=chat_demo">
              <div id="factory-workbench-chat-scroll">
                <div id="factory-workbench-chat" data-refresh-path="/factory/island/chat${parsed.search}">${chatMarkup({
                  profileLabel: "Generalist",
                  chatId: "chat_demo",
                  activeRunId: chatRefreshes === 1 ? "run_demo" : undefined,
                  knownRunIds: chatRefreshes === 1 ? ["run_demo"] : [],
                  terminalRunIds: chatRefreshes > 1 ? ["run_demo"] : [],
                })}</div>
                <div id="factory-chat-live">
                  <div id="factory-chat-streaming">
                    <section id="factory-chat-stream-shell" data-factory-stream-shell data-stream-state="idle">
                      <span id="factory-chat-streaming-label-text">Generalist</span>
                      <span id="factory-chat-streaming-status">Streaming</span>
                      <div id="factory-chat-streaming-loader" class="hidden"><span id="factory-chat-streaming-loader-label">Sending</span></div>
                      <div id="factory-chat-streaming-content"></div>
                    </section>
                  </div>
                  <div id="factory-chat-stream-reset-listener"></div>
                  <div id="factory-chat-optimistic"></div>
                </div>
              </div>
            </div>
          </div>`,
        };
      }
      if (parsed.pathname === "/factory/island/workbench") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => "<div>workbench refreshed</div>",
        };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => workbenchShellSnapshot({
          search: parsed.search || "?profile=generalist&chat=chat_demo",
        }),
        text: async () => "",
      };
    },
  });

  chatSource()?.emit("agent-token", JSON.stringify({ runId: "run_demo", delta: "Hello from Factory." }));
  await flushAsync();
  expect(stripHtml(streaming.innerHTML)).toContain("Hello from Factory.");

  chatSource()?.emit("job-refresh", "job_demo");
  await flushAsync(260);

  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench/chat-body?profile=generalist&chat=chat_demo&inspectorTab=chat&detailTab=action")).toBe(true);
  expect(chatRefreshes).toBeGreaterThan(0);
});

test("factory workbench client: live chat refresh preserves composer text", async () => {
  const { chatSource, textarea, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat",
  });

  textarea.value = "Do not wipe this draft.";
  textarea.selectionStart = textarea.value.length;

  chatSource()?.emit("agent-refresh", "run_demo");
  await flushAsync(220);

  expect(textarea.value).toBe("Do not wipe this draft.");
  expect(fetchCalls.some((call) => call.url.includes("/factory/island/workbench/chat-body?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat"))).toBe(true);
  expect(fetchCalls.some((call) => call.url.includes("/factory/island/workbench/chat-shell?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat"))).toBe(false);
});

test("factory workbench client: pressing Enter submits while Shift+Enter does not", async () => {
  const { textarea, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&inspectorTab=chat",
  });

  textarea.value = "Send with enter";
  textarea.selectionStart = textarea.value.length;
  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "Enter", shiftKey: true, target: textarea }));
  await flushAsync();
  expect(fetchCalls.some((call) => call.url.startsWith("/factory/compose?profile=generalist&chat=chat_demo&inspectorTab=chat"))).toBe(false);

  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "Enter", shiftKey: false, target: textarea }));
  await flushAsync();
  expect(fetchCalls.some((call) => call.url.startsWith("/factory/compose?profile=generalist&chat=chat_demo&inspectorTab=chat"))).toBe(true);
});

test("factory workbench client: selected objectives ignore token streams from unrelated runs", async () => {
  const { chatSource, streaming } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat",
    beforeBoot: ({ chat }) => {
      chat.innerHTML = chatMarkup({
        profileLabel: "Generalist",
        chatId: "chat_demo",
        objectiveId: "objective_demo",
        activeRunId: "run_demo",
        knownRunIds: ["run_demo"],
      });
    },
  });

  chatSource()?.emit("agent-token", JSON.stringify({ runId: "run_other_objective", delta: "Wrong objective token" }));
  await flushAsync();
  expect(stripHtml(streaming.innerHTML)).not.toContain("Wrong objective token");

  chatSource()?.emit("agent-token", JSON.stringify({ runId: "run_demo", delta: "Current objective token" }));
  await flushAsync();
  expect(stripHtml(streaming.innerHTML)).toContain("Current objective token");
});

test("factory workbench client: plain prompts stay chat-first and /obj selects the created objective", async () => {
  let composeCount = 0;
  let chatBodyRefreshes = 0;
  const {
    document,
    textarea,
    form,
    optimistic,
    status,
    historyState,
    locationState,
    backgroundSource,
    chatSource,
    fetchCalls,
    streaming,
    streamingShell,
    streamingLoader,
    streamingStatus,
  } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&inspectorTab=chat",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      if (parsed.pathname === "/factory/compose") {
        composeCount += 1;
        if (composeCount === 1) {
          return {
            ok: true,
            headers: { get: () => "application/json" },
            json: async () => ({
              location: "/factory?profile=generalist&chat=chat_demo&inspectorTab=chat",
              live: {
                profileId: "generalist",
                chatId: "chat_demo",
                runId: "run_demo",
                jobId: "job_demo",
              },
              chat: { chatId: "chat_demo" },
            }),
            text: async () => "",
          };
        }
          return {
            ok: true,
            headers: { get: () => "application/json" },
            json: async () => ({
              location: "/factory?profile=generalist&chat=chat_demo&objective=objective_created&inspectorTab=chat",
              chat: { chatId: "chat_demo" },
              selection: { objectiveId: "objective_created" },
        }),
          text: async () => "",
        };
      }
      if (parsed.pathname === "/factory/island/workbench/chat-body") {
        chatBodyRefreshes += 1;
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div id="factory-workbench-chat-body" data-refresh-path="/factory/island/workbench/chat-body${parsed.search}" data-refresh-on="${WORKBENCH_CHAT_DESCRIPTOR}">
            <div id="factory-workbench-chat-root" data-events-path="/factory/chat/events?profile=generalist&chat=chat_demo">
              <div id="factory-workbench-chat-scroll">
                <div id="factory-workbench-chat" data-refresh-path="/factory/island/chat${parsed.search}">${chatMarkup({
                  profileLabel: "Generalist",
                  chatId: parsed.searchParams.get("chat") || "chat_demo",
                  objectiveId: parsed.searchParams.get("objective") || undefined,
                  activeRunId: chatBodyRefreshes >= 1 ? "run_demo" : undefined,
                  knownRunIds: chatBodyRefreshes >= 1 ? ["run_demo"] : [],
                  transcriptSignature: chatBodyRefreshes >= 2 ? "2:assistant_1" : "1:user_1",
                  lastItemKind: chatBodyRefreshes >= 2 ? "assistant" : "user",
                })}</div>
                <div id="factory-chat-live">
                  <div id="factory-chat-streaming">
                    <section id="factory-chat-stream-shell" data-factory-stream-shell data-stream-state="idle">
                      <span id="factory-chat-streaming-label-text">Generalist</span>
                      <span id="factory-chat-streaming-status">Streaming</span>
                      <div id="factory-chat-streaming-loader"><span id="factory-chat-streaming-loader-label">Sending</span><span id="factory-chat-streaming-loader-meta"></span></div>
                      <div id="factory-chat-streaming-content"></div>
                    </section>
                  </div>
                  <div id="factory-chat-stream-reset-listener"></div>
                  <div id="factory-chat-optimistic"></div>
                </div>
              </div>
            </div>
          </div>`,
        };
      }
      if (parsed.pathname === "/factory/island/chat") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || "chat_demo",
            objectiveId: parsed.searchParams.get("objective") || undefined,
          }),
        };
      }
      if (parsed.pathname === "/factory/island/workbench") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div data-workbench-objective-id="${parsed.searchParams.get("objective") || ""}">workbench panel</div>`,
        };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => workbenchShellSnapshot({
          search: parsed.search || "?profile=generalist&chat=chat_demo",
          chatHtml: chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || "chat_demo",
            objectiveId: parsed.searchParams.get("objective") || undefined,
          }),
          workbenchHtml: `<div data-workbench-objective-id="${parsed.searchParams.get("objective") || ""}">workbench panel</div>`,
        }),
        text: async () => "",
      };
    },
  });

  textarea.value = "Keep the operator chat separate from objective tracking.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));

  expect(status.textContent).toBe("");
  expect(optimistic.innerHTML).not.toContain("Sending in chat");
  expect(optimistic.innerHTML).toContain("Just now");
  expect(streamingShell.getAttribute("data-stream-state")).toBe("pending");
  expect(streamingShell.classList.contains("hidden")).toBe(false);
  expect(streamingLoader.classList.contains("hidden")).toBe(false);
  expect(streamingStatus.textContent).toBe("Sending");
  expect(streaming.innerHTML).toBe("");
  await flushAsync(140);

  expect(historyState.pushed).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&inspectorTab=chat");
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&inspectorTab=chat&detailTab=action");
  expect(chatSource()?.url).toBe("/factory/chat/events?profile=generalist&chat=chat_demo");
  expect(optimistic.innerHTML).not.toContain("Queued. Waiting for the reply to start.");
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo&inspectorTab=chat&detailTab=action")).toBe(false);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&inspectorTab=chat&detailTab=action")).toBe(false);
  expect(streamingStatus.textContent).toBe("Thinking");

  chatSource()?.emit("agent-refresh", "run_demo");
  await flushAsync(220);
  expect(chatBodyRefreshes).toBeGreaterThan(0);
  expect(streamingShell.getAttribute("data-stream-state")).toBe("pending");
  expect(streamingLoader.classList.contains("hidden")).toBe(false);
  expect(streamingStatus.textContent).toBe("Starting");

  textarea.value = "/obj Build the new deployment review objective.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));

  expect(status.textContent).toBe("Starting objective...");
  await flushAsync();

  expect(historyState.pushed).toContain("/factory?profile=generalist&chat=chat_demo&objective=objective_created&inspectorTab=chat&detailTab=action");
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_created&inspectorTab=chat&detailTab=action");
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_created&inspectorTab=chat&detailTab=action");
  expect(chatSource()?.url).toBe("/factory/chat/events?profile=generalist&chat=chat_demo&objective=objective_created");
});

test("factory workbench client: inspector tab changes replace history and refresh the full chat pane", async () => {
  const { document, fetchCalls, historyState, locationState } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync(220);

  expect(historyState.replaced).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat&detailTab=action"]);
  expect(historyState.pushed).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat&detailTab=action");
  expect(fetchCalls.filter((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat&detailTab=action")).toHaveLength(1);
  expect(fetchCalls.some((call) => call.url === "/factory/api/workbench-shell?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat")).toBe(false);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat&detailTab=action")).toBe(false);
  expect(document.getElementById("factory-workbench-chat-header")).not.toBeNull();
});

test("factory workbench client: focus changes replace history and refresh summary plus activity only", async () => {
  const { document, fetchCalls, historyState, locationState } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&focusKind=task&focusId=task_1");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync(260);

  expect(historyState.replaced).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&focusKind=task&focusId=task_1"]);
  expect(historyState.pushed).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&focusKind=task&focusId=task_1");
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&focusKind=task&focusId=task_1&block=summary")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&focusKind=task&focusId=task_1&block=activity")).toHaveLength(1);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&focusKind=task&focusId=task_1")).toBe(false);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&focusKind=task&focusId=task_1")).toBe(false);
});

test("factory workbench client: filter changes push history and refresh header plus workbench island", async () => {
  const { document, fetchCalls, historyState, locationState } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync(260);

  expect(historyState.pushed).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&filter=objective.completed"]);
  expect(historyState.replaced).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&filter=objective.completed");
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&filter=objective.completed")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&filter=objective.completed")).toHaveLength(1);
  expect(fetchCalls.some((call) => call.url === "/factory/api/workbench-shell?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed")).toBe(false);
});

test("factory workbench client: window focus and pageshow only resync live sources", async () => {
  const { dispatchWindowEvent, fetchCalls, backgroundSource, chatSource } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });

  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action");
  expect(chatSource()).toBeNull();

  dispatchWindowEvent("focus");
  dispatchWindowEvent("pageshow");
  await flushAsync();

  expect(fetchCalls).toHaveLength(0);
});

test("factory workbench client: focused jobs narrow the chat event stream", async () => {
  const { document, historyState, locationState, chatSource } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat&focusKind=job&focusId=job_1");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync();

  expect(historyState.replaced).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat&detailTab=action&focusKind=job&focusId=job_1"]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat&detailTab=action&focusKind=job&focusId=job_1");
  expect(chatSource()?.url).toBe("/factory/chat/events?profile=generalist&chat=chat_demo&objective=objective_demo&job=job_1");
});

test("factory workbench client: full shell refresh preserves pane and document scroll positions", async () => {
  const { document, historyState, locationState, workbenchRailScroll, workbenchFocusScroll } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => workbenchShellSnapshot({
          search: parsed.search || "?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed",
          workbenchHtml: workbenchPanelMarkup(
            parsed.search || "?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed",
            parsed.searchParams.get("objective") || undefined,
            "preserved panes",
          ),
          chatHtml: chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || "chat_demo",
            objectiveId: parsed.searchParams.get("objective") || undefined,
          }),
        }),
        text: async () => "",
      };
    },
  });
  workbenchRailScroll.scrollTop = 190;
  workbenchRailScroll.scrollHeight = 1180;
  workbenchRailScroll.clientHeight = 360;
  workbenchFocusScroll.scrollTop = 240;
  workbenchFocusScroll.scrollHeight = 1360;
  workbenchFocusScroll.clientHeight = 420;
  document.body.scrollTop = 280;

  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed");
  anchor.setAttribute("data-factory-history", "push");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&filter=objective.completed"]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&filter=objective.completed");
  expect(workbenchRailScroll.scrollTop).toBe(190);
  expect(workbenchFocusScroll.scrollTop).toBe(240);
  expect(document.body.scrollTop).toBe(280);
});

test("factory workbench client: session replay restores local view state and pending live overlay", async () => {
  const replayKey = "receipt.factory.workbench.v1:generalist:chat_demo";
  const now = Date.now();
  const { document, optimistic, historyState, locationState } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
    sessionStorageState: {
      [replayKey]: JSON.stringify({
        savedAt: now,
        route: {
          profileId: "generalist",
          chatId: "chat_demo",
          objectiveId: "objective_old",
          inspectorTab: "notes",
          filter: "objective.completed",
          focusKind: "job",
          focusId: "job_42",
        },
        liveOverlay: {
          statusLabel: "Queued",
          summary: "Queued for replay",
          runId: "run_1",
          savedAt: now,
        },
      }),
    },
  });

  expect(historyState.replaced).toContain("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&filter=objective.completed&focusKind=job&focusId=job_42");
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&filter=objective.completed&focusKind=job&focusId=job_42");
  expect(document.body.getAttribute("data-inspector-tab")).toBe("overview");
  expect(document.body.getAttribute("data-focus-kind")).toBe("job");
  expect(document.body.getAttribute("data-focus-id")).toBe("job_42");
  expect(optimistic.innerHTML).toContain("Queued for replay");
});

test("factory workbench client: superseded scope refreshes abort stale scope fetches", async () => {
  let resolveObjectiveB: (() => void) | undefined;
  let resolveObjectiveC: (() => void) | undefined;
  const { document, historyState, locationState, fetchCalls, workbenchPanel } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_a",
    fetchImpl: async (url, init) => {
      const parsed = new URL(url, "http://receipt.test");
      if (parsed.pathname === "/factory/island/workbench" && parsed.search === "?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action") {
        return await new Promise((resolve, reject) => {
          resolveObjectiveB = () => resolve({
            ok: true,
            headers: { get: () => "text/html" },
            json: async () => ({}),
            text: async () => '<div data-workbench-objective-id="objective_b">objective b</div>',
          });
          init.signal?.addEventListener("abort", () => {
            resolveObjectiveB = undefined;
            const error = new Error("aborted");
            (error as Error & { name: string }).name = "AbortError";
            reject(error);
          }, { once: true });
        }) as {
          readonly ok: boolean;
          readonly headers: { readonly get: (name: string) => string | null };
          readonly text: () => Promise<string>;
        };
      }
      if (parsed.pathname === "/factory/island/workbench" && parsed.search === "?profile=generalist&chat=chat_demo&objective=objective_c&detailTab=action") {
        return await new Promise((resolve, reject) => {
          resolveObjectiveC = () => resolve({
            ok: true,
            headers: { get: () => "text/html" },
            json: async () => ({}),
            text: async () => '<div data-workbench-objective-id="objective_c">objective c</div>',
          });
          init.signal?.addEventListener("abort", () => {
            resolveObjectiveC = undefined;
            const error = new Error("aborted");
            (error as Error & { name: string }).name = "AbortError";
            reject(error);
          }, { once: true });
        }) as {
          readonly ok: boolean;
          readonly headers: { readonly get: (name: string) => string | null };
          readonly text: () => Promise<string>;
        };
      }
      if (parsed.pathname === "/factory/island/chat") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || "chat_demo",
            objectiveId: parsed.searchParams.get("objective") || "objective_a",
          }),
        };
      }
      if (parsed.pathname === "/factory/island/workbench/header") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div>Header ${parsed.searchParams.get("profile") || "generalist"}</div>`,
        };
      }
      if (parsed.pathname === "/factory/island/chat/header") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div>${parsed.searchParams.get("profile") || "generalist"} chat header</div>`,
        };
      }
      if (parsed.pathname === "/factory/island/workbench/block") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div>${parsed.searchParams.get("block") || "summary"} refreshed</div>`,
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => workbenchPanelMarkup(
          parsed.search || "?profile=generalist&chat=chat_demo&objective=objective_a",
          parsed.searchParams.get("objective") || "objective_a",
          "workbench panel",
        ),
      };
    },
  });

  const anchorB = new MockElement("A");
  anchorB.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_b");
  const anchorC = new MockElement("A");
  anchorC.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_c");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchorB }));
  document.dispatchEvent(new MockEvent({ type: "click", target: anchorC }));

  await flushAsync();
  resolveObjectiveC?.(undefined);
  await flushAsync();
  resolveObjectiveB?.(undefined);
  await flushAsync();

  expect(historyState.pushed).toEqual([
    "/factory?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action",
    "/factory?profile=generalist&chat=chat_demo&objective=objective_c&detailTab=action",
  ]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_c&detailTab=action");
  expect(resolveObjectiveB).toBeUndefined();
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_b&detailTab=action")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_c&detailTab=action")).toBe(true);
  expect(workbenchPanel.innerHTML).toContain("objective c");
});
