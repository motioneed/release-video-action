import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promptFromRelease, readInputs } from "./lib.mjs";

const entry = fileURLToPath(new URL("./index.mjs", import.meta.url));

test("release notes become a short prompt about what is new", () => {
  const body = [
    "<!-- Release notes generated using configuration in .github/release.yml -->",
    "## What's Changed",
    "* **Dark mode** for the editor by @ana in https://github.com/acme/app/pull/12",
    "* Bulk export to [CSV](https://acme.dev/docs) by @bo in #13",
    "![shot](https://x/y.png)",
    "## New Contributors",
    "* @cy made their first contribution in https://github.com/acme/app/pull/14",
    "**Full Changelog**: https://github.com/acme/app/compare/v2.2...v2.3",
  ].join("\n");
  const prompt = promptFromRelease({ tag_name: "v2.3", name: "Spring update", body }, "https://acme.dev");
  assert.equal(prompt, "Launch video for release Spring update (v2.3) of https://acme.dev. Show what is new:\n- Dark mode for the editor\n- Bulk export to CSV");
  assert.equal(promptFromRelease({ tag_name: "v1.0" }), "Launch video for release v1.0.");
  const long = promptFromRelease({ tag_name: "v9", body: "- word ".repeat(300) });
  assert.ok(long.length <= 600 && long.endsWith("…"));
});

test("inputs are checked before anything is spent", () => {
  const base = { "INPUT_API-KEY": "mk_x", INPUT_SECONDS: "15", INPUT_ASPECTS: "16:9, 9:16,16:9" };
  const inputs = readInputs(base);
  assert.deepEqual(inputs.aspects, ["16:9", "9:16"]);
  assert.equal(inputs.upload, true);
  assert.equal(inputs.purpose, "launch");
  assert.throws(() => readInputs({ ...base, "INPUT_API-KEY": "" }), /api-key is required/);
  assert.throws(() => readInputs({ ...base, INPUT_ASPECTS: "1:1" }), /aspects/);
  assert.throws(() => readInputs({ ...base, INPUT_SECONDS: "12" }), /seconds/);
  assert.throws(() => readInputs({ ...base, INPUT_VOICE: "yes" }), /voice must be true or false/);
});

// A stand-in for Motioneed's /v1 and GitHub's uploads endpoint in one server.
async function mock(t, { fail = false } = {}) {
  const calls = [];
  const polls = new Map();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, type: req.headers["content-type"] });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const view = (id, status, extra = {}) => ({ id, status, stage: status, error: status === "failed" ? "page blocked" : null, video_url: status === "ready" ? `${origin}/v1/videos/${id}/video` : null, share_url: null, studio_url: `${origin}/watch/${id}`, ...extra });
      const json = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/v1/videos") {
        const id = `v${calls.filter((c) => c.url === "/v1/videos").length}`;
        return json(202, view(id, "queued"));
      }
      const one = req.url.match(/^\/v1\/videos\/(\w+)(\/\w+)?/);
      if (one && !one[2]) {
        const count = (polls.get(one[1]) || 0) + 1;
        polls.set(one[1], count);
        return json(200, view(one[1], count < 2 ? "running" : fail ? "failed" : "ready"));
      }
      if (one && one[2] === "/share") return json(200, view(one[1], "ready", { share_url: `${origin}/s/${one[1]}` }));
      if (one && one[2] === "/video") {
        res.writeHead(200, { "content-type": "video/mp4" });
        return res.end(Buffer.from("MP4DATA"));
      }
      if (req.method === "POST" && req.url.startsWith("/uploads/")) return json(201, { browser_download_url: `${origin}/dl/${new URL(req.url, origin).searchParams.get("name")}` });
      json(404, { error: { code: "not_found", message: "no" } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { calls, origin: `http://127.0.0.1:${server.address().port}` };
}

function action(env, event) {
  const dir = mkdtempSync(join(tmpdir(), "release-video-"));
  const files = { GITHUB_OUTPUT: join(dir, "out"), GITHUB_STEP_SUMMARY: join(dir, "summary"), GITHUB_EVENT_PATH: join(dir, "event.json") };
  for (const file of Object.values(files)) writeFileSync(file, "");
  writeFileSync(files.GITHUB_EVENT_PATH, JSON.stringify(event));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH, MOTIONEED_POLL_MS: "10", ...files, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("exit", (code) => resolve({ code, stdout, outputs: readFileSync(files.GITHUB_OUTPUT, "utf8"), summary: readFileSync(files.GITHUB_STEP_SUMMARY, "utf8") }));
  });
}

