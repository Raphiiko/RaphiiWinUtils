import dgram from "node:dgram";
import type { MatrixConfig } from "../config/schema";
import { Logger } from "../system/logger";

const VBAN_HEADER_BYTES = 28;
const MAX_TEXT_BYTES = 1436;

export class VbanTextClient {
  private frame = 0;
  private readonly socket = dgram.createSocket("udp4");
  private readonly log: Logger;

  constructor(
    private readonly config: MatrixConfig,
    logger: Logger
  ) {
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

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("message", onMessage);
        this.socket.off("error", onError);
      };

      const onMessage = (message: Buffer) => {
        responses.push(message.subarray(VBAN_HEADER_BYTES).toString("utf8"));
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      this.socket.on("message", onMessage);
      this.socket.once("error", onError);
      this.socket.bind(0, () => {
        this.socket.send(packet, this.config.port, this.config.host, (error) => {
          if (error) onError(error);
        });
      });
    });

    this.log.debug("Requested Matrix value", { command, responses });
    return responses;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
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
