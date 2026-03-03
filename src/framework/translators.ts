type RuntimePhantom<Event, Config> = {
  readonly __event__?: Event;
  readonly __config__?: Config;
};

export type RuntimeOp<Cmd = unknown, Event = unknown, Config = unknown> = (
  | { readonly type: "fork"; readonly stream: string; readonly at: number; readonly newName: string }
  | { readonly type: "emit"; readonly stream: string; readonly cmd: Cmd }
  | { readonly type: "start_run"; readonly launcher: () => Promise<void> | void }
  | { readonly type: "broadcast"; readonly topic: "theorem" | "writer" | "receipt"; readonly stream?: string }
  | { readonly type: "redirect"; readonly url: string; readonly header: "HX-Redirect" | "HX-Push-Url" }
) & RuntimePhantom<Event, Config>;

type RuntimeOpHandlers<Cmd> = {
  readonly fork: (op: Extract<RuntimeOp<Cmd>, { type: "fork" }>) => Promise<void>;
  readonly emit: (op: Extract<RuntimeOp<Cmd>, { type: "emit" }>) => Promise<void>;
  readonly startRun: (op: Extract<RuntimeOp<Cmd>, { type: "start_run" }>) => Promise<void>;
  readonly broadcast: (op: Extract<RuntimeOp<Cmd>, { type: "broadcast" }>) => Promise<void>;
};

export const executeRuntimeOps = async <Cmd>(
  ops: ReadonlyArray<RuntimeOp<Cmd>>,
  handlers: RuntimeOpHandlers<Cmd>
): Promise<Extract<RuntimeOp<Cmd>, { type: "redirect" }> | undefined> => {
  let redirect: Extract<RuntimeOp<Cmd>, { type: "redirect" }> | undefined;

  for (const op of ops) {
    switch (op.type) {
      case "fork":
        await handlers.fork(op);
        break;
      case "emit":
        await handlers.emit(op);
        break;
      case "start_run":
        await handlers.startRun(op);
        break;
      case "broadcast":
        await handlers.broadcast(op);
        break;
      case "redirect":
        redirect = op;
        break;
      default: {
        const _exhaustive: never = op;
        throw new Error(`unknown runtime op: ${String(_exhaustive)}`);
      }
    }
  }

  return redirect;
};
