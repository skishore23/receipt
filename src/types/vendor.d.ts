declare module "@oblivionocean/minigfm" {
  export class MiniGFM {
    parse(markdown: string): string;
  }
}

declare const Bun: {
  serve(opts: {
    fetch: (request: Request) => Response | Promise<Response>;
    port: number;
  }): {
    stop(): void;
  };
  which(command: string): string | null;
};
