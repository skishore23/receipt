export type ReactiveRefreshKind = "live" | "body";

export type ReactiveRefreshSpec = {
  readonly kind: ReactiveRefreshKind;
  readonly event: string;
  readonly throttleMs?: number;
};

export type ReactiveRefreshTarget<
  SourceKey extends string,
  TargetKey extends string,
  ScopeKey = string,
> = {
  readonly key: TargetKey;
  readonly source?: SourceKey | ReadonlyArray<SourceKey>;
  readonly element: () => HTMLElement | null;
  readonly queue: (delayMs: number, scopeKey?: ScopeKey) => void;
};

type ReactivePushDecision<
  SourceKey extends string,
  TargetKey extends string,
> = {
  readonly sourceKey: SourceKey;
  readonly targetKey: TargetKey;
  readonly target: HTMLElement;
  readonly eventName: string;
  readonly kind: ReactiveRefreshKind;
  readonly event: Event | MessageEvent<string>;
};

type ConnectedReactiveSource = {
  readonly signature: string;
  readonly liveSource: {
    addEventListener: (type: string, handler: (event: Event | MessageEvent<string>) => void) => void;
    close: () => void;
  };
};

const parseReactiveRefreshSpec = (value: string): ReactiveRefreshSpec | undefined => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "load") return undefined;
  const descriptorMatch = trimmed.match(/^(live|sse|body):([^@]+?)(?:@(\d+))?$/i);
  if (descriptorMatch && descriptorMatch[1] && descriptorMatch[2]) {
    const throttleMs = descriptorMatch[3] ? Number(descriptorMatch[3]) : undefined;
    return {
      kind: descriptorMatch[1].toLowerCase() === "body" ? "body" : "live",
      event: descriptorMatch[2].trim(),
      throttleMs: typeof throttleMs === "number" && Number.isFinite(throttleMs) ? throttleMs : undefined,
    };
  }
  const triggerMatch = trimmed.match(/^(?:live|sse):([a-z0-9:-]+)(?:\s+throttle:(\d+)ms)?$/i);
  if (triggerMatch && triggerMatch[1]) {
    const throttleMs = triggerMatch[2] ? Number(triggerMatch[2]) : undefined;
    return {
      kind: "live",
      event: triggerMatch[1],
      throttleMs: typeof throttleMs === "number" && Number.isFinite(throttleMs) ? throttleMs : undefined,
    };
  }
  const bodyMatch = trimmed.match(/^([a-z0-9:-]+)\s+from:body$/i);
  if (bodyMatch && bodyMatch[1]) {
    return {
      kind: "body",
      event: bodyMatch[1],
    };
  }
  return undefined;
};

export const readReactiveRefreshSpecs = (target: Element | null): ReadonlyArray<ReactiveRefreshSpec> => {
  if (!(target instanceof HTMLElement)) return [];
  const descriptor = target.getAttribute("data-refresh-on");
  const raw = descriptor !== null ? descriptor : target.getAttribute("hx-trigger");
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => parseReactiveRefreshSpec(part))
    .flatMap((spec) => spec ? [spec] : []);
};

export const readReactiveRefreshPath = (target: Element | null): string | null => {
  if (!(target instanceof HTMLElement)) return null;
  return target.getAttribute("data-refresh-path") || target.getAttribute("hx-get");
};

export const createQueuedRefreshRunner = <
  TargetKey extends string,
  ScopeKey = string,
