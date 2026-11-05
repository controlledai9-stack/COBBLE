import { spawn } from "node:child_process";
import { createServer } from "vite";
import { build } from "esbuild";
import electron from "electron";

await build({
  entryPoints: ["src/main/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/main/main.cjs",
});
await build({
  entryPoints: ["src/main/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/main/preload.cjs",
});

// Determine requested port: --port=..., -p ..., or PORT environment variable
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const pFlagIdx = process.argv.indexOf("-p");
const requestedPort = portArg
  ? Number(portArg.split("=")[1])
  : pFlagIdx !== -1 && process.argv[pFlagIdx + 1]
    ? Number(process.argv[pFlagIdx + 1])
    : process.env.PORT
      ? Number(process.env.PORT)
      : undefined;

// Default to 5174 to avoid collision with port 5173
const initialPort = requestedPort || 5174;
const server = await createServer({
  root: "src/renderer",
  server: {
    host: "127.0.0.1",
    port: initialPort,
    strictPort: Boolean(requestedPort),
  },
});
await server.listen();

const address = server.httpServer?.address();
const activePort =
  typeof address === "object" && address ? address.port : initialPort;
const rendererUrl = `http://127.0.0.1:${activePort}`;
console.log(`[Cobble Dev] Vite server running on ${rendererUrl}`);

const env = { ...process.env, COBBLE_RENDERER_URL: rendererUrl };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ["."], { stdio: "inherit", env });
app.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
