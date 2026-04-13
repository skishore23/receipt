import { beforeEach, expect, test } from "bun:test";

import { initFactoryPreviewBrowser } from "../../src/client/factory-preview-runtime";

type Listener = (event: MockEvent) => void;

class MockEvent {
  defaultPrevented = false;
  type = "";
  target: unknown;
  currentTarget: unknown;
  key?: string;
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

  add(...values: ReadonlyArray<string>) {
    values.forEach((value) => this.classes.add(value));
  }

  remove(...values: ReadonlyArray<string>) {
    values.forEach((value) => this.classes.delete(value));
  }

  contains(value: string) {
    return this.classes.has(value);
  }
}

class MockElement {
  id = "";
  open = false;
  value = "";
  disabled = false;
  textContent = "";
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  dataset: Record<string, string> = {};
  style: Record<string, string> & { setProperty: (name: string, value: string) => void } = {
    setProperty(name: string, value: string) {
      this[name] = value;
    },
  };
  classList = new MockClassList();
  parentElement: MockElement | null = null;
  listeners = new Map<string, Array<Listener>>();
  private readonly attributes = new Map<string, string>();
  private inner = "";

  constructor(readonly tagName: string) {}

  get innerHTML() {
    return this.inner;
  }

  set innerHTML(value: string) {
    this.inner = value;
  }

  get outerHTML() {
    return this.inner;
  }

  set outerHTML(value: string) {
    this.inner = value;
  }

