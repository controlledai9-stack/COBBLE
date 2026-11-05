import { createServer } from "vite";

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const pFlagIdx = process.argv.indexOf("-p");
const requestedPort = portArg
  ? Number(portArg.split("=")[1])
  : pFlagIdx !== -1 && process.argv[pFlagIdx + 1]
    ? Number(process.argv[pFlagIdx + 1])
    : process.env.PORT
      ? Number(process.env.PORT)
      : undefined;

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
const url = `http://127.0.0.1:${activePort}`;
console.log(`[Cobble Web] Server running at ${url}`);
