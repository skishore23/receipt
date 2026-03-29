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
} = {}) =>
  `<div data-active-profile="generalist" data-active-profile-label="${input.profileLabel ?? "Generalist"}" data-chat-id="${input.chatId ?? ""}" data-objective-id="${input.objectiveId ?? ""}" data-active-run-id="${input.activeRunId ?? ""}" data-known-run-ids="${(input.knownRunIds ?? []).join(",")}" data-terminal-run-ids="${(input.terminalRunIds ?? []).join(",")}"></div>`;

const CHAT_TRIGGER = "sse:agent-refresh throttle:180ms, sse:job-refresh throttle:180ms, sse:objective-runtime-refresh throttle:180ms, sse:factory-refresh throttle:180ms, factory:chat-refresh from:body";
const OBJECTIVE_TRIGGER = "sse:profile-board-refresh throttle:450ms, sse:objective-runtime-refresh throttle:450ms, sse:factory-refresh throttle:450ms, factory:scope-changed from:body";
const WORKBENCH_CHAT_TRIGGER = "sse:agent-refresh throttle:180ms, sse:job-refresh throttle:180ms";
const WORKBENCH_BACKGROUND_TRIGGER = "";
const WORKBENCH_HEADER_TRIGGER = "sse:profile-board-refresh throttle:300ms, sse:objective-runtime-refresh throttle:300ms";
const WORKBENCH_PROFILE_BOARD_BLOCK_TRIGGER = "sse:profile-board-refresh throttle:320ms";
const WORKBENCH_RUNTIME_BLOCK_TRIGGER = "sse:objective-runtime-refresh throttle:320ms";
const WORKBENCH_SHARED_BLOCK_TRIGGER = "sse:profile-board-refresh throttle:320ms, sse:objective-runtime-refresh throttle:320ms";
const WORKBENCH_CHAT_DESCRIPTOR = "sse:agent-refresh@180,sse:job-refresh@180";
const WORKBENCH_BACKGROUND_DESCRIPTOR = "";
const WORKBENCH_HEADER_DESCRIPTOR = "sse:profile-board-refresh@300,sse:objective-runtime-refresh@300";
const WORKBENCH_PROFILE_BOARD_BLOCK_DESCRIPTOR = "sse:profile-board-refresh@320";
const WORKBENCH_RUNTIME_BLOCK_DESCRIPTOR = "sse:objective-runtime-refresh@320";
const WORKBENCH_SHARED_BLOCK_DESCRIPTOR = "sse:profile-board-refresh@320,sse:objective-runtime-refresh@320";

const workbenchHeaderPath = (search: string) => `/factory/island/workbench/header${search}`;

const workbenchBlockPath = (search: string, block: "summary" | "activity" | "objectives" | "history") => {
  const parsed = new URL("http://receipt.test/factory" + search);
  parsed.pathname = "/factory/island/workbench/block";
  parsed.searchParams.set("block", block);
  return `${parsed.pathname}${parsed.search}`;
};

const workbenchPanelMarkup = (search: string, objectiveId?: string, content = "workbench panel") =>
  `<div class="factory-scrollbar flex flex-col gap-4 pr-1 lg:h-full lg:min-h-0 lg:overflow-y-auto" data-workbench-objective-id="${objectiveId ?? ""}">
    <div id="factory-workbench-block-summary" data-workbench-projections="profile-board objective-runtime" hx-get="${workbenchBlockPath(search, "summary")}" hx-trigger="${WORKBENCH_SHARED_BLOCK_TRIGGER}" hx-swap="innerHTML" data-refresh-on="${WORKBENCH_SHARED_BLOCK_DESCRIPTOR}"><div>${content} summary</div></div>
    <div id="factory-workbench-block-activity" data-workbench-projections="objective-runtime" hx-get="${workbenchBlockPath(search, "activity")}" hx-trigger="${WORKBENCH_RUNTIME_BLOCK_TRIGGER}" hx-swap="innerHTML" data-refresh-on="${WORKBENCH_RUNTIME_BLOCK_DESCRIPTOR}"><div>${content} activity</div></div>
    <div id="factory-workbench-block-objectives" data-workbench-projections="profile-board" hx-get="${workbenchBlockPath(search, "objectives")}" hx-trigger="${WORKBENCH_PROFILE_BOARD_BLOCK_TRIGGER}" hx-swap="innerHTML" data-refresh-on="${WORKBENCH_PROFILE_BOARD_BLOCK_DESCRIPTOR}"><div>${content} objectives</div></div>
    <div id="factory-workbench-block-history" data-workbench-projections="profile-board" hx-get="${workbenchBlockPath(search, "history")}" hx-trigger="${WORKBENCH_PROFILE_BOARD_BLOCK_TRIGGER}" hx-swap="innerHTML" data-refresh-on="${WORKBENCH_PROFILE_BOARD_BLOCK_DESCRIPTOR}"><div>${content} history</div></div>
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
  return `<!doctype html>
<html>
<head>
  <title>Receipt Factory Workbench</title>
</head>
<body data-factory-workbench="true" data-route-key="/factory${search}" data-chat-id="${chatId}" data-objective-id="${objectiveId ?? ""}" data-inspector-tab="${inspectorTab}" data-focus-kind="${focusKind}" data-focus-id="${focusId}">
  <div id="factory-workbench-header" hx-get="${workbenchHeaderPath(search)}" hx-trigger="${WORKBENCH_HEADER_TRIGGER}" hx-swap="innerHTML" data-refresh-on="${WORKBENCH_HEADER_DESCRIPTOR}">
    <select id="factory-workbench-profile-select" data-factory-profile-select="true">
      <option value="/factory?profile=${profileId}&chat=${chatId || "chat_demo"}" selected>${profileLabel}</option>
      <option value="/factory?profile=software&chat=${chatId || "chat_demo"}">Software</option>
    </select>
  </div>
  <div id="factory-workbench-background-root" data-events-path="/factory/background/events${search}">
    <div id="factory-workbench-panel" hx-get="/factory/island/workbench${search}" hx-trigger="${WORKBENCH_BACKGROUND_TRIGGER}" hx-swap="innerHTML" data-refresh-on="${WORKBENCH_BACKGROUND_DESCRIPTOR}">${input.workbenchHtml ?? workbenchPanelMarkup(search, objectiveId)}</div>
  </div>
  <div id="factory-workbench-chat-header"><span>${profileLabel}</span></div>
  <div id="factory-workbench-chat-root" data-events-path="/factory/chat/events?${chatEvents.toString()}">
    <div id="factory-workbench-chat-scroll">
      <div id="factory-workbench-chat" hx-get="/factory/island/chat${search}" hx-trigger="${WORKBENCH_CHAT_TRIGGER}" hx-swap="innerHTML" data-refresh-on="${WORKBENCH_CHAT_DESCRIPTOR}">${input.chatHtml ?? chatMarkup({ profileLabel, chatId: chatId || undefined, objectiveId })}</div>
      <div id="factory-chat-live">
        <span id="factory-chat-streaming-label-text">${profileLabel}</span>
        <div id="factory-chat-streaming"></div>
        <div id="factory-chat-stream-reset-listener"></div>
        <div id="factory-chat-optimistic"></div>
      </div>
    </div>
    <form id="factory-composer" action="/factory/compose${search}" data-composer-commands='${COMMANDS}'></form>
    <input id="factory-composer-current-job" value="" />
    <textarea id="factory-prompt" placeholder="${input.placeholder ?? ""}"></textarea>
    <div id="factory-composer-completions" class="hidden"></div>
    <div id="factory-composer-status"></div>
    <button id="factory-composer-submit">Send</button>
  </div>
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
    "factory-live-root",
    "factory-shell-title",
    "factory-shell-status-pills",
    "factory-shell-controls",
    "factory-shell-metrics",
    "factory-prompt",
    "factory-composer",
    "factory-composer-current-job",
    "factory-chat",
    "factory-sidebar",
    "factory-inspector",
    "factory-chat-streaming",
    "factory-chat-streaming-label-text",
    "factory-chat-streaming-content",
    "factory-chat-stream-reset-listener",
    "factory-workbench-background-root",
    "factory-workbench-header",
    "factory-workbench-panel",
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
  };
};

