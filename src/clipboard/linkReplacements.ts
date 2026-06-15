export interface LinkReplacementRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export interface ClipboardPatch {
  content: string;
  appliedRules: string[];
}

export const linkReplacementRules: LinkReplacementRule[] = [
  {
    name: "x-status",
    pattern: /\bhttps?:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status/g,
    replacement: "https://girlcockx.com/$1/status"
  },
  {
    name: "twitter-status",
    pattern: /\bhttps?:\/\/twitter\.com\/([A-Za-z0-9_]{1,15})\/status/g,
    replacement: "https://girlcockx.com/$1/status"
  },
  {
    name: "tiktok-profile-video",
    pattern: /\bhttps?:\/\/(?:www\.)?tiktok\.com\/@([^/\s]+)\/video/g,
    replacement: "https://www.tnktok.com/@$1/video"
  },
  {
    name: "tiktok-shortlink",
    pattern: /\bhttps?:\/\/vm\.tiktok\.com\/([A-Za-z0-9_.-]+)/g,
    replacement: "https://vm.tnktok.com/$1"
  },
  {
    name: "pixiv-artwork",
    pattern: /\bhttps?:\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/([0-9]+)/g,
    replacement: "https://www.phixiv.net/en/artworks/$1"
  },
  {
    name: "bluesky",
    pattern: /\bhttps?:\/\/bsky\.app\/([^\s]+)/g,
    replacement: "https://bskx.app/$1"
  },
  {
    name: "reddit",
    pattern: /\bhttps?:\/\/(?:(?:www|old|new)\.)?reddit\.com\/([^\s]+)/g,
    replacement: "https://rxddit.com/$1"
  },
  {
    name: "instagram-post",
    pattern: /\bhttps?:\/\/(?:www\.)?instagram\.com\/((?:p|reel|tv)\/[^\s]+)/g,
    replacement: "https://kkinstagram.com/$1"
  }
];

export function patchClipboardLinks(
  content: string,
  rules: LinkReplacementRule[] = linkReplacementRules
): ClipboardPatch {
  let patched = content;
  const appliedRules: string[] = [];

  for (const rule of rules) {
    const next = patched.replaceAll(rule.pattern, rule.replacement);
    if (next !== patched) {
      appliedRules.push(rule.name);
      patched = next;
    }
  }

  return {
    content: patched,
    appliedRules
  };
}
