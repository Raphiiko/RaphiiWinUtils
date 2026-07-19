import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import type { Logger } from "../system/logger.ts";
import { VbanTextClient } from "./vbanTextClient.ts";

const logger = {
  child() {
    return this;
  },
  debug() {},
  info() {},
  warn() {},
  error() {}
} as unknown as Logger;

void test("allows consecutive VBAN-TEXT requests from one client", async () => {
  const server = dgram.createSocket("udp4");
  server.on("message", (_message, remote) => {
    const response = Buffer.alloc(28 + Buffer.byteLength("Slot[0].Device.WDM = Ready;"));
    Buffer.from("Slot[0].Device.WDM = Ready;").copy(response, 28);
    server.send(response, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(typeof address, "string");
  if (typeof address === "string") return;

  const client = new VbanTextClient(
    { host: "127.0.0.1", port: address.port, streamName: "Command1", resyncEveryMs: 5_000 },
    logger
  );
  try {
    assert.deepEqual(await client.request("Slot(0).Device.WDM = ?;", 50), ["Slot[0].Device.WDM = Ready;"]);
    assert.deepEqual(await client.request("Slot(0).Device.WDM = ?;", 50), ["Slot[0].Device.WDM = Ready;"]);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
