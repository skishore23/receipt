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
  addEventListener(type: string, handler: Listener) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  dispatchEvent(event: MockEvent) {
    event.target = event.target ?? this;
    event.currentTarget = this;
    for (const handler of this.listeners.get(event.type as string) ?? []) handler(event);
    return !event.defaultPrevented;
  }
  focus() {}
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
  contains(node: unknown) { return node === this; }
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

  const scroll = new MockElement("DIV");
  scroll.id = "factory-chat-scroll";
  scroll.scrollHeight = 640;
  scroll.clientHeight = 320;

  const chat = new MockElement("DIV");
  chat.id = "factory-chat";
  chat.setAttribute("data-active-profile-label", "Generalist");
  chat.innerHTML = chatMarkup();

  const streaming = new MockElement("DIV");
  streaming.id = "factory-chat-streaming";

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

  const form = new MockForm();
  form.id = "factory-composer";
  form.setAttribute("data-composer-commands", COMMANDS);

  const elements = new Map<string, MockElement>([
    [scroll.id, scroll],
    [chat.id, chat],
    [streaming.id, streaming],
    [optimistic.id, optimistic],
    [textarea.id, textarea],
    [popup.id, popup],
    [status.id, status],
    [submit.id, submit],
    [currentJob.id, currentJob],
    [shellTitle.id, shellTitle],
    [shellPills.id, shellPills],
    [sidebar.id, sidebar],
    [inspector.id, inspector],
    [form.id, form],
  ]);

  const body = new MockElement("BODY");
  body.setAttribute("data-focus-kind", "");
  body.setAttribute("data-focus-id", "");

  const documentListeners = new Map<string, Array<Listener>>();
  const document = {
    readyState: "complete",
    body,
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
  const initialLocation = new URL(options.initialLocation ?? "http://receipt.test/factory?profile=generalist");
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
    EventSource: MockEventSource,
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
      return {
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => chatMarkup(),
      };
    },
    requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout,
    clearTimeout,
    history: historyState,
    location: locationState,
    addEventListener: (type: string, handler: Listener) => {
      const handlers = windowListeners.get(type) ?? [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
  } as Record<string, unknown>;
  sandbox.window = sandbox;
  vm.runInNewContext(await loadClient(), sandbox);
  return {
    document,
    textarea,
    scroll,
    popup,
    optimistic,
    streaming,
    status,
    submit,
    form,
    currentJob,
    chat,
    sidebar,
    inspector,
    fetchCalls,
    locationState,
    historyState,
    latestEventSource: () => MockEventSource.instances.at(-1) ?? null,
  };
};

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
      if (url.indexOf("/factory/island/chat") >= 0) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({ chatId: "chat_optimistic" }),
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

test("factory client: stale island refreshes do not clear the optimistic transcript", async () => {
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
      if (url.indexOf("/factory/island/chat") >= 0) {
        chatRefreshCount += 1;
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatRefreshCount > 1
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
  const { document, fetchCalls, historyState, locationState } = await createHarness({
    fetchImpl: async (url) => {
      if (url.indexOf("/factory/island/chat?profile=generalist&thread=objective_demo&panel=analysis") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({ objectiveId: "objective_demo" }),
        };
      }
      if (url.indexOf("/factory/island/sidebar?profile=generalist&thread=objective_demo&panel=analysis") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => "<div>sidebar</div>",
        };
      }
      if (url.indexOf("/factory/island/inspector?profile=generalist&thread=objective_demo&panel=analysis") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => "<div>inspector</div>",
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
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=generalist&thread=objective_demo&panel=analysis")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/sidebar?profile=generalist&thread=objective_demo&panel=analysis")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/inspector?profile=generalist&thread=objective_demo&panel=analysis")).toBe(true);
});

test("factory client: unrelated factory refresh updates only the sidebar", async () => {
  const { latestEventSource, fetchCalls } = await createHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => "text/html" },
      json: async () => ({}),
      text: async () => chatMarkup({ chatId: "chat_demo", objectiveId: "objective_current", activeRunId: "run_current", knownRunIds: ["run_current"] }),
    }),
  });

  latestEventSource()?.emit("factory-refresh", "objective_other");
  await flushAsync(500);

  expect(fetchCalls.some((call) => call.url === "/factory/island/sidebar?profile=generalist")).toBe(true);
  expect(fetchCalls.some((call) => call.url === "/factory/island/chat?profile=generalist")).toBe(false);
  expect(fetchCalls.some((call) => call.url === "/factory/island/inspector?profile=generalist")).toBe(false);
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