const shellMarkup = (input: {
  readonly search?: string;
  readonly mode?: "default" | "mission-control";
  readonly profileLabel?: string;
  readonly chatHtml?: string;
  readonly sidebarHtml?: string;
  readonly inspectorHtml?: string;
  readonly composerActionSearch?: string;
  readonly currentJobId?: string;
  readonly placeholder?: string;
} = {}) => {
  const search = input.search ?? "?profile=generalist";
  const mode = input.mode ?? "default";
  const profileLabel = input.profileLabel ?? "Generalist";
  const parsed = new URL("http://receipt.test/factory" + search);
  const profileSearch = new URLSearchParams(parsed.searchParams);
  profileSearch.set("profile", "software");
  return `<!doctype html>
<html>
<head>
  <title>Receipt Factory Chat</title>
</head>
<body data-factory-mode="${mode}" data-focus-kind="" data-focus-id="">
  <div id="factory-live-root" hx-ext="sse" sse-connect="/factory/events${search}">
    <div id="factory-shell-title">Receipt Factory Chat</div>
    <div id="factory-shell-status-pills"></div>
    <div id="factory-shell-controls">
      <select id="factory-shell-profile-select" data-factory-profile-select="true">
        <option value="/factory${search}" selected>${profileLabel}</option>
        <option value="/factory?${profileSearch.toString()}">Software</option>
      </select>
    </div>
    <div id="factory-shell-metrics"></div>
    <form id="factory-composer" action="/factory/compose${input.composerActionSearch ?? search}"></form>
    <input id="factory-composer-current-job" value="${input.currentJobId ?? ""}" />
    <textarea id="factory-prompt" placeholder="${input.placeholder ?? ""}"></textarea>
    <div id="factory-chat" data-active-profile-label="${profileLabel}" hx-get="/factory/island/chat${search}" hx-trigger="${CHAT_TRIGGER}" hx-swap="innerHTML">${input.chatHtml ?? chatMarkup({ profileLabel })}</div>
    <div id="factory-sidebar" hx-get="/factory/island/sidebar${search}" hx-trigger="${OBJECTIVE_TRIGGER}" hx-swap="innerHTML">${input.sidebarHtml ?? ""}</div>
    <div id="factory-inspector" hx-get="/factory/island/inspector${search}" hx-trigger="${OBJECTIVE_TRIGGER}" hx-swap="innerHTML">${input.inspectorHtml ?? ""}</div>
    <div id="factory-chat-streaming">
      <span id="factory-chat-streaming-label-text">${profileLabel}</span>
      <div id="factory-chat-streaming-content" sse-swap="factory-stream-token" hx-swap="beforeend"></div>
      <div id="factory-chat-stream-reset-listener" sse-swap="factory-stream-reset" hx-swap="none"></div>
    </div>
  </div>
</body>
</html>`;
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

const createHarness = async (options: {
  readonly initialLocation?: string;
  readonly fetchImpl?: (url: string, init: { readonly body?: FormData }) => Promise<{
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

  const liveRoot = new MockElement("DIV");
  liveRoot.id = "factory-live-root";

  const scroll = new MockElement("DIV");
  scroll.id = "factory-chat-scroll";
  scroll.scrollHeight = 640;
  scroll.clientHeight = 320;

  const chat = new MockElement("DIV");
  chat.id = "factory-chat";
  chat.setAttribute("data-active-profile-label", "Generalist");
  chat.innerHTML = chatMarkup();

  const streamingShell = new MockElement("DIV");
  streamingShell.id = "factory-chat-streaming";

  const streamingLabel = new MockElement("SPAN");
  streamingLabel.id = "factory-chat-streaming-label-text";
  streamingLabel.textContent = "Generalist";

  const streaming = new MockElement("DIV");
  streaming.id = "factory-chat-streaming-content";

  const streamingReset = new MockElement("DIV");
  streamingReset.id = "factory-chat-stream-reset-listener";

  const optimistic = new MockElement("DIV");
  optimistic.id = "factory-chat-optimistic";

  const sidebar = new MockElement("DIV");
  sidebar.id = "factory-sidebar";

  const inspector = new MockElement("DIV");
  inspector.id = "factory-inspector";

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

  const shellTitle = new MockElement("DIV");
  shellTitle.id = "factory-shell-title";
  shellTitle.textContent = "Receipt Factory Chat";

  const shellPills = new MockElement("DIV");
  shellPills.id = "factory-shell-status-pills";

  const shellControls = new MockElement("DIV");
  shellControls.id = "factory-shell-controls";

  const shellMetrics = new MockElement("DIV");
  shellMetrics.id = "factory-shell-metrics";

  const sidebarShell = new MockElement("DIV");
  sidebarShell.id = "factory-sidebar-shell";
  sidebarShell.setAttribute("data-pane-active", "false");

  const chatShell = new MockElement("DIV");
  chatShell.id = "factory-chat-shell";
  chatShell.setAttribute("data-pane-active", "false");

  const inspectorShell = new MockElement("DIV");
  inspectorShell.id = "factory-inspector-shell";
  inspectorShell.setAttribute("data-pane-active", "false");

  const composerShell = new MockElement("DIV");
  composerShell.id = "factory-composer-shell";
  composerShell.setAttribute("data-pane-active", "false");

  const form = new MockForm();
  form.id = "factory-composer";
  form.setAttribute("data-composer-commands", COMMANDS);

  const elements = new Map<string, MockElement>([
    [liveRoot.id, liveRoot],
    [scroll.id, scroll],
    [chat.id, chat],
    [streamingShell.id, streamingShell],
    [streamingLabel.id, streamingLabel],
    [streaming.id, streaming],
    [streamingReset.id, streamingReset],
    [optimistic.id, optimistic],
    [textarea.id, textarea],
    [popup.id, popup],
    [status.id, status],
    [submit.id, submit],
    [currentJob.id, currentJob],
    [shellTitle.id, shellTitle],
    [shellPills.id, shellPills],
    [shellControls.id, shellControls],
    [shellMetrics.id, shellMetrics],
    [sidebar.id, sidebar],
    [sidebarShell.id, sidebarShell],
    [chatShell.id, chatShell],
    [inspector.id, inspector],
    [inspectorShell.id, inspectorShell],
    [composerShell.id, composerShell],
    [form.id, form],
  ]);

  const body = new MockElement("BODY");
  const initialLocation = new URL(options.initialLocation ?? "http://receipt.test/factory?profile=generalist");
  liveRoot.setAttribute("hx-ext", "sse");
  liveRoot.setAttribute("sse-connect", `/factory/events${initialLocation.search}`);
  chat.setAttribute("hx-get", `/factory/island/chat${initialLocation.search}`);
  chat.setAttribute("hx-trigger", CHAT_TRIGGER);
  chat.setAttribute("hx-swap", "innerHTML");
  sidebar.setAttribute("hx-get", `/factory/island/sidebar${initialLocation.search}`);
  sidebar.setAttribute("hx-trigger", OBJECTIVE_TRIGGER);
  sidebar.setAttribute("hx-swap", "innerHTML");
  inspector.setAttribute("hx-get", `/factory/island/inspector${initialLocation.search}`);
  inspector.setAttribute("hx-trigger", OBJECTIVE_TRIGGER);
  inspector.setAttribute("hx-swap", "innerHTML");
  body.setAttribute("data-factory-mode", initialLocation.searchParams.get("mode") === "mission-control" ? "mission-control" : "default");
  body.setAttribute("data-focus-kind", "");
  body.setAttribute("data-focus-id", "");

  const documentListeners = new Map<string, Array<Listener>>();
  const document = {
    readyState: "complete",
    body,
    activeElement: undefined as unknown,
    title: "Receipt Factory Chat",
    addEventListener: (type: string, handler: Listener) => {
      const handlers = documentListeners.get(type) ?? [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
      if (type === "DOMContentLoaded") handler(new MockEvent({ type: "DOMContentLoaded" }));
    },
    dispatchEvent: (event: MockEvent) => {
      for (const handler of documentListeners.get(event.type) ?? []) handler(event);
    },
    querySelector: (selector: string) => selector === "[data-factory-chat]" ? body : null,
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
  const triggerBindings: Array<{ readonly type: string; readonly handler: Listener }> = [];
  let activeEventSource: MockEventSource | null = null;
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
    const fetchFn = sandbox.fetch as (url: string, init: { readonly body?: FormData }) => Promise<{
      readonly ok: boolean;
      readonly text: () => Promise<string>;
    }>;
    const response = await fetchFn(url, {});
    if (!response.ok) throw new Error("Request failed.");
    const markup = await response.text();
    performSwap(target, markup);
  };
  const bindBodyTriggers = (target: MockElement) => {
    for (const type of bodyTriggerEvents(target.getAttribute("hx-trigger"))) {
      const handler: Listener = () => {
        void refreshElement(target);
      };
      body.addEventListener(type, handler);
      triggerBindings.push({ type, handler });
    }
  };
  const applySseSwap = (target: MockElement, data: string) => {
    if (target.id === "factory-chat-stream-reset-listener") {
      const targetId = data.match(/id="([^"]+)"/)?.[1];
      const resetTarget = targetId ? elements.get(targetId) ?? null : null;
      if (resetTarget) {
        resetTarget.innerHTML = "";
        dispatchAfterSwap(resetTarget);
      }
      return;
    }
    performSwap(target, data);
  };
  const htmx = {
    process: (root: Element) => {
      if (!(root instanceof MockElement)) return;
      for (const binding of triggerBindings.splice(0)) {
        body.removeEventListener(binding.type, binding.handler);
      }
      if (activeEventSource) activeEventSource.close();
      activeEventSource = null;
      const sseUrl = root.getAttribute("sse-connect");
      if (sseUrl) {
        activeEventSource = new MockEventSource(sseUrl);
        for (const element of elements.values()) {
          const sseSwapEvent = element.getAttribute("sse-swap");
          if (sseSwapEvent) {
            activeEventSource.addEventListener(sseSwapEvent, (event) => {
              applySseSwap(element, String(event.data || ""));
            });
          }
          for (const type of sseTriggerEvents(element.getAttribute("hx-trigger"))) {
            activeEventSource.addEventListener(type, () => {
              void refreshElement(element);
            });
          }
          bindBodyTriggers(element);
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
    HTMLElement: MockElement,
    Element: MockElement,
    Node: MockElement,
    URL,
    URLSearchParams,
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
    fetch: async (url: string, init: { readonly body?: FormData }) => {
      fetchCalls.push({ url, body: init.body });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      if (url.indexOf("/factory/compose") >= 0) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({ location: "/factory?profile=generalist&chat=chat_01" }),
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
            objectiveId: parsed.searchParams.get("thread") || undefined,
          }),
        };
      }
      if (parsed.pathname === "/factory/island/sidebar" || parsed.pathname === "/factory/island/inspector") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => "<div></div>",
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => shellMarkup({
          search: parsed.search || "?profile=generalist",
          mode: parsed.searchParams.get("mode") === "mission-control" ? "mission-control" : "default",
          chatHtml: chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || undefined,
            objectiveId: parsed.searchParams.get("thread") || undefined,
          }),
        }),
      };
    },
    requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout,
    clearTimeout,
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
  form.action = "/factory/compose" + initialLocation.search;
  sandbox.window = sandbox;
  vm.runInNewContext(await loadClient(), sandbox);
  htmx.process(liveRoot);
  return {
    document,
    textarea,
    scroll,
    popup,
    optimistic,
    streaming,
    streamingLabel,
    status,
    submit,
    form,
    currentJob,
    liveRoot,
    chat,
    chatShell,
    sidebar,
    sidebarShell,
    inspector,
    inspectorShell,
    composerShell,
    fetchCalls,
    locationState,
    historyState,
    latestEventSource: () => MockEventSource.instances.at(-1) ?? null,
  };
};

