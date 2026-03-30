import type { FactoryLiveScopePayload } from "../client-contract";
import { json, text } from "../../../framework/http";
import { DEFAULT_FACTORY_WORKBENCH_FILTER } from "../../../views/factory-models";

export const wantsJsonNavigation = (req: Request): boolean =>
  (req.headers.get("accept") ?? "").includes("application/json");

export const navigationResponse = (
  req: Request,
  location: string,
  options?: {
    readonly live?: FactoryLiveScopePayload;
  },
): Response =>
  wantsJsonNavigation(req)
    ? json(200, {
        location,
        ...(options?.live ? { live: options.live } : {}),
      })
    : new Response(null, {
        status: 303,
        headers: {
          Location: location,
          "Cache-Control": "no-store",
        },
      });

export const navigationError = (req: Request, status: number, message: string): Response =>
  wantsJsonNavigation(req)
    ? json(status, { error: message })
    : text(status, message);

export const workbenchNavigationResponse = (
  req: Request,
  location: string,
  options?: {
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly live?: FactoryLiveScopePayload;
  },
): Response =>
  wantsJsonNavigation(req)
    ? json(200, {
        location,
        ...(options?.live ? { live: options.live } : {}),
        ...(options?.chatId ? { chat: { chatId: options.chatId } } : {}),
        ...(options?.objectiveId || (options?.focusKind && options?.focusId)
          ? {
              selection: {
                ...(options?.objectiveId ? { objectiveId: options.objectiveId } : {}),
                ...(options?.focusKind ? { focusKind: options.focusKind } : {}),
                ...(options?.focusId ? { focusId: options.focusId } : {}),
              },
            }
          : {}),
      })
    : new Response(null, {
        status: 303,
        headers: {
          Location: location,
          "Cache-Control": "no-store",
        },
      });

export const buildWorkbenchLink = (input: {
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: "overview" | "chat" | "notes";
  readonly detailTab?: "review" | "queue" | "action";
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter?: typeof DEFAULT_FACTORY_WORKBENCH_FILTER;
}): string => {
  const params = new URLSearchParams();
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
  const query = params.toString();
  return `/factory${query ? `?${query}` : ""}`;
};
