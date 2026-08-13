import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigPath } from "../config/loadConfig.ts";
import type { DiscordVoiceConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import { DiscordIpcConnection } from "./discordIpc.ts";

const tokenEndpoint = "https://discord.com/api/oauth2/token";
const redirectUri = "http://localhost";
const scopes = ["rpc", "rpc.voice.read", "rpc.voice.write"];
/** A dismissed consent prompt must not come back on every reconnect. */
const authorizeCooldownMs = 5 * 60_000;

export class DiscordAuthorizationRequiredError extends Error {}

interface StoredTokens {
  refreshToken: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

export class DiscordVoiceClient {
  private readonly config: DiscordVoiceConfig;
  private readonly log: Logger;
  private readonly tokenPath = join(dirname(getConfigPath()), "discord-tokens.json");
  private connection?: DiscordIpcConnection;
  private authenticated = false;
  private lastAuthorizeAt = 0;

  constructor(config: DiscordVoiceConfig, logger: Logger) {
    this.config = config;
    this.log = logger.child("discord");
  }

  get isReady(): boolean {
    return this.authenticated;
  }

  /**
   * Connects and authenticates with the stored refresh token, and falls back to the consent
   * flow when there is no usable token. Discord then shows its own prompt, which is the only
   * step a person has to take.
   */
  async connect(): Promise<void> {
    if (this.authenticated) return;

    const stored = await this.loadTokens();
    if (!stored) {
      await this.authorize();
      return;
    }

    const connection = await this.openConnection();
    let tokens;
    try {
      tokens = await this.requestTokens({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken
      });
    } catch (error) {
      if (!(error instanceof DiscordAuthorizationRequiredError)) throw error;

      this.log.warn("Stored Discord token no longer works; asking for consent again", {
        error: error.message
      });
      await this.authorize();
      return;
    }

    await this.saveTokens(tokens);
    await connection.send("AUTHENTICATE", { access_token: tokens.access_token });
    this.authenticated = true;
    this.log.info("Discord RPC authenticated");
  }

  /**
   * Runs the consent flow. Discord shows a popup in the client, so this only works while
   * the user is at the machine.
   */
  async authorize(): Promise<void> {
    const sinceLastAttempt = Date.now() - this.lastAuthorizeAt;
    if (sinceLastAttempt < authorizeCooldownMs) {
      throw new DiscordAuthorizationRequiredError(
        `Waiting ${Math.round((authorizeCooldownMs - sinceLastAttempt) / 1000)}s before asking for Discord consent again`
      );
    }

    const connection = await this.openConnection();
    this.lastAuthorizeAt = Date.now();
    this.log.info("Requesting Discord authorization; accept the prompt in Discord");
    const authorized = await connection.send("AUTHORIZE", {
      client_id: this.config.clientId,
      scopes
    });
    const code = (authorized.data as { code?: string } | undefined)?.code;
    if (!code) throw new Error("Discord authorization returned no code");

    const tokens = await this.requestTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    });
    await this.saveTokens(tokens);
    await connection.send("AUTHENTICATE", { access_token: tokens.access_token });
    this.authenticated = true;
    this.log.info("Discord RPC authorized");
  }

  async getMute(): Promise<boolean> {
    const settings = await this.command("GET_VOICE_SETTINGS");
    return Boolean((settings.data as { mute?: boolean } | undefined)?.mute);
  }

  async setMute(mute: boolean): Promise<void> {
    await this.command("SET_VOICE_SETTINGS", { mute });
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
    this.authenticated = false;
  }

  private async command(cmd: string, args: unknown = {}) {
    const connection = this.connection;
    if (!connection || !this.authenticated) {
      throw new Error(`${cmd} failed: Discord RPC is not connected`);
    }
    return connection.send(cmd, args);
  }

  private async openConnection(): Promise<DiscordIpcConnection> {
    if (this.connection) return this.connection;

    const connection = await DiscordIpcConnection.open(this.config.clientId);
    connection.onClose(() => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.authenticated = false;
        this.log.warn("Discord RPC connection closed");
      }
    });
    this.connection = connection;
    return connection;
  }

  private async requestTokens(grant: Record<string, string>): Promise<TokenResponse> {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...grant
      })
    });
    const payload = (await response.json()) as TokenResponse;
    if (!response.ok || !payload.access_token) {
      const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
      if (grant.grant_type === "refresh_token") {
        throw new DiscordAuthorizationRequiredError(`Discord token refresh failed: ${reason}`);
      }
      throw new Error(`Discord token request failed: ${reason}`);
    }
    return payload;
  }

  private async loadTokens(): Promise<StoredTokens | undefined> {
    if (!existsSync(this.tokenPath)) return undefined;
    const value = JSON.parse(await readFile(this.tokenPath, "utf8")) as Partial<StoredTokens>;
    return typeof value.refreshToken === "string"
      ? { refreshToken: value.refreshToken }
      : undefined;
  }

  private async saveTokens(tokens: TokenResponse): Promise<void> {
    if (!tokens.refresh_token) return;

    const temporaryPath = `${this.tokenPath}.tmp`;
    const state: StoredTokens = { refreshToken: tokens.refresh_token };
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
    await rename(temporaryPath, this.tokenPath);
  }
}