  addEventListener(type: string, handler: Listener) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatchEvent(event: MockEvent) {
    event.target = event.target ?? this;
    event.currentTarget = this;
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
    return !event.defaultPrevented;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  focus() {}

  setSelectionRange(_start: number, _end: number) {}

  scrollTo(options: { readonly top?: number }) {
    this.scrollTop = options.top ?? this.scrollTop;
  }

  closest(selector: string) {
    let node: MockElement | null = this;
    while (node) {
      if (
        selector === "[data-preview-command],[data-preview-drawer-toggle],[data-preview-drawer-close]"
        && (
          node.hasAttribute("data-preview-command")
          || node.hasAttribute("data-preview-drawer-toggle")
          || node.hasAttribute("data-preview-drawer-close")
        )
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }
}

class MockButton extends MockElement {
  constructor() {
    super("BUTTON");
  }
}

class MockInput extends MockElement {
  constructor() {
    super("INPUT");
  }
}

class MockTextArea extends MockElement {
  constructor() {
    super("TEXTAREA");
  }
}

class MockForm extends MockElement {
  action = "/factory-preview/compose?profile=generalist&chat=chat_demo&objective=objective_demo";
  method = "POST";

  constructor() {
    super("FORM");
  }
}

class MockSelect extends MockElement {
  selectedOptions: Array<{ readonly textContent: string | null }> = [{ textContent: "Generalist" }];

  constructor() {
    super("SELECT");
  }
}

class MockDetails extends MockElement {
  constructor() {
    super("DETAILS");
  }
}

class MockSessionStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

class MockFormData {
  constructor(readonly form?: MockForm) {}
}

class MockWebSocket {
  readonly listeners = new Map<string, Array<(event: MockEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, handler: (event: MockEvent) => void) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  emit(type: string, data = "") {
    if (this.closed) return;
    const event = type === "message"
      ? new MockEvent({ type, data })
      : type === "open" || type === "error" || type === "close"
        ? new MockEvent({ type })
        : new MockEvent({
          type: "message",
          data: JSON.stringify({
            kind: "event",
            topic: "agent",
            event: type,
            data,
          }),
        });
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
  }

  close() {
    this.closed = true;
  }
}

type FetchCall = {
  readonly url: string;
  readonly headers?: HeadersInit;
  readonly body?: unknown;
};

type PreviewHarness = {
  readonly body: MockElement;
  readonly document: {
    readonly body: MockElement;
    readyState: string;
    visibilityState: "hidden" | "visible";
    addEventListener: (type: string, handler: Listener, capture?: boolean) => void;
    dispatchEvent: (event: MockEvent) => void;
    getElementById: (id: string) => MockElement | null;
    querySelectorAll: (selector: string) => ReadonlyArray<MockElement>;
  };
  readonly window: {
    readonly location: {
      href: string;
      origin: string;
      pathname: string;
      assign: (url: string) => void;
    };
    readonly sessionStorage: MockSessionStorage;
    readonly WebSocket: typeof MockWebSocket;
    readonly FormData: typeof MockFormData;
    innerWidth: number;
    addEventListener: (type: string, handler: Listener) => void;
    dispatchEvent: (event: MockEvent) => void;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  readonly fetchCalls: FetchCall[];
  readonly liveSource: MockWebSocket;
  readonly elements: Record<string, MockElement>;
  readonly storage: MockSessionStorage;
};

const flushAsync = async (delayMs = 0) => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, delayMs));
};

const previewDraftKey = "factory-preview:draft:generalist:chat_demo:objective_demo";

const createHarness = (options?: {
  readonly fetchResponseByUrl?: (url: string) => Response;
  readonly sessionDraft?: string;
  readonly loaderStallMs?: number;
}) => {
  const elementMap = new Map<string, MockElement>();
  const documentListeners = new Map<string, Array<Listener>>();
  const windowListeners = new Map<string, Array<Listener>>();
  const fetchCalls: FetchCall[] = [];
  const storage = new MockSessionStorage();
  if (options?.sessionDraft) storage.setItem(previewDraftKey, options.sessionDraft);

  const register = <T extends MockElement>(element: T, id?: string): T => {
    if (id) element.id = id;
    if (element.id) elementMap.set(element.id, element);
    return element;
  };

  const createIsland = (
    id: string,
    path: string,
    refreshOn: string,
    extra?: { readonly drawerSection?: string; readonly transcriptSignature?: string; readonly lastItemKind?: string },
  ) => {
    const element = register(new MockElement("DIV"), id);
    element.setAttribute("data-refresh-path", path);
    element.setAttribute("data-refresh-on", refreshOn);
    element.setAttribute("data-refresh-swap", "innerHTML");
    element.setAttribute("data-island-version", `${id}:v1`);
    if (extra?.drawerSection) element.setAttribute("data-preview-drawer-section", extra.drawerSection);
    if (id === "factory-preview-timeline") {
      const root = register(new MockElement("DIV"), "factory-preview-timeline-root");
      root.setAttribute("data-active-profile-label", "Generalist");
      root.setAttribute("data-transcript-signature", extra?.transcriptSignature ?? "sig-initial");
      root.setAttribute("data-last-item-kind", extra?.lastItemKind ?? "assistant");
    }
    return element;
  };

  const body = register(new MockElement("BODY"));
  body.setAttribute("data-factory-preview", "true");
  body.setAttribute("data-shell-base", "/factory-preview");
  body.setAttribute("data-profile-id", "generalist");
  body.setAttribute("data-chat-id", "chat_demo");
  body.setAttribute("data-objective-id", "objective_demo");
  if (typeof options?.loaderStallMs === "number") {
    body.setAttribute("data-loader-stall-ms", String(options.loaderStallMs));
  }

  const layout = register(new MockElement("DIV"), "factory-preview-layout");

  const drawer = register(new MockElement("ASIDE"), "factory-preview-drawer");
  drawer.style.display = "none";

  const backdrop = register(new MockElement("DIV"), "factory-preview-drawer-backdrop");
  backdrop.style.display = "none";

  const profileSelect = register(new MockSelect(), "factory-preview-profile-select");
  profileSelect.value = "/factory-preview?profile=generalist&chat=chat_demo&objective=objective_demo";

  const composer = register(new MockForm(), "factory-preview-composer");

  const prompt = register(new MockTextArea(), "factory-preview-prompt");

  const composerStatus = register(new MockElement("DIV"), "factory-preview-composer-status");
  composerStatus.classList.add("hidden");

  const submit = register(new MockButton(), "factory-preview-composer-submit");
  submit.textContent = "Send";

  const currentJob = register(new MockInput(), "factory-preview-current-job");

  const ephemeral = register(new MockElement("DIV"), "factory-preview-ephemeral");

  const drawerToggle = register(new MockButton(), "factory-preview-drawer-toggle");
  drawerToggle.setAttribute("data-preview-drawer-toggle", "true");

  const drawerClose = register(new MockButton(), "factory-preview-drawer-close");
  drawerClose.setAttribute("data-preview-drawer-close", "true");

  const drawerShellProperties = register(new MockDetails(), "factory-preview-drawer-shell-properties");
  drawerShellProperties.open = true;

  const drawerShellSelfImprovement = register(new MockDetails(), "factory-preview-drawer-shell-self-improvement");
  drawerShellSelfImprovement.open = true;

  const drawerShellTasks = register(new MockDetails(), "factory-preview-drawer-shell-tasks");
  drawerShellTasks.open = false;

  createIsland(
    "factory-preview-header",
    "/factory-preview/island/header?profile=generalist&chat=chat_demo&objective=objective_demo",
    "live:profile-board-refresh@180,live:objective-runtime-refresh@180",
  );
  createIsland(
    "factory-preview-rail",
    "/factory-preview/island/rail?profile=generalist&chat=chat_demo&objective=objective_demo",
    "live:profile-board-refresh@180,live:objective-runtime-refresh@220",
  );
  createIsland(
    "factory-preview-focus",
    "/factory-preview/island/focus?profile=generalist&chat=chat_demo&objective=objective_demo",
    "live:objective-runtime-refresh@160,live:profile-board-refresh@220",
  );
  createIsland(
    "factory-preview-timeline",
    "/factory-preview/island/timeline?profile=generalist&chat=chat_demo&objective=objective_demo",
    "live:agent-refresh@160,live:objective-runtime-refresh@220",
  );
  createIsland(
    "factory-preview-drawer-properties",
    "/factory-preview/island/drawer/properties?profile=generalist&chat=chat_demo&objective=objective_demo",
    "live:objective-runtime-refresh@220",
    { drawerSection: "properties" },
  );
  createIsland(
    "factory-preview-drawer-self-improvement",
    "/factory-preview/island/drawer/self-improvement?profile=generalist&chat=chat_demo&objective=objective_demo",
    "live:objective-runtime-refresh@220",
    { drawerSection: "self-improvement" },
  );
  createIsland(
    "factory-preview-drawer-tasks",
    "/factory-preview/island/drawer/tasks?profile=generalist&chat=chat_demo&objective=objective_demo",
    "live:objective-runtime-refresh@220",
    { drawerSection: "tasks" },
  );

  const document = {
    body,
    readyState: "complete",
    visibilityState: "visible" as const,
    addEventListener: (type: string, handler: Listener) => {
      const handlers = documentListeners.get(type) ?? [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
    dispatchEvent: (event: MockEvent) => {
      for (const handler of documentListeners.get(event.type) ?? []) handler(event);
    },
    getElementById: (id: string) => elementMap.get(id) ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === "[data-refresh-on][data-refresh-path][id]") {
        return [...elementMap.values()].filter((element) =>
          element.id
          && element.hasAttribute("data-refresh-on")
          && element.hasAttribute("data-refresh-path")
        );
      }
      if (selector === "[data-preview-drawer-toggle='true']") {
        return [...elementMap.values()].filter((element) =>
          element.getAttribute("data-preview-drawer-toggle") === "true"
        );
      }
      return [];
    },
  };

  const location = {
    href: "http://receipt.test/factory-preview?profile=generalist&chat=chat_demo&objective=objective_demo",
    origin: "http://receipt.test",
    pathname: "/factory-preview",
    assign(url: string) {
      const parsed = new URL(url, this.href);
      this.href = parsed.href;
      this.pathname = parsed.pathname;
    },
  };

  let liveSource: MockWebSocket | null = null;

  const WebSocketCapture = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      liveSource = this;
    }
  };

  const windowObject = {
    location,
    sessionStorage: storage,
    WebSocket: WebSocketCapture,
    FormData: MockFormData,
    innerWidth: 1440,
    addEventListener: (type: string, handler: Listener) => {
      const handlers = windowListeners.get(type) ?? [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
    dispatchEvent: (event: MockEvent) => {
      for (const handler of windowListeners.get(event.type) ?? []) handler(event);
    },
    setTimeout,
    clearTimeout,
  };

  const fetchImpl = async (url: string, init?: RequestInit) => {
    fetchCalls.push({
      url,
      headers: init?.headers,
      body: init?.body,
    });
    return options?.fetchResponseByUrl?.(url) ?? new Response(`<div>${url}</div>`, { status: 200 });
  };

  Reflect.set(globalThis, "window", windowObject);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "fetch", fetchImpl);
  Reflect.set(globalThis, "WebSocket", WebSocketCapture);
  Reflect.set(globalThis, "Element", MockElement);
  Reflect.set(globalThis, "HTMLElement", MockElement);
  Reflect.set(globalThis, "HTMLInputElement", MockInput);
  Reflect.set(globalThis, "HTMLTextAreaElement", MockTextArea);
  Reflect.set(globalThis, "HTMLButtonElement", MockButton);
  Reflect.set(globalThis, "HTMLFormElement", MockForm);
  Reflect.set(globalThis, "HTMLSelectElement", MockSelect);
  Reflect.set(globalThis, "HTMLDetailsElement", MockDetails);
  Reflect.set(globalThis, "FormData", MockFormData);

  initFactoryPreviewBrowser();

  if (!liveSource) {
    throw new Error("Preview runtime did not connect a WebSocket.");
  }

  return {
    body,
    document,
    window: windowObject,
    fetchCalls,
    liveSource,
    elements: Object.fromEntries(elementMap.entries()),
    storage,
  } satisfies PreviewHarness;
};