const createWorkbenchHarness = async (options: {
  readonly initialLocation?: string;
  readonly sessionStorageState?: Record<string, string>;
  readonly beforeBoot?: (input: {
    readonly body: MockElement;
    readonly workbenchHeader: MockElement;
    readonly workbenchPanel: MockElement;
    readonly workbenchSummary: MockElement;
    readonly workbenchActivity: MockElement;
    readonly workbenchObjectives: MockElement;
    readonly workbenchHistory: MockElement;
    readonly chat: MockElement;
  }) => void;
  readonly fetchImpl?: (url: string, init: { readonly body?: FormData }) => Promise<{
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

  const streamingLabel = new MockElement("SPAN");
  streamingLabel.id = "factory-chat-streaming-label-text";
  streamingLabel.textContent = "Generalist";

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
    [workbenchSummary.id, workbenchSummary],
    [workbenchActivity.id, workbenchActivity],
    [workbenchObjectives.id, workbenchObjectives],
    [workbenchHistory.id, workbenchHistory],
    [workbenchChatHeader.id, workbenchChatHeader],
    [chatRoot.id, chatRoot],
    [scroll.id, scroll],
    [chat.id, chat],
    [chatLive.id, chatLive],
    [streamingShell.id, streamingShell],
    [streamingLabel.id, streamingLabel],
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
  backgroundRoot.setAttribute("data-events-path", `/factory/background/events${initialLocation.search}`);
  workbenchHeader.setAttribute("hx-get", workbenchHeaderPath(initialLocation.search));
  workbenchHeader.setAttribute("hx-trigger", WORKBENCH_HEADER_TRIGGER);
  workbenchHeader.setAttribute("hx-swap", "innerHTML");
  workbenchHeader.setAttribute("data-refresh-on", WORKBENCH_HEADER_DESCRIPTOR);
  workbenchPanel.setAttribute("hx-get", `/factory/island/workbench${initialLocation.search}`);
  workbenchPanel.setAttribute("hx-trigger", WORKBENCH_BACKGROUND_TRIGGER);
  workbenchPanel.setAttribute("hx-swap", "innerHTML");
  workbenchPanel.setAttribute("data-refresh-on", WORKBENCH_BACKGROUND_DESCRIPTOR);
  workbenchSummary.setAttribute("hx-get", workbenchBlockPath(initialLocation.search, "summary"));
  workbenchSummary.setAttribute("hx-trigger", WORKBENCH_SHARED_BLOCK_TRIGGER);
  workbenchSummary.setAttribute("hx-swap", "innerHTML");
  workbenchSummary.setAttribute("data-refresh-on", WORKBENCH_SHARED_BLOCK_DESCRIPTOR);
  workbenchActivity.setAttribute("hx-get", workbenchBlockPath(initialLocation.search, "activity"));
  workbenchActivity.setAttribute("hx-trigger", WORKBENCH_RUNTIME_BLOCK_TRIGGER);
  workbenchActivity.setAttribute("hx-swap", "innerHTML");
  workbenchActivity.setAttribute("data-refresh-on", WORKBENCH_RUNTIME_BLOCK_DESCRIPTOR);
  workbenchObjectives.setAttribute("hx-get", workbenchBlockPath(initialLocation.search, "objectives"));
  workbenchObjectives.setAttribute("hx-trigger", WORKBENCH_PROFILE_BOARD_BLOCK_TRIGGER);
  workbenchObjectives.setAttribute("hx-swap", "innerHTML");
  workbenchObjectives.setAttribute("data-refresh-on", WORKBENCH_PROFILE_BOARD_BLOCK_DESCRIPTOR);
  workbenchHistory.setAttribute("hx-get", workbenchBlockPath(initialLocation.search, "history"));
  workbenchHistory.setAttribute("hx-trigger", WORKBENCH_PROFILE_BOARD_BLOCK_TRIGGER);
  workbenchHistory.setAttribute("hx-swap", "innerHTML");
  workbenchHistory.setAttribute("data-refresh-on", WORKBENCH_PROFILE_BOARD_BLOCK_DESCRIPTOR);
  const chatEvents = new URLSearchParams();
  chatEvents.set("profile", initialLocation.searchParams.get("profile") || "generalist");
  if (initialLocation.searchParams.get("chat")) chatEvents.set("chat", initialLocation.searchParams.get("chat")!);
  chatRoot.setAttribute("data-events-path", `/factory/chat/events?${chatEvents.toString()}`);
  chat.setAttribute("hx-get", `/factory/island/chat${initialLocation.search}`);
  chat.setAttribute("hx-trigger", WORKBENCH_CHAT_TRIGGER);
  chat.setAttribute("hx-swap", "innerHTML");
  chat.setAttribute("data-refresh-on", WORKBENCH_CHAT_DESCRIPTOR);
  form.action = "/factory/compose" + initialLocation.search;
  options.beforeBoot?.({
    body,
    workbenchHeader,
    workbenchPanel,
    workbenchSummary,
    workbenchActivity,
    workbenchObjectives,
    workbenchHistory,
    chat,
  });

  const documentListeners = new Map<string, Array<Listener>>();
  const document = {
    readyState: "complete",
    body,
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
    querySelector: (selector: string) => selector === "[data-factory-workbench]" ? body : null,
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
    const fetchFn = sandbox.fetch as (url: string, init: { readonly body?: FormData }) => Promise<{
      readonly ok: boolean;
      readonly text: () => Promise<string>;
    }>;
    const response = await fetchFn(url, {});
    if (!response.ok) throw new Error("Request failed.");
    const markup = await response.text();
    performSwap(target, markup);
  };
  const htmx = {
    process: (root: Element) => {
      if (!(root instanceof MockElement)) return;
      void root;
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
    fetch: async (url: string, init: { readonly body?: FormData }) => {
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
      if (parsed.pathname === "/factory/island/workbench/block") {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => `<div>${parsed.searchParams.get("block") || "summary"} refreshed</div>`,
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
    chat,
    streaming: streamingShell,
    fetchCalls,
    locationState,
    historyState,
    sessionStorageState,
    backgroundSource: () => latestSourceFor("/factory/background/events"),
    chatSource: () => latestSourceFor("/factory/chat/events"),
  };
};

if (false) {
test("factory client: autocomplete opens, filters, navigates, inserts, and submits", async () => {
  const { textarea, popup, status, form, fetchCalls } = await createHarness({
    fetchImpl: () => new Promise(() => {}),
  });
  textarea.value = "/ab";
  textarea.selectionStart = 3;
  textarea.dispatchEvent(new MockEvent({ type: "input", target: textarea }));
  expect(textarea.getAttribute("aria-expanded")).toBe("true");
  expect(popup.classList.contains("hidden")).toBe(false);
  expect(popup.innerHTML).toContain("/abort-job");
  expect(popup.innerHTML).not.toContain("/react");

  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "ArrowDown", target: textarea }));
  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "Enter", target: textarea }));
  expect(textarea.value).toBe("/abort-job ");

  textarea.value = "/abort-job stop this worker";
  textarea.selectionStart = textarea.value.length;
  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "Escape", target: textarea }));
  expect(textarea.getAttribute("aria-expanded")).toBe("false");

  textarea.value = "/abort-job keep receipts concise";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));
  await Promise.resolve();
  await Promise.resolve();
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]?.url).toContain("/factory/compose?profile=generalist");
  expect(status.textContent).toBe("Requesting job abort...");
});

