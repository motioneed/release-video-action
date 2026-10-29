#!/usr/bin/env node
// Entry for the GitHub Actions runner: inputs from INPUT_*, the event from GITHUB_EVENT_PATH,
// outputs to GITHUB_OUTPUT and a table to GITHUB_STEP_SUMMARY.
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readInputs, run, summary } from "./lib.mjs";

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const mark = `ghadelimiter_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${mark}\n${value}\n${mark}\n`);
}

try {
  const inputs = readInputs();
  console.log(`::add-mask::${inputs.apiKey}`);
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const pollMs = Number(process.env.MOTIONEED_POLL_MS) || 20_000;
  const videos = await run(inputs, event, { pollMs });
  const [first] = videos;
  setOutput("video-id", first.id);
  setOutput("video-url", first.video_url || "");
  setOutput("share-url", first.share_url || "");
  setOutput("studio-url", first.studio_url || "");
  setOutput("videos", JSON.stringify(videos));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(videos, event.release));
  console.log(summary(videos, event.release));
} catch (error) {
  console.log(`::error::${String(error?.message || error).replace(/\r?\n/g, " ")}`);
  process.exitCode = 1;
}
