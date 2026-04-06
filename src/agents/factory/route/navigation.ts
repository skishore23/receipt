import type { FactoryLiveScopePayload } from "../client-contract";
import { json, text } from "../../../framework/http";
import { buildFactoryWorkbenchRouteKey } from "../../../views/factory/workbench/route";
import type { FactoryWorkbenchFilterKey } from "../../../views/factory-models";

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
  readonly inspectorTab?: "overview" | "chat";
  readonly detailTab?: "review" | "queue" | "action";
  readonly page?: number;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter?: FactoryWorkbenchFilterKey;
}): string => buildFactoryWorkbenchRouteKey(input);