test("factory client: enter submits the composer", async () => {
  const { textarea, form } = await createHarness();
  let requestSubmitCalls = 0;
  form.requestSubmit = () => {
    requestSubmitCalls += 1;
    form.dispatchEvent(new MockEvent({ type: "submit", target: form }));
  };
  textarea.value = "Send this comment";
  textarea.selectionStart = textarea.value.length;
  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "Enter", target: textarea }));
  expect(requestSubmitCalls).toBe(1);
});

test("factory client: prompt submit shows optimistic pending transcript immediately and keeps it through inline navigation", async () => {
  let resolveFetch: ((value: {
    readonly ok: boolean;
    readonly headers: { readonly get: (name: string) => string | null };
    readonly json: () => Promise<unknown>;
    readonly text: () => Promise<string>;
  }) => void) | undefined;
  const { textarea, form, optimistic, status, submit, scroll, locationState, historyState } = await createHarness({
    fetchImpl: (url) => {
      if (url.indexOf("/factory/compose") >= 0) {
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      }
      if (url.indexOf("/factory?profile=generalist&chat=chat_optimistic") >= 0) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => shellMarkup({
            search: "?profile=generalist&chat=chat_optimistic",
            chatHtml: chatMarkup({ chatId: "chat_optimistic" }),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<div></div>",
      });
    },
  });

  textarea.value = "List the current EC2 instances.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));

  expect(status.textContent).toBe("Starting a new thread...");
  expect(submit.disabled).toBe(true);
  expect(submit.textContent).toBe("Starting...");
  expect(optimistic.innerHTML).toContain("List the current EC2 instances.");
  expect(optimistic.innerHTML).toContain("Queued");
  expect(scroll.scrollTop).toBe(scroll.scrollHeight);

  resolveFetch?.({
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => ({
      location: "/factory?profile=generalist&chat=chat_optimistic",
      live: {
        profileId: "generalist",
        chatId: "chat_optimistic",
        runId: "run_optimistic",
        jobId: "job_optimistic",
      },
    }),
    text: async () => "",
  });
  await flushAsync();
  expect(locationState.assigned).toEqual([]);
  expect(historyState.pushed).toEqual(["/factory?profile=generalist&chat=chat_optimistic"]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_optimistic");
  expect(submit.disabled).toBe(false);
  expect(submit.textContent).toBe("Send");
  expect(textarea.value).toBe("");
  expect(optimistic.innerHTML).toContain("List the current EC2 instances.");
});

test("factory client: selected-thread submits keep the shell aligned and avoid queueing copy", async () => {
  const { textarea, form, optimistic, status, submit, sidebar, inspector, locationState, historyState } = await createHarness({
    initialLocation: "http://receipt.test/factory?profile=infrastructure&chat=chat_demo&thread=objective_demo&panel=overview",
    fetchImpl: async (url) => {
      if (url.indexOf("/factory/compose") >= 0) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({
            location: "/factory?profile=infrastructure&chat=chat_demo&thread=objective_demo&panel=overview",
            live: {
              profileId: "infrastructure",
              chatId: "chat_demo",
              objectiveId: "objective_demo",
            },
          }),
          text: async () => "",
        };
      }
      if (url.indexOf("/factory?profile=infrastructure&chat=chat_demo&thread=objective_demo&panel=overview") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => shellMarkup({
            search: "?profile=infrastructure&chat=chat_demo&thread=objective_demo&panel=overview",
            profileLabel: "Infrastructure",
            chatHtml: chatMarkup({ profileLabel: "Infrastructure", chatId: "chat_demo", objectiveId: "objective_demo" }),
            sidebarHtml: "<div>sidebar synced</div>",
            inspectorHtml: "<div>inspector synced</div>",
            composerActionSearch: "?profile=infrastructure&chat=chat_demo&thread=objective_demo&panel=overview",
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<div></div>",
      };
    },
  });

  textarea.value = "Check why the infrastructure thread is queueing.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));

  expect(status.textContent).toBe("Updating the thread...");
  expect(submit.textContent).toBe("Updating...");
  expect(optimistic.innerHTML).toContain("Updating thread");
  expect(optimistic.innerHTML).not.toContain("Queued follow-up");

  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=infrastructure&chat=chat_demo&thread=objective_demo&panel=overview"]);
  expect(locationState.search).toBe("?profile=infrastructure&chat=chat_demo&thread=objective_demo&panel=overview");
  expect(sidebar.innerHTML).toContain("sidebar synced");
  expect(inspector.innerHTML).toContain("inspector synced");
  expect(status.textContent).toBe("");
  expect(submit.textContent).toBe("Send");
});

test("factory client: stale live refreshes do not clear the optimistic transcript", async () => {
  let composeResolved = false;
  const { textarea, form, optimistic, latestEventSource } = await createHarness({
    fetchImpl: (url) => {
      if (url.indexOf("/factory/compose") >= 0) {
        return new Promise(() => {});
      }
      if (url.indexOf("/factory/island/chat") >= 0) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => {
            composeResolved = true;
            return chatMarkup();
          },
        });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<div></div>",
      });
    },
  });

  textarea.value = "Inspect the queue race.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));
  expect(optimistic.innerHTML).toContain("Inspect the queue race.");

  latestEventSource()?.emit("job-refresh", "123");
  await flushAsync(240);

  expect(composeResolved).toBe(true);
  expect(optimistic.innerHTML).toContain("Inspect the queue race.");
});

