// Motioneed release video (spec 511): the parts that do not touch the runner, kept apart so they can be tested.
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
export async function run(inputs, event = {}, { log = console.log, pollMs = 20_000 } = {}) {
  const release = event.release || null;
  const prompt = inputs.prompt || (release ? promptFromRelease(release, inputs.url) : "");
  if (!inputs.url && !prompt) throw new Error("Set url or prompt, or run on a release event.");
  const tag = String(release?.tag_name || "").replace(/[^\w.-]+/g, "-") || "video";
  const started = [];
  for (const aspect of inputs.aspects) {
    const video = await api(inputs, "/videos", { method: "POST", body: JSON.stringify({ url: inputs.url || undefined, prompt: prompt || undefined, seconds: inputs.seconds, aspect, purpose: inputs.purpose, voice: inputs.voice }) });
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