>(
  run: (targetKey: TargetKey, scopeKey?: ScopeKey) => Promise<void>,
) => {
  const timers = new Map<TargetKey, number>();
  const inFlight = new Map<TargetKey, boolean>();
  const queued = new Map<TargetKey, boolean>();
  const queuedDelayMs = new Map<TargetKey, number>();
  const queuedScope = new Map<TargetKey, ScopeKey | undefined>();

  const queue = (targetKey: TargetKey, delayMs: number, scopeKey?: ScopeKey) => {
    const existingTimer = timers.get(targetKey);
    if (typeof existingTimer === "number") window.clearTimeout(existingTimer);
    timers.set(targetKey, window.setTimeout(() => {
      timers.delete(targetKey);
      if (inFlight.get(targetKey)) {
        queued.set(targetKey, true);
        queuedDelayMs.set(targetKey, Math.max(0, delayMs));
        queuedScope.set(targetKey, scopeKey);
        return;
      }
      inFlight.set(targetKey, true);
      run(targetKey, scopeKey).catch(() => {
        // Ignore transient refresh failures; the next event can retry.
      }).finally(() => {
        inFlight.set(targetKey, false);
        if (!queued.get(targetKey)) return;
        queued.delete(targetKey);
        const nextDelayMs = queuedDelayMs.get(targetKey) ?? Math.max(0, delayMs);
        const nextScope = queuedScope.get(targetKey);
        queuedDelayMs.delete(targetKey);
        queuedScope.delete(targetKey);
        queue(targetKey, nextDelayMs, nextScope);
      });
    }, Math.max(0, delayMs)));
  };

  const clear = () => {
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
    inFlight.clear();
    queued.clear();
    queuedDelayMs.clear();
    queuedScope.clear();
  };

  return { queue, clear };
};

export const createReactivePushRouter = <
  SourceKey extends string,
  TargetKey extends string,
  ScopeKey = string,