test("factory client: chat refresh promotes discovered objective into the URL and reconnects live updates", async () => {
  let chatRefreshCount = 0;
  const { textarea, form, fetchCalls, historyState, latestEventSource } = await createHarness({
    fetchImpl: async (url) => {
      if (url.indexOf("/factory/compose") >= 0) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({
            location: "/factory?profile=generalist&chat=chat_live",
            live: {
              profileId: "generalist",
              chatId: "chat_live",
              runId: "run_live",
              jobId: "job_live",
            },
          }),
          text: async () => "",
        };
      }
      if (url.indexOf("/factory?profile=generalist&chat=chat_live") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => shellMarkup({
            search: "?profile=generalist&chat=chat_live",
            chatHtml: chatMarkup({ chatId: "chat_live", activeRunId: "run_live", knownRunIds: ["run_live"] }),
          }),
        };
      }
      if (url.indexOf("/factory/island/chat") >= 0) {
        chatRefreshCount += 1;
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatRefreshCount > 0
            ? chatMarkup({ chatId: "chat_live", objectiveId: "objective_live", activeRunId: "run_live", knownRunIds: ["run_live"] })
            : chatMarkup({ chatId: "chat_live", activeRunId: "run_live", knownRunIds: ["run_live"] }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<div></div>",
      };
    },
  });

  textarea.value = "Check the live objective binding.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));
  await flushAsync();

  const sourceBeforeBind = latestEventSource();
  expect(sourceBeforeBind?.url).toBe("/factory/events?profile=generalist&chat=chat_live");

  sourceBeforeBind?.emit("agent-refresh", "123");
  await flushAsync(240);

  expect(historyState.replaced).toContain("/factory?profile=generalist&chat=chat_live&thread=objective_live");
  const reboundSource = latestEventSource();
  expect(reboundSource).not.toBe(sourceBeforeBind);
  expect(sourceBeforeBind?.closed).toBe(true);
  expect(reboundSource?.url).toBe("/factory/events?profile=generalist&chat=chat_live&thread=objective_live");
  expect(fetchCalls.some((call) => call.url === "/factory/island/sidebar?profile=generalist&chat=chat_live&thread=objective_live")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/inspector?profile=generalist&chat=chat_live&thread=objective_live")).toBe(true);

  const fetchCountBeforeStaleEmit = fetchCalls.length;
  sourceBeforeBind?.emit("factory-refresh", "ignored");
  await flushAsync(500);
  expect(fetchCalls.length).toBe(fetchCountBeforeStaleEmit);
});

test("factory client: explicit objective refresh clears a stale chat query from the URL", async () => {
  const { chat, historyState, locationState, latestEventSource } = await createHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_stale&thread=objective_live",
    fetchImpl: async (url) => {
      if (url.indexOf("/factory/island/chat?profile=generalist&chat=chat_stale&thread=objective_live") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({ objectiveId: "objective_live" }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<div></div>",
      };
    },
  });

  chat.innerHTML = chatMarkup({ objectiveId: "objective_live" });

  latestEventSource()?.emit("agent-refresh", "123");
  await flushAsync(240);

  expect(historyState.replaced).toContain("/factory?profile=generalist&thread=objective_live");
  expect(locationState.search).toBe("?profile=generalist&thread=objective_live");
});

test("factory client: internal factory links hydrate the shell inline and keep route state canonical", async () => {
  const { document, chat, sidebar, inspector, fetchCalls, historyState, locationState, latestEventSource } = await createHarness({
    fetchImpl: async (url) => {
      if (url.indexOf("/factory?profile=generalist&thread=objective_demo&panel=analysis") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => shellMarkup({
            search: "?profile=generalist&thread=objective_demo&panel=analysis",
            chatHtml: chatMarkup({ objectiveId: "objective_demo" }),
            sidebarHtml: "<div>sidebar</div>",
            inspectorHtml: "<div>inspector</div>",
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<div></div>",
      };
    },
  });

  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&thread=objective_demo&panel=analysis");
  const child = new MockElement("SPAN");
  child.parentElement = anchor;

  document.dispatchEvent(new MockEvent({
    type: "click",
    target: child,
  }));
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=generalist&thread=objective_demo&panel=analysis"]);
  expect(locationState.search).toBe("?profile=generalist&thread=objective_demo&panel=analysis");
  expect(fetchCalls.some((call) => call.url === "/factory?profile=generalist&thread=objective_demo&panel=analysis")).toBe(true);
  expect(chat.innerHTML).toContain('data-objective-id="objective_demo"');
  expect(sidebar.innerHTML).toContain("sidebar");
  expect(inspector.innerHTML).toContain("inspector");
  expect(latestEventSource()?.url).toBe("/factory/events?profile=generalist&thread=objective_demo&panel=analysis");
});

test("factory client: objective-scoped factory refresh updates the live islands for the current scope", async () => {
  const { latestEventSource, fetchCalls } = await createHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&thread=objective_current",
    fetchImpl: async (url) => {
      if (url.indexOf("/factory/island/chat?profile=generalist&chat=chat_demo&thread=objective_current") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({ chatId: "chat_demo", objectiveId: "objective_current" }),
        };
      }
      if (url.indexOf("/factory/island/sidebar?profile=generalist&chat=chat_demo&thread=objective_current") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => "<div>sidebar current</div>",
        };
      }
      if (url.indexOf("/factory/island/inspector?profile=generalist&chat=chat_demo&thread=objective_current") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => "<div>inspector current</div>",
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<div></div>",
      };
    },
  });

  latestEventSource()?.emit("factory-refresh", "objective_current");
  await flushAsync(500);

  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo&thread=objective_current")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/sidebar?profile=generalist&chat=chat_demo&thread=objective_current")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/inspector?profile=generalist&chat=chat_demo&thread=objective_current")).toBe(true);
});

