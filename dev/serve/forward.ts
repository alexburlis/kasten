// The port forwarder of ./kasten dev serve. It listens on the app's port and pipes every
// connection to the web container's private port, so the app's port belongs to dev serve.
// Usage: node dev/serve/forward.ts <host> <listen port> <target port>
import { createConnection, createServer } from "node:net";

const [host = "127.0.0.1", listenText = "", targetText = ""] = process.argv.slice(2);

const listenPort = Number(listenText);

const targetPort = Number(targetText);

if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
  console.error("usage: node dev/serve/forward.ts <host> <listen port> <target port>");
  process.exit(2);
}

const server = createServer((client) => {
  const upstream = createConnection({ host, port: targetPort });

  const close = (): void => {
    client.destroy();
    upstream.destroy();
  };

  client.on("error", close);
  upstream.on("error", close);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on("error", (error) => {
  console.error(`kasten: cannot listen on ${host}:${listenPort}: ${error.message}`);
  process.exit(1);
});

server.listen(listenPort, host, () => {
  console.log(`forwarding http://localhost:${listenPort} to ${host}:${targetPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
