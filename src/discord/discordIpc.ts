import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

export const opHandshake = 0;
export const opFrame = 1;

const pipeCount = 10;
const commandTimeoutMs = 10_000;

export interface DiscordFrame {
  cmd?: string;
  evt?: string;
  nonce?: string | null;
  data?: Record<string, unknown>;
}

export class DiscordIpcError extends Error {}

export function encodeFrame(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Decodes whole frames and returns the trailing bytes of the frame still in flight. */
export function decodeFrames(buffer: Buffer): { frames: DiscordFrame[]; rest: Buffer } {
  const frames: DiscordFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const length = buffer.readInt32LE(offset + 4);
    if (buffer.length - offset - 8 < length) break;
    const body = buffer.subarray(offset + 8, offset + 8 + length).toString("utf8");
    frames.push(JSON.parse(body) as DiscordFrame);
    offset += 8 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export class DiscordIpcConnection {
  private readonly socket: Socket;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly pending = new Map<string, (frame: DiscordFrame) => void>();
  private readonly failPending = new Map<string, (error: Error) => void>();
  private ready?: (frame: DiscordFrame) => void;
  private closed = false;
  private closeHandler: () => void = () => {};

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("error", () => this.handleClose());
    socket.on("close", () => this.handleClose());
  }

  /** Connects to the first Discord IPC pipe that answers and completes the handshake. */
  static async open(clientId: string): Promise<DiscordIpcConnection> {
    for (let index = 0; index < pipeCount; index++) {
      const socket = await openSocket(`\\\\?\\pipe\\discord-ipc-${index}`);
      if (!socket) continue;

      const connection = new DiscordIpcConnection(socket);
      try {
        await connection.handshake(clientId);
        return connection;
      } catch (error) {
        connection.close();
        throw error;
      }
    }

    throw new DiscordIpcError("No Discord IPC pipe answered; Discord is probably not running");
  }

  send(cmd: string, args: unknown = {}, evt?: string): Promise<DiscordFrame> {
    if (this.closed) return Promise.reject(new DiscordIpcError(`${cmd} failed: not connected`));

    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        this.failPending.delete(nonce);
        reject(new DiscordIpcError(`${cmd} timed out after ${commandTimeoutMs}ms`));
      }, commandTimeoutMs);

      this.pending.set(nonce, (frame) => {
        clearTimeout(timer);
        if (frame.evt === "ERROR") {
          const data = frame.data as { code?: number; message?: string } | undefined;
          reject(new DiscordIpcError(`${cmd} rejected: ${data?.code} ${data?.message}`));
        } else {
          resolve(frame);
        }
      });
      this.failPending.set(nonce, (error) => {
        clearTimeout(timer);
        reject(error);
      });

      this.socket.write(encodeFrame(opFrame, { cmd, args, nonce, ...(evt ? { evt } : {}) }));
    });
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private handshake(clientId: string): Promise<DiscordFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DiscordIpcError("Discord handshake timed out")),
        commandTimeoutMs
      );
      this.ready = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.socket.write(encodeFrame(opHandshake, { v: 1, client_id: clientId }));
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let decoded;
    try {
      decoded = decodeFrames(this.buffer);
    } catch {
      this.handleClose();
      return;
    }

    this.buffer = decoded.rest;
    for (const frame of decoded.frames) {
      const resolve = frame.nonce ? this.pending.get(frame.nonce) : undefined;
      if (resolve && frame.nonce) {
        this.pending.delete(frame.nonce);
        this.failPending.delete(frame.nonce);
        resolve(frame);
      } else if (frame.evt === "READY") {
        this.ready?.(frame);
        this.ready = undefined;
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fail of this.failPending.values()) {
      fail(new DiscordIpcError("Discord IPC connection closed"));
    }
    this.pending.clear();
    this.failPending.clear();
    this.closeHandler();
  }
}

function openSocket(path: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(undefined));
  });
}
