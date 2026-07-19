import dgram from "node:dgram";
import type { MatrixConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";

const VBAN_HEADER_BYTES = 28;
const MAX_TEXT_BYTES = 1436;

export class VbanTextClient {
  private frame = 0;
  private readonly log: Logger;
  private readonly config: MatrixConfig;

  constructor(config: MatrixConfig, logger: Logger) {
    this.config = config;
    this.log = logger.child("vban");
  }

  async send(command: string): Promise<void> {
    const packet = this.createPacket(command);
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.send(packet, this.config.port, this.config.host, (error) => {
        socket.close();
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    this.log.debug("Sent Matrix command", { command });
  }

  async request(command: string, timeoutMs = 750): Promise<string[]> {
    const packet = this.createPacket(command);
    const responses: string[] = [];
    const socket = dgram.createSocket("udp4");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        finish(resolve);
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.close();
      };

      const finish = (complete: () => void) => {
        cleanup();
        complete();
      };

      const onMessage = (message: Buffer) => {
        responses.push(message.subarray(VBAN_HEADER_BYTES).toString("utf8"));
      };

      const onError = (error: Error) => {
        finish(() => reject(error));
      };

      socket.on("message", onMessage);
      socket.once("error", onError);
      socket.bind(0, () => {
        socket.send(packet, this.config.port, this.config.host, (error) => {
          if (error) onError(error);
        });
      });
    });

    this.log.debug("Requested Matrix value", { command, responses });
    return responses;
  }

  async close(): Promise<void> {
    // Requests use short-lived sockets and sends already close their own socket.
  }

  private createPacket(command: string): Buffer {
    const text = Buffer.from(command, "utf8");
    if (text.byteLength > MAX_TEXT_BYTES) {
      throw new Error(`VBAN-TEXT command is too long: ${text.byteLength} bytes`);
    }

    const packet = Buffer.alloc(VBAN_HEADER_BYTES + text.byteLength);
    packet.write("VBAN", 0, "ascii");
    packet.writeUInt8(0x52, 4);
    packet.writeUInt8(0x00, 5);
    packet.writeUInt8(0x00, 6);
    packet.writeUInt8(0x10, 7);

    const streamName = Buffer.from(this.config.streamName, "ascii");
    streamName.copy(packet, 8, 0, Math.min(16, streamName.byteLength));

    this.frame = (this.frame + 1) >>> 0;
    packet.writeUInt32LE(this.frame, 24);
    text.copy(packet, VBAN_HEADER_BYTES);
    return packet;
  }
}