beforeEach(() => {
  for (const key of [
    "window",
    "document",
    "fetch",
    "WebSocket",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "HTMLFormElement",
    "HTMLSelectElement",
    "HTMLDetailsElement",
    "FormData",
  ]) {
    Reflect.deleteProperty(globalThis, key);
  }
});

test("factory preview client: initial websocket open does not re-fetch the rendered islands", async () => {
  const harness = createHarness();

  expect(harness.fetchCalls).toHaveLength(0);

  harness.liveSource.emit("open");
  await flushAsync(20);

  expect(harness.fetchCalls).toHaveLength(0);
});

test("factory preview client: live init frames do not trigger refreshes", async () => {
  const harness = createHarness();

  harness.liveSource.emit("open");
  await flushAsync(20);

  harness.liveSource.emit("profile-board-refresh", "init");
  harness.liveSource.emit("objective-runtime-refresh", "init");
  harness.liveSource.emit("agent-refresh", "init");
  await flushAsync(260);

  expect(harness.fetchCalls).toHaveLength(0);
});

test("factory preview client: job-refresh does not update preview islands while the drawer is closed", async () => {
  const harness = createHarness();

  harness.liveSource.emit("open");
  await flushAsync(20);

  harness.liveSource.emit("job-refresh");
  await flushAsync(260);

  expect(harness.fetchCalls).toHaveLength(0);
});

