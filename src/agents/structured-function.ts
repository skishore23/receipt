export type StructuredFunctionResult<Parsed> = {
  readonly parsed: Parsed;
  readonly raw: string;
  readonly repaired: boolean;
  readonly compacted: boolean;
};

export const runStructuredFunction = async <Parsed>(input: {
  readonly invoke: (user: string) => Promise<{ readonly parsed: Parsed; readonly raw: string }>;
  readonly user: string;
  readonly isRepairableError?: (err: unknown) => boolean;
  readonly repairUser?: (user: string, err: unknown) => Promise<string | undefined> | string | undefined;
  readonly isCompactionError?: (err: unknown) => boolean;
  readonly compactUser?: (user: string, err: unknown) => Promise<string> | string;
}): Promise<StructuredFunctionResult<Parsed>> => {
  try {
    const result = await input.invoke(input.user);
    return {
      ...result,
      repaired: false,
      compacted: false,
    };
  } catch (err) {
    if (input.isRepairableError?.(err)) {
      const repairedUser = await input.repairUser?.(input.user, err);
      if (repairedUser) {
        const repaired = await input.invoke(repairedUser);
        return {
          ...repaired,
          repaired: true,
          compacted: false,
        };
      }
    }
    if (input.isCompactionError?.(err)) {
      const compactedUser = await input.compactUser?.(input.user, err);
      if (compactedUser) {
        const compacted = await input.invoke(compactedUser);
        return {
          ...compacted,
          repaired: false,
          compacted: true,
        };
      }
    }
    throw err;
  }
};
