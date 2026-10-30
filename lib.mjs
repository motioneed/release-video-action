// Motioneed release video (spec 511): the parts that do not touch the runner, kept apart so they can be tested.
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const ASPECTS = ["16:9", "9:16", "4:3", "3:4"];
export const SECONDS = [10, 15, 30, 60, 90];
const PROMPT_MAX = 600;

/** Release notes as a prompt: what is new, without images, markup, contributor lists or links back. */
export function promptFromRelease(release = {}, product = "") {
  const tag = String(release.tag_name || "").trim();
  const name = String(release.name || "").trim();
  const title = name && name !== tag ? `${name} (${tag})` : name || tag;
  const notes = String(release.body || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<img[^>]*>/gi, "")
    .split("\n")
    .filter((line) => !/^\s*\**Full Changelog\**:/i.test(line) && !/^\s*#+\s*(New Contributors|What.s Changed)\s*$/i.test(line) && !/made their first contribution/i.test(line))
    .map((line) => line
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+by @[\w-]+ in (https?:\/\/\S+|#\d+)\s*$/i, "")
      .replace(/^\s*#+\s*/, "")
      .replace(/^\s*[-*+]\s+/, "- ")
      .replace(/[*_`]/g, "")
      .trimEnd())
    .filter((line) => line.trim())
    .join("\n");
  const head = `Launch video for ${title ? `release ${title}` : "a new release"}${product ? ` of ${product}` : ""}. Show what is new:`;
  const text = notes ? `${head}\n${notes}` : head.replace(/ Show what is new:$/, "");
  return text.length > PROMPT_MAX ? `${text.slice(0, PROMPT_MAX - 1).replace(/\s+\S*$/, "")}…` : text;
}

export const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Only these hosts ever see the job's token: release-note screenshots live there, private repos' too.
const GITHUB_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "user-images.githubusercontent.com", "private-user-images.githubusercontent.com", "objects.githubusercontent.com"]);
const MAGIC = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  gif: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6)),
};

/** Screenshots and GIFs in release notes (spec 528), in order, once each: markdown images and <img> tags. */
export function releaseImages(body = "") {
  const text = String(body || "").replace(/<!--[\s\S]*?-->/g, "");
  const found = [];
  const pattern = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(pattern)) {
    const url = (match[2] || match[3] || "").trim();
    const alt = match[1] || (/\balt\s*=\s*["']([^"']*)["']/i.exec(match[0]) || [])[1] || "";
    if (/^https?:\/\//i.test(url) && !found.some((item) => item.source === url)) found.push({ source: url, name: alt.trim().slice(0, 60), use: "screen" });
  }
  return found;
}

const lines = (value) => String(value || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));

/**
 * Every image for this video as `{ data, use, name }`: release-note images first, then `images`, then
 * `style-images`, up to 10. A URL is downloaded here (with the token only for GitHub hosts, so
 * private-repo screenshots work) and a repo path is read from the workspace. One that fails is a
 * warning and is left out; the video goes on.
 */
export async function collectImages(inputs, release, { warn = () => {}, fetcher = fetch, workspace = process.env.GITHUB_WORKSPACE || process.cwd() } = {}) {
  const wanted = [
    ...(inputs.releaseImages && release ? releaseImages(release.body) : []),
    ...inputs.images.map((source) => ({ source, name: "", use: "screen" })),
    ...inputs.styleImages.map((source) => ({ source, name: "", use: "style" })),
  ];
  if (wanted.length > MAX_IMAGES) warn(`${wanted.length} images found; using the first ${MAX_IMAGES}.`);
  const out = [];
  for (const item of wanted.slice(0, MAX_IMAGES)) {
    try {
      const bytes = /^https?:\/\//i.test(item.source) ? await download(item.source, inputs.githubToken, fetcher) : await fromWorkspace(item.source, workspace);
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("it is over 5 MB");
      const kind = Object.keys(MAGIC).find((name) => MAGIC[name](bytes));
      if (!kind) throw new Error("it is not a PNG, JPEG, WebP or GIF");
      const name = item.name || item.source.split(/[/?#]/).filter(Boolean).pop()?.replace(/\.[a-z0-9]+$/i, "") || "";
      out.push({ data: `data:image/${kind};base64,${bytes.toString("base64")}`, use: item.use, name: name.slice(0, 60) });
    } catch (error) {
      warn(`Image ${item.source} left out: ${error instanceof Error ? error.message : error}.`);
    }
  }
  return out;
}

/** github.com/o/r/raw|blob/ref/path only answers a browser session; the raw host takes the token. */
export function rawUrl(source) {
  const url = new URL(source);
  const match = url.hostname === "github.com" && /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/.exec(url.pathname);
  return match ? new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`) : url;
}

async function download(source, token, fetcher) {
  const url = rawUrl(source);
  const headers = token && url.protocol === "https:" && GITHUB_HOSTS.has(url.hostname) ? { authorization: `Bearer ${token}` } : {};
  const response = await fetcher(url, { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error("it is over 5 MB");
  return Buffer.from(await response.arrayBuffer());
}

async function fromWorkspace(source, workspace) {
  const file = resolve(workspace, source);
  const inside = relative(resolve(workspace), file);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("the path is outside the repository");
  try {
    return await readFile(file);
  } catch {
    throw new Error("no such file in the workspace (add actions/checkout before this step)");
  }
}

export function readInputs(env = process.env) {
  const input = (name, fallback = "") => String(env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? fallback).trim();
  const flag = (name, fallback) => {
    const value = input(name, String(fallback)).toLowerCase();
    if (!["true", "false"].includes(value)) throw new Error(`${name} must be true or false.`);
    return value === "true";
  };
  const aspects = [...new Set(input("aspects", "16:9").split(",").map((item) => item.trim()).filter(Boolean))];
  for (const aspect of aspects) if (!ASPECTS.includes(aspect)) throw new Error(`aspects: ${aspect} is not one of ${ASPECTS.join(", ")}.`);
  const seconds = Number(input("seconds", "15"));
  if (!SECONDS.includes(seconds)) throw new Error(`seconds must be one of ${SECONDS.join(", ")}.`);
  const timeout = Number(input("timeout-minutes", "20"));
  if (!(timeout > 0)) throw new Error("timeout-minutes must be a positive number.");
  const apiKey = input("api-key");
  if (!apiKey) throw new Error("api-key is required. Create one at https://www.motioneed.com/account.");
  return {
    apiKey,
    url: input("url"),
    prompt: input("prompt"),
    seconds,
    aspects: aspects.length ? aspects : ["16:9"],
    purpose: input("purpose", "launch") || "launch",
    voice: flag("voice", false),
    upload: flag("upload", true),
    share: flag("share", true),
    timeoutMs: timeout * 60 * 1000,
    githubToken: input("github-token"),
    releaseImages: flag("release-images", true),
    images: lines(input("images")),
    styleImages: lines(input("style-images")),
    apiBase: input("api-base", "https://www.motioneed.com").replace(/\/+$/, "") || "https://www.motioneed.com",
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(inputs, path, init = {}) {
  const response = await fetch(`${inputs.apiBase}/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${inputs.apiKey}`, "content-type": "application/json", "user-agent": "motioneed-release-video-action", ...(init.headers || {}) },
  });
  if (init.raw) {
    if (!response.ok) throw new Error(`Motioneed answered ${response.status} for ${path}.`);
    return response;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Motioneed: ${body.error?.message || `HTTP ${response.status}`}${body.error?.code ? ` (${body.error.code})` : ""}`);
  return body;
}

/**
 * Make one video per aspect, wait for each, attach it to the release and share it.
 * `log` and `pollMs` let tests run fast and quiet.
 */
export async function run(inputs, event = {}, { log = console.log, warn = (text) => log(`::warning::${text}`), pollMs = 20_000, fetcher = fetch, workspace } = {}) {
  const release = event.release || null;
  const prompt = inputs.prompt || (release ? promptFromRelease(release, inputs.url) : "");
  if (!inputs.url && !prompt) throw new Error("Set url or prompt, or run on a release event.");
  const images = await collectImages(inputs, release, { warn, fetcher, workspace });
  if (images.length) log(`Images: ${images.length} (${images.filter((image) => image.use === "screen").length} on screen)`);
  const tag = String(release?.tag_name || "").replace(/[^\w.-]+/g, "-") || "video";
  const started = [];
  for (const aspect of inputs.aspects) {
    const video = await api(inputs, "/videos", { method: "POST", body: JSON.stringify({ url: inputs.url || undefined, prompt: prompt || undefined, seconds: inputs.seconds, aspect, purpose: inputs.purpose, voice: inputs.voice, images: images.length ? images : undefined}) });
    log(`Started ${aspect} video ${video.id}`);
    started.push({ aspect, video });
  }
  const deadline = Date.now() + inputs.timeoutMs;
  const done = [];
  for (const item of started) {
    let video = item.video;
    while (video.status !== "ready") {
      if (video.status === "failed") throw new Error(`The ${item.aspect} video failed: ${video.error || "no reason given"}. See ${video.studio_url}`);
      if (Date.now() > deadline) throw new Error(`The ${item.aspect} video was not ready in time. It keeps going: ${video.studio_url}`);
      await sleep(pollMs);
      video = await api(inputs, `/videos/${video.id}`);
      log(`${item.aspect}: ${video.stage}`);
    }
    if (inputs.share) video = await api(inputs, `/videos/${video.id}/share`, { method: "POST", body: JSON.stringify({ on: true }) });
    let asset = null;
    if (inputs.upload && release?.upload_url) {
      const file = Buffer.from(await (await api(inputs, `/videos/${video.id}/video`, { raw: true })).arrayBuffer());
      const name = `motioneed-${tag}-${item.aspect.replace(":", "x")}.mp4`;
      const target = `${release.upload_url.replace(/\{[^}]*\}$/, "")}?name=${encodeURIComponent(name)}`;
      const uploaded = await fetch(target, { method: "POST", headers: { authorization: `Bearer ${inputs.githubToken}`, "content-type": "video/mp4", "content-length": String(file.length), accept: "application/vnd.github+json" }, body: file });
      if (!uploaded.ok) throw new Error(`Uploading ${name} to the release failed (${uploaded.status}). The token needs contents: write.`);
      asset = (await uploaded.json()).browser_download_url || null;
      log(`Attached ${name}`);
    }
    done.push({ aspect: item.aspect, id: video.id, video_url: video.video_url, share_url: video.share_url, studio_url: video.studio_url, release_asset: asset });
  }
  return done;
}

export function summary(videos, release) {
  const rows = videos.map((video) => `| ${video.aspect} | ${video.share_url ? `[Watch](${video.share_url})` : "—"} | ${video.release_asset ? `[MP4](${video.release_asset})` : "—"} | [Studio](${video.studio_url}) |`);
  return [`### Motioneed video${videos.length > 1 ? "s" : ""}${release?.tag_name ? ` for ${release.tag_name}` : ""}`, "", "| Frame | Share | Release asset | Edit |", "|---|---|---|---|", ...rows, ""].join("\n");
}
