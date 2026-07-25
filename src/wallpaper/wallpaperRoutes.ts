import { Elysia } from "elysia";
import { readFile } from "node:fs/promises";
import { Logger } from "../system/logger.ts";
import { contentTypeFor, InvalidWallpaperRequestError } from "./wallpaperRequests.ts";
import { WallpaperHelperError, WallpaperService } from "./wallpaperService.ts";

/**
 * Dashboard API for the wallpaper tool. Mounted on the existing control server; further tools get
 * their own plugin under the same /api prefix.
 */
export function wallpaperRoutes(service: WallpaperService, logger: Logger) {
  const log = logger.child("wallpaper-api");

  const guard = async <T>(
    context: { set: { status?: number | string } },
    handler: () => Promise<T>
  ): Promise<T | { error: string }> => {
    try {
      return await handler();
    } catch (error) {
      if (error instanceof InvalidWallpaperRequestError) {
        context.set.status = 400;
        return { error: error.message };
      }
      if (error instanceof WallpaperHelperError) {
        context.set.status = 502;
        log.error("Wallpaper helper failed", { error: error.message });
        return { error: error.message };
      }

      context.set.status = 500;
      log.error("Wallpaper request failed", { error: String(error) });
      return { error: "Wallpaper request failed" };
    }
  };

  return (
    new Elysia({ prefix: "/api/wallpaper" })
      .get("/monitors", (context) =>
        guard(context, async () => ({
          monitors: await service.listMonitors(),
          hidden: await service.listHidden()
        }))
      )
      .put("/hidden", (context) =>
        guard(context, async () => {
          const body = (context.body ?? {}) as { monitorIds?: unknown };
          return { hidden: await service.setHidden(body.monitorIds) };
        })
      )
      .get("/library", (context) =>
        guard(context, async () => ({ files: await service.listLibrary() }))
      )
      .get("/library/:file", async (context) =>
        guard(context, async () => {
          const path = service.libraryPath(context.params.file);
          return new Response(await readFile(path), {
            headers: {
              "content-type": contentTypeFor(path),
              "cache-control": "no-cache"
            }
          });
        })
      )
      // Raw bytes with ?name=, so there is no multipart parsing to get wrong. Elysia's default
      // parser turns application/octet-stream into an ArrayBuffer.
      .post("/library", (context) =>
        guard(context, async () => {
          const bytes = toBuffer(context.body);
          if (!bytes)
            throw new InvalidWallpaperRequestError("Expected raw image bytes as the body");
          return await service.addImage(context.query.name, bytes);
        })
      )
      .delete("/library/:file", (context) =>
        guard(context, async () => ({ file: await service.removeImage(context.params.file) }))
      )
      .get("/current", (context) =>
        guard(context, async () => ({ assignments: await service.listCurrent() }))
      )
      .get("/presets", (context) =>
        guard(context, async () => ({ presets: await service.listPresets() }))
      )
      .put("/presets/:name", (context) =>
        guard(context, async () => {
          const body = (context.body ?? {}) as { assignments?: unknown };
          return { preset: await service.savePreset(context.params.name, body.assignments) };
        })
      )
      .post("/apply", (context) =>
        guard(context, async () => {
          const body = (context.body ?? {}) as { assignments?: unknown };
          return await service.apply(body.assignments);
        })
      )
  );
}

function toBuffer(body: unknown): Buffer | undefined {
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return undefined;
}
