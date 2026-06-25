import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { patchClipboardLinks } from "./linkReplacements.ts";

await describe("patchClipboardLinks", async () => {
  const cases = [
    ["https://x.com/Raphiiko/status/123", "https://fixvx.com/Raphiiko/status/123"],
    ["https://twitter.com/Raphiiko/status/123", "https://fixvx.com/Raphiiko/status/123"],
    ["https://www.tiktok.com/@raphii/video/123", "https://www.tnktok.com/@raphii/video/123"],
    ["https://vm.tiktok.com/ZM123abc/", "https://vm.tnktok.com/ZM123abc/"],
    ["https://www.pixiv.net/en/artworks/123456", "https://www.phixiv.net/en/artworks/123456"],
    [
      "https://bsky.app/profile/example.com/post/abc",
      "https://bskx.app/profile/example.com/post/abc"
    ],
    [
      "https://www.reddit.com/r/test/comments/abc/title/",
      "https://rxddit.com/r/test/comments/abc/title/"
    ],
    [
      "https://www.instagram.com/reel/ABC123/?igsh=foo",
      "https://kkinstagram.com/reel/ABC123/?igsh=foo"
    ]
  ] as const;

  for (const [input, expected] of cases) {
    await test(`rewrites ${input}`, () => {
      assert.equal(patchClipboardLinks(input).content, expected);
    });
  }

  await test("leaves unrelated clipboard text alone", () => {
    const input = "no links here";
    const result = patchClipboardLinks(input);

    assert.equal(result.content, input);
    assert.deepEqual(result.appliedRules, []);
  });
});