>(options: {
  readonly sources: ReadonlyArray<SourceKey>;
  readonly targets: () => ReadonlyArray<ReactiveRefreshTarget<SourceKey, TargetKey, ScopeKey>>;
  readonly eventPath: (sourceKey: SourceKey) => string | null;
  readonly getScopeKey?: () => ScopeKey | undefined;
  readonly ignoreLiveMessage?: (event: MessageEvent<string>) => boolean;
  readonly onLiveEvent?: (input: {
    readonly sourceKey: SourceKey;
    readonly eventName: string;
    readonly event: MessageEvent<string>;
    readonly scopeKey?: ScopeKey;
  }) => void;
  readonly onLiveSourceConnected?: (input: {
    readonly sourceKey: SourceKey;
    readonly liveSource: {
      addEventListener: (type: string, handler: (event: Event | MessageEvent<string>) => void) => void;
      close: () => void;
    };
    readonly path: string;
  }) => void;
  readonly connectLiveSource?: (path: string) => {
    addEventListener: (type: string, handler: (event: Event | MessageEvent<string>) => void) => void;
    close: () => void;
  } | null;
  readonly shouldQueue?: (
    input: ReactivePushDecision<SourceKey, TargetKey>,
  ) => boolean;
}) => {
  const defaultIgnoreLiveMessage = (event: MessageEvent<string>) => event.data === "init";
  const connectedSources = new Map<SourceKey, ConnectedReactiveSource>();
  const bodyHandlers = new Map<string, (event: Event) => void>();

  const targetMatchesSource = (
    target: ReactiveRefreshTarget<SourceKey, TargetKey, ScopeKey>,
    sourceKey: SourceKey,
  ): boolean => {
    if (target.source === undefined) return true;
    return Array.isArray(target.source)
      ? target.source.includes(sourceKey)
      : target.source === sourceKey;
  };

  const closeSource = (sourceKey: SourceKey) => {
    const current = connectedSources.get(sourceKey);
    if (!current) return;
    if (typeof current.liveSource.close === "function") current.liveSource.close();
    connectedSources.delete(sourceKey);
  };

  const queueMatching = (
    sourceKey: SourceKey,
    eventName: string,
    kind: ReactiveRefreshKind,
    event: Event | MessageEvent<string>,
    scopeKeyOverride?: ScopeKey,
  ) => {
    const scopeKey = typeof scopeKeyOverride !== "undefined"
      ? scopeKeyOverride
      : options.getScopeKey?.();
    for (const target of options.targets()) {
      if (!targetMatchesSource(target, sourceKey)) continue;
      const element = target.element();
      if (!(element instanceof HTMLElement)) continue;
      const spec = readReactiveRefreshSpecs(element).find((entry) =>
        entry.kind === kind && entry.event === eventName);
      if (!spec) continue;
      if (options.shouldQueue && !options.shouldQueue({
        sourceKey,
        targetKey: target.key,
        target: element,
        eventName,
        kind,
        event,
      })) {
        continue;
      }
      target.queue(spec.throttleMs ?? 0, scopeKey);
    }
  };

  const declaredEvents = (
    sourceKey: SourceKey,
    kind: ReactiveRefreshKind,
  ): ReadonlyArray<string> => {
    const events = new Set<string>();
    for (const target of options.targets()) {
      if (!targetMatchesSource(target, sourceKey)) continue;
      for (const spec of readReactiveRefreshSpecs(target.element())) {
        if (spec.kind !== kind) continue;
        events.add(spec.event);
      }
    }
    return Array.from(events);
  };

  const syncBodyListeners = () => {
    if (!document.body) return;
    const activeEvents = new Set<string>();
    for (const sourceKey of options.sources) {
      for (const eventName of declaredEvents(sourceKey, "body")) activeEvents.add(eventName);
    }
    for (const eventName of activeEvents) {
      if (bodyHandlers.has(eventName)) continue;
      const handler = (event: Event) => {
        for (const sourceKey of options.sources) {
          queueMatching(sourceKey, eventName, "body", event);
        }
      };
      document.body.addEventListener(eventName, handler);
      bodyHandlers.set(eventName, handler);
    }
    for (const [eventName, handler] of Array.from(bodyHandlers.entries())) {
      if (activeEvents.has(eventName)) continue;
      document.body.removeEventListener(eventName, handler);
      bodyHandlers.delete(eventName);
    }
  };

  const syncLiveSources = () => {
    const connectLiveSource = options.connectLiveSource;
    if (!connectLiveSource) {
      for (const sourceKey of Array.from(connectedSources.keys())) closeSource(sourceKey);
      return;
    }
    for (const sourceKey of options.sources) {
      const path = options.eventPath(sourceKey);
      const events = [...declaredEvents(sourceKey, "live")].sort();
      if (!path || events.length === 0) {
        closeSource(sourceKey);
        continue;
      }
      const signature = `${path}::${events.join(",")}`;
      const current = connectedSources.get(sourceKey);
      if (current && current.signature === signature) continue;
      closeSource(sourceKey);
      const liveSource = connectLiveSource(path);
      if (!liveSource) continue;
      const ignoreLiveMessage = options.ignoreLiveMessage ?? defaultIgnoreLiveMessage;
      for (const eventName of events) {
        liveSource.addEventListener(eventName, (event) => {
          const message = event as MessageEvent<string>;
          if (ignoreLiveMessage(message)) return;
          const scopeKey = options.getScopeKey?.();
          options.onLiveEvent?.({
            sourceKey,
            eventName,
            event: message,
            scopeKey,
          });
          queueMatching(sourceKey, eventName, "live", message, scopeKey);
        });
      }
      connectedSources.set(sourceKey, { signature, liveSource });
      options.onLiveSourceConnected?.({ sourceKey, liveSource, path });
    }
  };

  const sync = () => {
    syncBodyListeners();
    syncLiveSources();
  };

  const close = () => {
    for (const sourceKey of Array.from(connectedSources.keys())) closeSource(sourceKey);
    if (!document.body) return;
    for (const [eventName, handler] of Array.from(bodyHandlers.entries())) {
      document.body.removeEventListener(eventName, handler);
      bodyHandlers.delete(eventName);
    }
  };

  return {
    sync,
    syncBodyListeners,
    syncLiveSources,
    close,
  };
};