test("factory client: /analyze shows immediate action feedback without optimistic transcript", async () => {
  const { textarea, form, optimistic, status, submit } = await createHarness({
    fetchImpl: () => new Promise(() => {}),
  });

  textarea.value = "/analyze";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));

  expect(status.textContent).toBe("Opening analysis...");
  expect(submit.disabled).toBe(true);
  expect(submit.textContent).toBe("Opening...");
  expect(optimistic.innerHTML).toBe("");
});

test("factory client: successful /analyze applies the new route inline", async () => {
  const { textarea, form, optimistic, status, submit, locationState, historyState } = await createHarness({
    fetchImpl: async (url) => {
      if (url.indexOf("/factory/compose") >= 0) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({ location: "/factory?profile=generalist&thread=objective_demo&panel=analysis" }),
          text: async () => "",
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

  textarea.value = "/analyze";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form }));
  await flushAsync();

  expect(status.textContent).toBe("");
  expect(submit.disabled).toBe(false);
  expect(submit.textContent).toBe("Send");
  expect(optimistic.innerHTML).toBe("");
  expect(locationState.assigned).toEqual([]);
  expect(historyState.pushed).toEqual(["/factory?profile=generalist&thread=objective_demo&panel=analysis"]);
});

test("factory client: agent-token updates stream only in chat and clears when the run becomes terminal", async () => {
  let terminal = false;
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
      if (url.indexOf("/factory/island/chat") >= 0) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({}),
          text: async () => chatMarkup({
            chatId: "chat_stream",
            activeRunId: terminal ? "run_stream" : "",
            knownRunIds: terminal ? ["run_stream"] : [],
            terminalRunIds: terminal ? ["run_stream"] : [],
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
  streamSource?.emit("agent-token", JSON.stringify({ runId: "run_stream", delta: "Hello world" }));
  await flushAsync();

  expect(streaming.innerHTML).toContain("Hello world");
  expect(fetchCalls.length).toBe(fetchCountBeforeToken);

  const sidebarFetchesBeforeRefresh = fetchCalls.filter((call) => call.url.indexOf("/factory/island/sidebar") >= 0 && call.url.indexOf("chat_stream") >= 0).length;
  const inspectorFetchesBeforeRefresh = fetchCalls.filter((call) => call.url.indexOf("/factory/island/inspector") >= 0 && call.url.indexOf("chat_stream") >= 0).length;
  const chatFetchesBeforeRefresh = fetchCalls.filter((call) => call.url.indexOf("/factory/island/chat?profile=generalist&chat=chat_stream") >= 0).length;
  terminal = true;
  streamSource?.emit("agent-refresh", "123");
  await flushAsync(240);

  expect(streaming.innerHTML).toBe("");
  expect(optimistic.innerHTML).toBe("");
  expect(fetchCalls.filter((call) => call.url.indexOf("/factory/island/chat?profile=generalist&chat=chat_stream") >= 0).length).toBeGreaterThan(chatFetchesBeforeRefresh);
  expect(fetchCalls.filter((call) => call.url.indexOf("/factory/island/sidebar") >= 0 && call.url.indexOf("chat_stream") >= 0).length).toBe(sidebarFetchesBeforeRefresh);
  expect(fetchCalls.filter((call) => call.url.indexOf("/factory/island/inspector") >= 0 && call.url.indexOf("chat_stream") >= 0).length).toBe(inspectorFetchesBeforeRefresh);
});
