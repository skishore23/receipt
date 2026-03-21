import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const CLIENT_PATH = path.join(ROOT, "src", "client", "factory-client.js");
const COMMANDS = JSON.stringify([
  { name: "help", label: "/help", usage: "/help or /?", description: "Show slash command help." },
  { name: "follow-up", label: "/follow-up", usage: "/follow-up [note]", description: "Send a follow-up note to the active job." },
  { name: "steer", label: "/steer", usage: "/steer [problem]", description: "Send guidance to the active job." },
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
  id = "";
  classList = new MockClassList();
  style: Record<string, string> = {};
  textContent = "";
  innerHTML = "";
  value = "";
  disabled = false;
  hidden = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<Listener>>();
  parentElement: MockElement | null = null;
  selectionStart = 0;
  selectionEnd = 0;
  constructor(readonly tagName: string) {}
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
  closest() { return null; }
  contains(node: unknown) { return node === this; }
  querySelector() { return null; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
}

class MockButton extends MockElement {
  constructor() { super("BUTTON"); }
}

class MockTextArea extends MockElement {
  scrollHeight = 140;
  constructor() { super("TEXTAREA"); }
}

class MockForm extends MockElement {
  action = "/factory/compose?profile=generalist";
  method = "post";
  constructor() { super("FORM"); }
  requestSubmit() { this.dispatchEvent(new MockEvent({ type: "submit", target: this } as never)); }
}

const loadClient = () => fs.readFileSync(CLIENT_PATH, "utf-8");

const createHarness = () => {
  const textarea = new MockTextArea();
  textarea.id = "factory-prompt";
  textarea.value = "/";

  const popup = new MockElement("DIV");
  popup.id = "factory-composer-completions";

  const status = new MockElement("DIV");
  status.id = "factory-composer-status";

  const submit = new MockButton();
  submit.id = "factory-composer-submit";

  const form = new MockForm();
  form.id = "factory-composer";
  form.setAttribute("data-composer-commands", COMMANDS);

  const elements = new Map<string, MockElement>([
    [textarea.id, textarea],
    [popup.id, popup],
    [status.id, status],
    [submit.id, submit],
    [form.id, form],
  ]);

  const body = new MockElement("BODY");
  body.dataset = { objective: "", panel: "overview", focusKind: "mission", focusId: "" } as Record<string, string>;

  const document = {
    readyState: "complete",
    body,
    addEventListener: (_type: string, handler: Listener) => handler(new MockEvent({ type: "DOMContentLoaded" } as never)),
    querySelector: (selector: string) => selector === "[data-factory-chat]" ? {} : null,
    getElementById: (id: string) => elements.get(id) ?? null,
  };

  const fetchCalls: Array<{ readonly url: string; readonly body: FormData }> = [];
  const sandbox = {
    document,
    window: undefined as unknown,
    HTMLTextAreaElement: MockTextArea,
    HTMLFormElement: MockForm,
    HTMLButtonElement: MockButton,
    HTMLElement: MockElement,
    Element: MockElement,
    Node: MockElement,
    CustomEvent: class { constructor(public readonly type: string, public readonly detail?: unknown) {} },
    Event: class extends MockEvent { constructor(type: string, init: Partial<MockEvent> = {}) { super({ ...init, type } as never); } },
    FormData: class {
      constructor(public readonly form: MockForm) {}
    },
    fetch: async (url: string, init: { readonly body?: FormData }) => {
      fetchCalls.push({ url, body: init.body as FormData });
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ location: "/factory?profile=generalist&run=run_01" }),
        text: async () => "",
      };
    },
    requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout,
    clearTimeout,
    history: { replaceState() {} },
    location: { assign() {}, reload() {} },
  } as Record<string, unknown>;
  sandbox.window = sandbox;
  vm.runInNewContext(loadClient(), sandbox);
  return { textarea, popup, status, submit, form, fetchCalls };
};

test("factory client: autocomplete opens, filters, navigates, inserts, and submits", async () => {
  const { textarea, popup, status, submit, form, fetchCalls } = createHarness();
  textarea.value = "/f";
  textarea.selectionStart = 2;
  textarea.dispatchEvent(new MockEvent({ type: "input", target: textarea } as never));
  expect(textarea.getAttribute("aria-expanded")).toBe("true");
  expect(popup.classList.contains("hidden")).toBe(false);
  expect(popup.innerHTML).toContain("/follow-up");
  expect(popup.innerHTML).not.toContain("/steer");

  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "ArrowDown", target: textarea } as never));
  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "Enter", target: textarea } as never));
  expect(textarea.value).toBe("/follow-up ");

  textarea.value = "/follow-up add more logs";
  textarea.selectionStart = textarea.value.length;
  textarea.dispatchEvent(new MockEvent({ type: "keydown", key: "Escape", target: textarea } as never));
  expect(textarea.getAttribute("aria-expanded")).toBe("false");

  textarea.value = "/follow-up keep receipts";
  textarea.selectionStart = textarea.value.length;
  form.dispatchEvent(new MockEvent({ type: "submit", target: form } as never));
  await Promise.resolve();
  await Promise.resolve();
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]?.url).toContain("/factory/compose?profile=generalist");
  expect(status.textContent).toBe("");
  expect(submit.disabled).toBe(true);
});