test("factory preview client: opening the drawer refreshes only open drawer sections", async () => {
  const harness = createHarness();

  harness.liveSource.emit("open");
  await flushAsync(20);
  harness.fetchCalls.length = 0;

  harness.document.dispatchEvent(new MockEvent({
    type: "click",
    target: harness.elements["factory-preview-drawer-toggle"],
  }));
  await flushAsync(40);

  expect(harness.elements["factory-preview-drawer"].style.display).toBe("block");
  expect(harness.fetchCalls.map((call) => call.url)).toEqual([
    "/factory-preview/island/drawer/properties?profile=generalist&chat=chat_demo&objective=objective_demo",
    "/factory-preview/island/drawer/self-improvement?profile=generalist&chat=chat_demo&objective=objective_demo",
  ]);
});

test("factory preview client: restores the local draft and clears it after a successful compose", async () => {
  const harness = createHarness({
    sessionDraft: "/react tighten the tests",
    fetchResponseByUrl: (url) => {
      if (url.startsWith("/factory-preview/compose")) {
        return new Response(JSON.stringify({
          live: { runId: "run_preview_01", jobId: "job_preview_01" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`<div>${url}</div>`, { status: 200 });
    },
  });

  const prompt = harness.elements["factory-preview-prompt"] as MockTextArea;
  const form = harness.elements["factory-preview-composer"] as MockForm;
  const status = harness.elements["factory-preview-composer-status"];
  const submit = harness.elements["factory-preview-composer-submit"] as MockButton;

  expect(prompt.value).toBe("/react tighten the tests");

  form.dispatchEvent(new MockEvent({
    type: "submit",
    target: form,
  }));
  await flushAsync(40);

  expect(harness.fetchCalls.some((call) => call.url.startsWith("/factory-preview/compose"))).toBe(true);
  expect(prompt.value).toBe("");
  expect(status.classList.contains("hidden")).toBe(true);
  expect(status.textContent).toBe("");
  expect(submit.textContent).toBe("Send");
  expect(harness.storage.getItem(previewDraftKey)).toBe(null);
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("/react tighten the tests");
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("Working");
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).not.toContain("factory-ephemeral-placeholder");
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).not.toContain("factory-stream-cursor");
});

test("factory preview client: loading transitions stay in one inline preview surface", async () => {
  const harness = createHarness({
    fetchResponseByUrl: (url) => {
      if (url.startsWith("/factory-preview/compose")) {
        return new Response(JSON.stringify({
          live: { runId: "run_preview_02", jobId: "job_preview_02" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`<div>${url}</div>`, { status: 200 });
    },
  });

  const prompt = harness.elements["factory-preview-prompt"] as MockTextArea;
  const form = harness.elements["factory-preview-composer"] as MockForm;
  prompt.value = "please continue";

  form.dispatchEvent(new MockEvent({
    type: "submit",
    target: form,
  }));
  await flushAsync(40);

  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("Working");
  expect(harness.elements["factory-preview-composer-status"].classList.contains("hidden")).toBe(true);

  harness.liveSource.emit("agent-phase", JSON.stringify({
    runId: "run_preview_02",
    phase: "planning",
    summary: "Preparing the next update.",
  }));
  await flushAsync(20);

  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("Planning");
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("Preparing the next update.");

  harness.liveSource.emit("agent-token", JSON.stringify({
    runId: "run_preview_02",
    delta: "Draft reply",
  }));
  await flushAsync(20);

  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("Streaming");
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("Draft reply");
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).not.toContain("factory-ephemeral-placeholder");
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).not.toContain("factory-stream-cursor");
});

test("factory preview client: stalled loader replaces indefinite pending states", async () => {
  const harness = createHarness({
    loaderStallMs: 1000,
    fetchResponseByUrl: (url) => {
      if (url.startsWith("/factory-preview/compose")) {
        return new Response(JSON.stringify({
          live: { runId: "run_preview_03", jobId: "job_preview_03" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`<div>${url}</div>`, { status: 200 });
    },
  });

  const prompt = harness.elements["factory-preview-prompt"] as MockTextArea;
  const form = harness.elements["factory-preview-composer"] as MockForm;
  prompt.value = "hold and wait";

  form.dispatchEvent(new MockEvent({
    type: "submit",
    target: form,
  }));
  await flushAsync(1100);

  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("Stalled");
  expect(harness.elements["factory-preview-ephemeral"].innerHTML).toContain("No recent Factory update arrived");
});

test("factory preview client: timeline refresh preserves chat scroll position away from bottom", async () => {
  let timelineRoot: MockElement | null = null;
  const harness = createHarness({
    fetchResponseByUrl: (url) => {
      if (url.startsWith("/factory-preview/island/timeline")) {
        if (timelineRoot) {
          timelineRoot.scrollHeight = 1600;
          timelineRoot.clientHeight = 400;
          timelineRoot.setAttribute("data-transcript-signature", "sig-next");
        }
        return new Response(`<section id="factory-preview-timeline">
          <div id="factory-preview-timeline-root" data-transcript-signature="sig-next" data-last-item-kind="assistant"></div>
        </section>`, { status: 200 });
      }
      return new Response(`<div>${url}</div>`, { status: 200 });
    },
  });

  timelineRoot = harness.elements["factory-preview-timeline-root"];
  timelineRoot.scrollHeight = 1200;
  timelineRoot.clientHeight = 400;
  timelineRoot.scrollTop = 320;

  harness.liveSource.emit("open");
  await flushAsync(20);
  harness.fetchCalls.length = 0;

  harness.liveSource.emit("agent-refresh");
  await flushAsync(260);

  expect(harness.fetchCalls.map((call) => call.url)).toEqual([
    "/factory-preview/island/timeline?profile=generalist&chat=chat_demo&objective=objective_demo",
  ]);
  expect(timelineRoot.scrollTop).toBe(320);
});
