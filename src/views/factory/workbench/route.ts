import {
  DEFAULT_FACTORY_WORKBENCH_FILTER,
  type FactoryWorkbenchFilterKey,
} from "../../factory-models";

export type FactoryWorkbenchRouteInput = {
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: "overview" | "chat";
  readonly detailTab?: "action" | "review" | "queue";
  readonly filter?: FactoryWorkbenchFilterKey;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
};

type SearchParamsWriter = {
  set: (key: string, value: string) => void;
  toString: () => string;
};

const createSearchParams = (input?: string): SearchParamsWriter => {
  if (typeof URLSearchParams !== "undefined") return new URLSearchParams(input);
  const entries = new Map<string, string>();
  const source = typeof input === "string" ? input.replace(/^\?/, "") : "";
  for (const chunk of source.split("&")) {
    if (!chunk) continue;
    const [rawKey, rawValue = ""] = chunk.split("=");
    entries.set(decodeURIComponent(rawKey), decodeURIComponent(rawValue));
  }
  return {
    set(key: string, value: string) {
      entries.set(key, value);
    },
    toString() {
      return Array.from(entries.entries())
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
    },
  };
};

export const buildFactoryWorkbenchSearchParams = (
  input: FactoryWorkbenchRouteInput,
): SearchParamsWriter => {
  const params = createSearchParams();
  params.set("profile", input.profileId);
  params.set("chat", input.chatId);
  if (input.objectiveId) params.set("objective", input.objectiveId);
  if (input.inspectorTab && input.inspectorTab !== "overview") params.set("inspectorTab", input.inspectorTab);
  if (input.detailTab) params.set("detailTab", input.detailTab);
  if (input.filter && input.filter !== DEFAULT_FACTORY_WORKBENCH_FILTER) params.set("filter", input.filter);
  if (input.focusKind && input.focusId) {
    params.set("focusKind", input.focusKind);
    params.set("focusId", input.focusId);
  }
  return params;
};

export const buildFactoryWorkbenchSearch = (
  input: FactoryWorkbenchRouteInput,
): string => {
  const query = buildFactoryWorkbenchSearchParams(input).toString();
  return query ? `?${query}` : "";
};

export const buildFactoryWorkbenchRouteKey = (
  input: FactoryWorkbenchRouteInput,
): string => `/factory${buildFactoryWorkbenchSearch(input)}`;
