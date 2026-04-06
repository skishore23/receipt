import type {
  FactoryInspectorTab,
  FactoryWorkbenchDetailTab,
  FactoryWorkbenchFilterKey,
  FactoryWorkbenchPageModel,
} from "../../../views/factory-models";
import {
  makeFactoryChatId,
  normalizeFocusKind,
  normalizedWorkbenchDetailTab,
  normalizedWorkbenchInspectorTab,
  requestedChatId,
  requestedFocusId,
  requestedFocusKind,
  requestedInspectorTab,
  requestedObjectiveId,
  requestedProfileId,
  requestedWorkbenchDetailTab,
  requestedWorkbenchFilter,
  requestedWorkbenchPage,
} from "./params";

export type FactoryWorkbenchRequestState = {
  readonly hasRequestedProfile: boolean;
  readonly hasRequestedObjective: boolean;
  readonly hasRequestedFocus: boolean;
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab: FactoryInspectorTab;
  readonly detailTab: FactoryWorkbenchDetailTab;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter: FactoryWorkbenchFilterKey;
  readonly page: number;
};

export const readWorkbenchRequest = (req: Request): FactoryWorkbenchRequestState => {
  const profileId = requestedProfileId(req);
  const objectiveId = requestedObjectiveId(req);
  const focusKind = requestedFocusKind(req);
  const focusId = requestedFocusId(req);
  return {
    hasRequestedProfile: profileId !== undefined,
    hasRequestedObjective: objectiveId !== undefined,
    hasRequestedFocus: focusKind !== undefined || focusId !== undefined,
    profileId: profileId ?? "generalist",
    chatId: requestedChatId(req) ?? makeFactoryChatId(),
    objectiveId,
    inspectorTab: normalizedWorkbenchInspectorTab(requestedInspectorTab(req)),
    detailTab: normalizedWorkbenchDetailTab(requestedWorkbenchDetailTab(req), Boolean(objectiveId)),
    focusKind: normalizeFocusKind(focusKind),
    focusId,
    filter: requestedWorkbenchFilter(req),
    page: requestedWorkbenchPage(req),
  };
};

export const shouldRedirectWorkbenchRequest = (
  request: FactoryWorkbenchRequestState,
  model: FactoryWorkbenchPageModel,
): boolean => {
  const shouldRedirectForProfile = (
    request.hasRequestedProfile
    || request.hasRequestedObjective
  ) && request.profileId !== model.activeProfileId;
  const shouldRedirectForObjective = request.hasRequestedObjective && request.objectiveId !== model.objectiveId;
  const shouldRedirectForFocus = request.hasRequestedFocus && (
    request.focusKind !== model.focusKind
    || request.focusId !== model.focusId
  );
  return shouldRedirectForProfile
    || request.chatId !== model.chatId
    || shouldRedirectForObjective
    || request.inspectorTab !== model.inspectorTab
    || request.detailTab !== model.detailTab
    || request.filter !== model.filter
    || request.page !== model.page
    || shouldRedirectForFocus;
};