test("factory client: optimistic pending transcript clears on fetch failure", async () => {
  const { textarea, form, optimistic, status, submit } = await createHarness({
    fetchImpl: async () => {
      throw new Error("Request failed.");
    },
  });

  textarea.value = "Analyze the latest objective.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));
  await flushAsync();

  expect(optimistic.innerHTML).toBe("");
  expect(status.textContent).toBe("Request failed.");
  expect(submit.disabled).toBe(false);
  expect(submit.textContent).toBe("Send");
});

test("factory client: /analyze shows immediate action feedback with optimistic transcript", async () => {
  const { textarea, form, optimistic, status, submit } = await createHarness({
    fetchImpl: () => new Promise(() => {}),
  });

  textarea.value = "/analyze";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));

  expect(status.textContent).toBe("Analyzing thread...");
  expect(submit.disabled).toBe(true);
  expect(submit.textContent).toBe("Analyzing...");
  expect(optimistic.innerHTML).toContain("/analyze");
});

test("factory client: factory-stream-token appends without extra fetches and factory-stream-reset clears stale UI", async () => {
  const { textarea, form, optimistic, streaming, fetchCalls, latestEventSource } = await createHarness({
    fetchImpl: async (url) => {
      if (url.indexOf("/factory/compose") >= 0) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({
            location: "/factory?profile=generalist&chat=chat_stream",
            live: {
              profileId: "generalist",
              chatId: "chat_stream",
              runId: "run_stream",
              jobId: "job_stream",
            },
          }),
          text: async () => "",
        };
      }
      if (url.indexOf("/factory?profile=generalist&chat=chat_stream") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => shellMarkup({
            search: "?profile=generalist&chat=chat_stream",
            chatHtml: chatMarkup({
              chatId: "chat_stream",
              activeRunId: "run_stream",
              knownRunIds: ["run_stream"],
            }),
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<div></div>",
      };
    },
  });

  textarea.value = "Stream the reply.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));
  await flushAsync();

  const streamSource = latestEventSource();
  expect(streamSource).not.toBeNull();
  const fetchCountBeforeToken = fetchCalls.length;
  streamSource?.emit("factory-stream-token", '<span data-run-id="run_stream">Hello</span>');
  await flushAsync();

  expect(streaming.innerHTML).toContain("Hello");
  streamSource?.emit("factory-stream-token", '<span data-run-id="run_stream"> world</span>');
  await flushAsync();
  expect(streaming.innerHTML).toContain("Hello");
  expect(streaming.innerHTML).toContain("world");
  expect(fetchCalls.length).toBe(fetchCountBeforeToken);
  expect(optimistic.innerHTML).toBe("");
  const fetchCountBeforeReset = fetchCalls.length;
  streamSource?.emit("factory-stream-reset", '<div id="factory-chat-streaming-content" hx-swap-oob="innerHTML"></div>');
  await flushAsync();
  expect(streaming.innerHTML).toBe("");
  expect(fetchCalls.length).toBe(fetchCountBeforeReset);
});

test("factory client: mission control hotkeys cycle panes and focus the composer", async () => {
  const { document, textarea, chatShell, inspectorShell, composerShell } = await createHarness({
    initialLocation: "http://receipt.test/factory?mode=mission-control&profile=generalist",
  });

  expect(chatShell.getAttribute("data-pane-active")).toBe("true");

  document.dispatchEvent(new MockEvent({ type: "keydown", key: "Tab", target: document.body }));
  expect(inspectorShell.getAttribute("data-pane-active")).toBe("true");

  document.dispatchEvent(new MockEvent({ type: "keydown", key: "c", target: document.body }));
  expect(composerShell.getAttribute("data-pane-active")).toBe("true");
  expect(document.activeElement).toBe(textarea);
});

test("factory client: mission control queue navigation preserves the mode and live bindings", async () => {
  const { document, sidebar, historyState, locationState, sidebarShell, fetchCalls, latestEventSource } = await createHarness({
    initialLocation: "http://receipt.test/factory?mode=mission-control&profile=generalist",
  });
  sidebar.innerHTML = [
    '<a href="/factory?mode=mission-control&profile=generalist&thread=objective_a" data-factory-objective-link="true" data-selected="true">A</a>',
    '<a href="/factory?mode=mission-control&profile=generalist&thread=objective_b" data-factory-objective-link="true" data-selected="false">B</a>',
  ].join("");

  document.dispatchEvent(new MockEvent({ type: "keydown", key: "j", target: document.body }));
  await flushAsync();

  expect(sidebarShell.getAttribute("data-pane-active")).toBe("true");
  expect(historyState.pushed).toContain("/factory?mode=mission-control&profile=generalist&thread=objective_b");
  expect(locationState.search).toBe("?mode=mission-control&profile=generalist&thread=objective_b");
  expect(latestEventSource()?.url).toBe("/factory/events?mode=mission-control&profile=generalist&thread=objective_b");

  latestEventSource()?.emit("factory-refresh", "objective_b");
  await flushAsync(500);

  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?mode=mission-control&profile=generalist&thread=objective_b")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/sidebar?mode=mission-control&profile=generalist&thread=objective_b")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/inspector?mode=mission-control&profile=generalist&thread=objective_b")).toBe(true);
});

test("factory client: mission control inspector hotkeys preserve the mode", async () => {
  const { document, inspector, historyState, locationState, inspectorShell } = await createHarness({
    initialLocation: "http://receipt.test/factory?mode=mission-control&profile=generalist&thread=objective_demo&panel=overview",
  });
  inspector.innerHTML = [
    '<a href="/factory?mode=mission-control&profile=generalist&thread=objective_demo&panel=overview" data-factory-inspector-tab="overview" aria-current="page">Overview</a>',
    '<a href="/factory?mode=mission-control&profile=generalist&thread=objective_demo&panel=analysis" data-factory-inspector-tab="analysis">Analysis</a>',
    '<a href="/factory?mode=mission-control&profile=generalist&thread=objective_demo&panel=execution" data-factory-inspector-tab="execution">Execution</a>',
  ].join("");

  document.dispatchEvent(new MockEvent({ type: "keydown", key: "3", target: document.body }));
  await flushAsync();

  expect(inspectorShell.getAttribute("data-pane-active")).toBe("true");
  expect(historyState.pushed).toContain("/factory?mode=mission-control&profile=generalist&thread=objective_demo&panel=execution");
  expect(locationState.search).toBe("?mode=mission-control&profile=generalist&thread=objective_demo&panel=execution");
});

