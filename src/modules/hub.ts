import type { Decide, Reducer } from "../core/types.js";

export type AgentProfile = {
  readonly agentId: string;
  readonly displayName: string;
  readonly memoryScope: string;
  readonly createdAt: number;
};

export type HubChannel = {
  readonly name: string;
  readonly createdAt: number;
};

export type WorkspaceRecord = {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly baseHash: string;
  readonly branchName: string;
  readonly path: string;
  readonly createdAt: number;
  readonly removedAt?: number;
};

export type BoardPost = {
  readonly postId: string;
  readonly channel: string;
  readonly agentId: string;
  readonly parentId?: string;
  readonly content: string;
  readonly commitHash?: string;
  readonly workspaceId?: string;
  readonly createdAt: number;
};

export type HubTask = {
  readonly taskId: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly jobId?: string;
  readonly maxIterations?: number;
  readonly createdAt: number;
};

export type Announcement = {
  readonly announcementId: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly commitHash: string;
  readonly channel: string;
  readonly postId: string;
  readonly createdAt: number;
};

export type HubEvent =
  | {
      readonly type: "agent.registered";
      readonly profile: AgentProfile;
    }
  | {
      readonly type: "channel.created";
      readonly channel: HubChannel;
    }
  | {
      readonly type: "workspace.created";
      readonly workspace: WorkspaceRecord;
    }
  | {
      readonly type: "workspace.removed";
      readonly workspaceId: string;
      readonly removedAt: number;
    }
  | {
      readonly type: "board.post.created";
      readonly post: BoardPost;
    }
  | {
      readonly type: "task.created";
      readonly task: HubTask;
    }
  | {
      readonly type: "announcement.created";
      readonly announcement: Announcement;
    };

export type HubCmd = {
  readonly type: "emit";
  readonly event: HubEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type HubState = {
  readonly agents: Readonly<Record<string, AgentProfile>>;
  readonly channels: Readonly<Record<string, HubChannel>>;
  readonly workspaces: Readonly<Record<string, WorkspaceRecord>>;
  readonly posts: Readonly<Record<string, BoardPost>>;
  readonly tasks: Readonly<Record<string, HubTask>>;
  readonly announcements: Readonly<Record<string, Announcement>>;
};

export const initial: HubState = {
  agents: {},
  channels: {},
  workspaces: {},
  posts: {},
  tasks: {},
  announcements: {},
};

export const decide: Decide<HubCmd, HubEvent> = (cmd) => [cmd.event];

export const reduce: Reducer<HubState, HubEvent> = (state, event) => {
  switch (event.type) {
    case "agent.registered":
      return {
        ...state,
        agents: {
          ...state.agents,
          [event.profile.agentId]: event.profile,
        },
      };
    case "channel.created":
      return {
        ...state,
        channels: {
          ...state.channels,
          [event.channel.name]: event.channel,
        },
      };
    case "workspace.created":
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [event.workspace.workspaceId]: event.workspace,
        },
      };
    case "workspace.removed": {
      const workspace = state.workspaces[event.workspaceId];
      if (!workspace) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [event.workspaceId]: {
            ...workspace,
            removedAt: event.removedAt,
          },
        },
      };
    }
    case "board.post.created":
      return {
        ...state,
        posts: {
          ...state.posts,
          [event.post.postId]: event.post,
        },
      };
    case "task.created":
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.task.taskId]: event.task,
        },
      };
    case "announcement.created":
      return {
        ...state,
        announcements: {
          ...state.announcements,
          [event.announcement.announcementId]: event.announcement,
        },
      };
    default: {
      const _never: never = event;
      return _never;
    }
  }
};
