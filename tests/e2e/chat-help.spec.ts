import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const ARTIFACT_DIR = "artifacts/e2e";
const SERVER_URL = "http://127.0.0.1:3787";

const waitForServer = async (): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    try {
      const response = await fetch(`${SERVER_URL}/factory`, { redirect: "manual" });
      if (response.ok || response.status === 303) return;
    } catch {
      // Keep waiting for the server to bind.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Factory server");
};

const startServer = () => {
  const child = spawn("bun", ["src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "3787",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
      RECEIPT_CLI_NO_FORCE_EXIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
};

const captureArtifacts = async (name: string, output: string, error?: unknown) => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(`${ARTIFACT_DIR}/${name}.log`, output, "utf8");
  if (error) {
    await writeFile(`${ARTIFACT_DIR}/${name}.error.txt`, String(error instanceof Error ? error.stack ?? error.message : error), "utf8");
  }
};

test("/help returns the workbench navigation response and exposes the command palette contract", async () => {
  const server = startServer();
  let stdout = "";
  let stderr = "";
  server.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
  server.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer();
    const response = await fetch(`${SERVER_URL}/factory/compose?profile=generalist&chat=e2e-help`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ prompt: "/help" }),
    });
    const body = await response.json() as { readonly location?: string; readonly chat?: { readonly chatId?: string } };
    expect(response.status).toBe(200);
    expect(body.location).toContain("/factory?");
    expect(body.chat?.chatId).toBe("e2e-help");

    const page = await fetch(new URL(body.location ?? "/factory?profile=generalist&chat=e2e-help", SERVER_URL));
    const html = await page.text();
    expect(html).toContain("/help");
    expect(html).toContain("/follow-up");
    expect(html).toContain("Show slash command help.");
  } catch (error) {
    await captureArtifacts("chat-help", `${stdout}\n${stderr}`, error);
    throw error;
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (server.exitCode === null) server.kill("SIGKILL");
  }
});