test("factory client: mission control hotkeys do not fire while typing in the composer", async () => {
  const { document, textarea, historyState } = await createHarness({
    initialLocation: "http://receipt.test/factory?mode=mission-control&profile=generalist",
  });

  document.dispatchEvent(new MockEvent({ type: "keydown", key: "j", target: textarea }));
  await flushAsync();

  expect(historyState.pushed).toEqual([]);
});

test("factory client: profile dropdown rewrites the shell route and SSE scope", async () => {
  const { document, historyState, locationState, fetchCalls, latestEventSource, chat } = await createHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&thread=objective_demo",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => shellMarkup({
          search: parsed.search || "?profile=software&chat=chat_demo&thread=objective_demo",
          profileLabel: parsed.searchParams.get("profile") === "software" ? "Software" : "Generalist",
          chatHtml: chatMarkup({
            profileLabel: parsed.searchParams.get("profile") === "software" ? "Software" : "Generalist",
            chatId: parsed.searchParams.get("chat") || undefined,
            objectiveId: parsed.searchParams.get("thread") || undefined,
          }),
        }),
      };
    },
  });
  const select = new MockSelect();
  select.setAttribute("data-factory-profile-select", "true");
  select.value = "/factory?profile=software&chat=chat_demo&thread=objective_demo";

  document.dispatchEvent(new MockEvent({ type: "change", target: select }));
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=software&chat=chat_demo&thread=objective_demo"]);
  expect(locationState.search).toBe("?profile=software&chat=chat_demo&thread=objective_demo");
  expect(fetchCalls.some((call) => call.url === "/factory?profile=software&chat=chat_demo&thread=objective_demo")).toBe(true);
  expect(latestEventSource()?.url).toBe("/factory/events?profile=software&chat=chat_demo&thread=objective_demo");
  expect(chat.getAttribute("hx-get")).toBe("/factory/island/chat?profile=software&chat=chat_demo&thread=objective_demo");
});

}

test("factory workbench client: profile-board and objective-runtime events refresh only the matching workbench islands", async () => {
  const { backgroundSource, chatSource, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });

  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_demo");
  expect(chatSource()?.url).toBe("/factory/chat/events?profile=generalist&chat=chat_demo");

  backgroundSource()?.emit("profile-board-refresh", "generalist");
  await flushAsync(380);

  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=summary")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=activity")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=objectives")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=history")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo&objective=objective_demo")).toHaveLength(0);

  backgroundSource()?.emit("objective-runtime-refresh", "objective_demo");
  await flushAsync(380);

  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo")).toHaveLength(2);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=summary")).toHaveLength(2);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=activity")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=objectives")).toHaveLength(1);

  chatSource()?.emit("agent-refresh", "chat_demo");
  await flushAsync(220);

  expect(fetchCalls.filter((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo&objective=objective_demo")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo")).toHaveLength(0);
});

test("factory workbench client: SSE refresh routing follows data-refresh-on declarations", async () => {
  const { backgroundSource, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
    beforeBoot: ({
      workbenchHeader,
      workbenchPanel,
      workbenchSummary,
      workbenchActivity,
      workbenchObjectives,
      workbenchHistory,
      chat,
    }) => {
      workbenchHeader.setAttribute("data-refresh-on", "");
      workbenchPanel.setAttribute("data-refresh-on", "");
      workbenchSummary.setAttribute("data-refresh-on", "sse:summary-only@0");
      workbenchActivity.setAttribute("data-refresh-on", "");
      workbenchObjectives.setAttribute("data-refresh-on", "");
      workbenchHistory.setAttribute("data-refresh-on", "");
      chat.setAttribute("data-refresh-on", "");
    },
  });

  backgroundSource()?.emit("summary-only", "objective_demo");
  await flushAsync();

  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=summary")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=activity")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=objectives")).toHaveLength(0);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&block=history")).toHaveLength(0);
});

test("factory workbench client: objective navigation updates background scope without rewriting the chat stream", async () => {
  const { document, historyState, locationState, fetchCalls, backgroundSource, chatSource } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_a",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      if (parsed.pathname === "/factory/api/workbench-shell" && parsed.search === "?profile=generalist&chat=chat_demo&objective=objective_b") {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => workbenchShellSnapshot({
            search: parsed.search,
            chatHtml: chatMarkup({
              profileLabel: "Generalist",
              chatId: "chat_demo",
              objectiveId: "objective_b",
            }),
            workbenchHtml: '<div data-workbench-objective-id="objective_b">objective b</div>',
          }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => workbenchShellSnapshot({
          search: parsed.search || "?profile=generalist&chat=chat_demo&objective=objective_a",
          chatHtml: chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || "chat_demo",
            objectiveId: parsed.searchParams.get("objective") || "objective_a",
          }),
          workbenchHtml: `<div data-workbench-objective-id="${parsed.searchParams.get("objective") || "objective_a"}">workbench panel</div>`,
        }),
        text: async () => "",
      };
    },
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_b");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_b"]);
  expect(historyState.replaced).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_b");
  expect(fetchCalls.some((call) => call.url === "/factory/api/workbench-shell?profile=generalist&chat=chat_demo&objective=objective_b")).toBe(true);
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_b");
  expect(chatSource()?.url).toBe("/factory/chat/events?profile=generalist&chat=chat_demo");
});

test("factory workbench client: profile dropdown updates the page route and stream bindings together", async () => {
  const { document, historyState, locationState, fetchCalls, backgroundSource, chatSource } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => workbenchShellSnapshot({
          search: parsed.search || "?profile=software&chat=chat_demo",
          profileLabel: parsed.searchParams.get("profile") === "software" ? "Software" : "Generalist",
          chatHtml: chatMarkup({
            profileLabel: parsed.searchParams.get("profile") === "software" ? "Software" : "Generalist",
            chatId: parsed.searchParams.get("chat") || "chat_demo",
            objectiveId: parsed.searchParams.get("objective") || undefined,
          }),
          workbenchHtml: `<div data-workbench-objective-id="${parsed.searchParams.get("objective") || ""}">workbench panel</div>`,
        }),
        text: async () => "",
      };
    },
  });
  const select = new MockSelect();
  select.setAttribute("data-factory-profile-select", "true");
  select.value = "/factory?profile=software&chat=chat_demo";

  document.dispatchEvent(new MockEvent({ type: "change", target: select }));
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=software&chat=chat_demo"]);
  expect(historyState.replaced).toEqual([]);
  expect(locationState.pathname).toBe("/factory");
  expect(locationState.search).toBe("?profile=software&chat=chat_demo");
  expect(fetchCalls.some((call) => call.url === "/factory/api/workbench-shell?profile=software&chat=chat_demo")).toBe(true);
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=software&chat=chat_demo");
  expect(chatSource()?.url).toBe("/factory/chat/events?profile=software&chat=chat_demo");
});