test("a published release gets one video per frame, attached and shared", async (t) => {
  const { calls, origin } = await mock(t);
  const release = { tag_name: "v2.3", name: "v2.3", body: "* Dark mode", upload_url: `${origin}/uploads/repos/acme/app/releases/1/assets{?name,label}` };
  const run = await action({ "INPUT_API-KEY": "mk_secret", INPUT_URL: "https://acme.dev", INPUT_ASPECTS: "16:9,9:16", "INPUT_API-BASE": origin, "INPUT_GITHUB-TOKEN": "ghs_token" }, { release });
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stdout, /::add-mask::mk_secret/);
  const created = calls.filter((c) => c.url === "/v1/videos").map((c) => JSON.parse(c.body));
  assert.deepEqual(created.map((c) => c.aspect), ["16:9", "9:16"]);
  assert.equal(created[0].url, "https://acme.dev");
  assert.match(created[0].prompt, /release v2\.3 of https:\/\/acme\.dev\. Show what is new:\n- Dark mode/);
  assert.equal(created[0].purpose, "launch");
  assert.ok(calls.filter((c) => c.url.startsWith("/v1/")).every((c) => c.auth === "Bearer mk_secret"));
  const uploads = calls.filter((c) => c.url.startsWith("/uploads/"));
  assert.deepEqual(uploads.map((c) => new URL(c.url, origin).searchParams.get("name")), ["motioneed-v2.3-16x9.mp4", "motioneed-v2.3-9x16.mp4"]);
  assert.ok(uploads.every((c) => c.auth === "Bearer ghs_token" && c.type === "video/mp4" && c.body === "MP4DATA"));
  assert.match(run.outputs, /video-id<<\S+\nv1\n/);
  assert.match(run.outputs, new RegExp(`share-url<<\\S+\\n${origin}/s/v1\\n`));
  assert.equal(JSON.parse(run.outputs.match(/videos<<(\S+)\n([\s\S]*?)\n\1/)[2]).length, 2);
  assert.match(run.summary, /Motioneed videos for v2\.3/);
  assert.match(run.summary, /\[MP4\]\(.*motioneed-v2\.3-9x16\.mp4\)/);
});

test("a manual run with a prompt needs no release and uploads nothing", async (t) => {
  const { calls, origin } = await mock(t);
  const run = await action({ "INPUT_API-KEY": "mk_x", INPUT_PROMPT: "Our new budgeting app", INPUT_SHARE: "false", "INPUT_API-BASE": origin }, {});
  assert.equal(run.code, 0, run.stdout);
  assert.equal(JSON.parse(calls.find((c) => c.url === "/v1/videos").body).prompt, "Our new budgeting app");
  assert.equal(calls.filter((c) => c.url.startsWith("/uploads/") || c.url.endsWith("/share")).length, 0);
});

test("a failed video, a missing source or an API refusal fails the step", async (t) => {
  const { origin } = await mock(t, { fail: true });
  const failed = await action({ "INPUT_API-KEY": "mk_x", INPUT_URL: "https://acme.dev", "INPUT_API-BASE": origin }, {});
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /::error::The 16:9 video failed: page blocked/);
  const empty = await action({ "INPUT_API-KEY": "mk_x", "INPUT_API-BASE": origin }, {});
  assert.equal(empty.code, 1);
  assert.match(empty.stdout, /::error::Set url or prompt/);
  const refused = await action({ "INPUT_API-KEY": "mk_x", INPUT_PROMPT: "x y", "INPUT_API-BASE": `${origin}/nope` }, {});
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /::error::Motioneed: no \(not_found\)/);
});