test("factory workbench client: chat events stream tokens and refresh the transcript", async () => {
  let chatRefreshes = 0;
  const { chatSource, streaming, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      if (parsed.pathname === "/factory/island/chat") {
        chatRefreshes += 1;
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({
            profileLabel: "Generalist",
            chatId: "chat_demo",
            activeRunId: chatRefreshes === 1 ? "run_demo" : undefined,
            knownRunIds: chatRefreshes === 1 ? ["run_demo"] : [],
            terminalRunIds: chatRefreshes > 1 ? ["run_demo"] : [],
          }),
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

  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo")).toBe(true);
  expect(chatRefreshes).toBeGreaterThan(0);
});

test("factory workbench client: plain prompts stay chat-first and /obj selects the created objective", async () => {
  let composeCount = 0;
  const { textarea, form, optimistic, status, historyState, locationState, backgroundSource, chatSource, fetchCalls } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      if (parsed.pathname === "/factory/compose") {
        composeCount += 1;
        if (composeCount === 1) {
          return {
            ok: true,
            headers: { get: () => "application/json" },
            json: async () => ({
              location: "/factory?profile=generalist&chat=chat_demo",
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
            location: "/factory?profile=generalist&chat=chat_demo&objective=objective_created",
            chat: { chatId: "chat_demo" },
            selection: { objectiveId: "objective_created" },
          }),
          text: async () => "",
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

  expect(status.textContent).toBe("Sending to chat...");
  expect(optimistic.innerHTML).toContain("Sending to chat");
  await flushAsync(140);

  expect(historyState.pushed).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo");
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo");
  expect(chatSource()?.url).toBe("/factory/chat/events?profile=generalist&chat=chat_demo");
  expect(optimistic.innerHTML).toContain("Run queued. Waiting for a worker to pick it up.");
  expect(optimistic.innerHTML).toContain("job_demo");
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo")).toBe(true);

  chatSource()?.emit("agent-refresh", "run_demo");
  await flushAsync(220);
  expect(optimistic.innerHTML).toContain("Factory is running tools and preparing the reply.");

  textarea.value = "/obj Build the new deployment review objective.";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));

  expect(status.textContent).toBe("Starting objective...");
  await flushAsync();

  expect(historyState.pushed).toContain("/factory?profile=generalist&chat=chat_demo&objective=objective_created");
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_created");
  expect(optimistic.innerHTML).toContain("objective_created");
  expect(backgroundSource()?.url).toBe("/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_created");
  expect(chatSource()?.url).toBe("/factory/chat/events?profile=generalist&chat=chat_demo");
});

test("factory workbench client: inspector tab changes replace history and refresh only the chat island", async () => {
  const { document, fetchCalls, historyState, locationState } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync(220);

  expect(historyState.replaced).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat"]);
  expect(historyState.pushed).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat");
  expect(fetchCalls.filter((call) => call.url === "/factory/island/chat?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat")).toHaveLength(1);
  expect(fetchCalls.some((call) => call.url === "/factory/api/workbench-shell?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat")).toBe(false);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&inspectorTab=chat")).toBe(false);
});

test("factory workbench client: focus changes replace history and refresh summary plus activity only", async () => {
  const { document, fetchCalls, historyState, locationState } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&focusKind=task&focusId=task_1");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync(260);

  expect(historyState.replaced).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&focusKind=task&focusId=task_1"]);
  expect(historyState.pushed).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&focusKind=task&focusId=task_1");
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&focusKind=task&focusId=task_1&block=summary")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/block?profile=generalist&chat=chat_demo&objective=objective_demo&focusKind=task&focusId=task_1&block=activity")).toHaveLength(1);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo&focusKind=task&focusId=task_1")).toBe(false);
  expect(fetchCalls.some((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&focusKind=task&focusId=task_1")).toBe(false);
});

test("factory workbench client: filter changes push history and refresh header plus workbench island", async () => {
  const { document, fetchCalls, historyState, locationState } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_demo",
  });
  const anchor = new MockElement("A");
  anchor.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchor }));
  await flushAsync(260);

  expect(historyState.pushed).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed"]);
  expect(historyState.replaced).toEqual([]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed");
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench/header?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed")).toHaveLength(1);
  expect(fetchCalls.filter((call) => call.url === "/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed")).toHaveLength(1);
  expect(fetchCalls.some((call) => call.url === "/factory/api/workbench-shell?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed")).toBe(false);
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

  expect(historyState.replaced).toContain("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed&focusKind=job&focusId=job_42");
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_demo&filter=objective.completed&focusKind=job&focusId=job_42");
  expect(document.body.getAttribute("data-inspector-tab")).toBe("overview");
  expect(document.body.getAttribute("data-focus-kind")).toBe("job");
  expect(document.body.getAttribute("data-focus-id")).toBe("job_42");
  expect(optimistic.innerHTML).toContain("Queued for replay");
});

test("factory workbench client: stale shell responses are ignored after a newer scope change wins", async () => {
  let resolveObjectiveB: ((value: unknown) => void) | undefined;
  let resolveObjectiveC: ((value: unknown) => void) | undefined;
  const { document, workbenchPanel, historyState, locationState } = await createWorkbenchHarness({
    initialLocation: "http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_a",
    fetchImpl: async (url) => {
      const parsed = new URL(url, "http://receipt.test");
      if (parsed.pathname === "/factory/api/workbench-shell" && parsed.search === "?profile=generalist&chat=chat_demo&objective=objective_b") {
        return await new Promise((resolve) => {
          resolveObjectiveB = () => resolve({
            ok: true,
            headers: { get: () => "application/json" },
            json: async () => workbenchShellSnapshot({
              search: parsed.search,
              chatHtml: chatMarkup({ profileLabel: "Generalist", chatId: "chat_demo", objectiveId: "objective_b" }),
              workbenchHtml: '<div data-workbench-objective-id="objective_b">objective b</div>',
            }),
            text: async () => "",
          });
        }) as {
          readonly ok: boolean;
          readonly headers: { readonly get: (name: string) => string | null };
          readonly json: () => Promise<unknown>;
          readonly text: () => Promise<string>;
        };
      }
      if (parsed.pathname === "/factory/api/workbench-shell" && parsed.search === "?profile=generalist&chat=chat_demo&objective=objective_c") {
        return await new Promise((resolve) => {
          resolveObjectiveC = () => resolve({
            ok: true,
            headers: { get: () => "application/json" },
            json: async () => workbenchShellSnapshot({
              search: parsed.search,
              chatHtml: chatMarkup({ profileLabel: "Generalist", chatId: "chat_demo", objectiveId: "objective_c" }),
              workbenchHtml: '<div data-workbench-objective-id="objective_c">objective c</div>',
            }),
            text: async () => "",
          });
        }) as {
          readonly ok: boolean;
          readonly headers: { readonly get: (name: string) => string | null };
          readonly json: () => Promise<unknown>;
          readonly text: () => Promise<string>;
        };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => workbenchShellSnapshot({
          search: parsed.search || "?profile=generalist&chat=chat_demo&objective=objective_a",
          chatHtml: chatMarkup({
            profileLabel: "Generalist",
            chatId: parsed.searchParams.get("chat") || "chat_demo",
            objectiveId: parsed.searchParams.get("objective") || "objective_a",
          }),
          workbenchHtml: `<div data-workbench-objective-id="${parsed.searchParams.get("objective") || "objective_a"}">workbench panel</div>`,
        }),
        text: async () => "",
      };
    },
  });

  const anchorB = new MockElement("A");
  anchorB.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_b");
  const anchorC = new MockElement("A");
  anchorC.setAttribute("href", "/factory?profile=generalist&chat=chat_demo&objective=objective_c");

  document.dispatchEvent(new MockEvent({ type: "click", target: anchorB }));
  document.dispatchEvent(new MockEvent({ type: "click", target: anchorC }));

  resolveObjectiveC?.(undefined);
  await flushAsync();
  resolveObjectiveB?.(undefined);
  await flushAsync();

  expect(historyState.pushed).toEqual(["/factory?profile=generalist&chat=chat_demo&objective=objective_c"]);
  expect(locationState.search).toBe("?profile=generalist&chat=chat_demo&objective=objective_c");
  expect(workbenchPanel.innerHTML).toContain("objective c");
  expect(workbenchPanel.innerHTML).not.toContain("objective b");
});
