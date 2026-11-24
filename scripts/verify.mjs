#!/usr/bin/env -S node --experimental-strip-types
/**
 * Offline verifier for planHash and QueueEvent receipts. No RPC, no keys.
 * Usage:
 *   node --experimental-strip-types scripts/verify.mjs <input.json>
 *   node --experimental-strip-types scripts/verify.mjs --plan plan.json --events events.json
 * Exit 0 on PASS, 1 on FAIL.
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./resolve-ts.mjs", import.meta.url));

const { verifyOffline, formatReport, VERIFY_MAX } = await import("../packages/core/src/verifyOffline.ts");

const usage = () => {
  process.stderr.write(
    "uso: node --experimental-strip-types scripts/verify.mjs <input.json>\n" +
      "     node --experimental-strip-types scripts/verify.mjs --plan plan.json --events events.json\n",
  );
};

const failInput = (reason) => {
  process.stdout.write(`FAIL input: ${reason}\nRESULT FAIL\n`);
  process.exit(1);
};

const load = (file) => {
  let buf;
  try {
    buf = readFileSync(file);
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
    failInput(code === "ENOENT" ? `file non trovato (${file})` : (e instanceof Error ? e.message : String(e)));
  }
  if (buf.byteLength > VERIFY_MAX.jsonBytes) {
    failInput(`file oltre il massimo (${buf.byteLength} > ${VERIFY_MAX.jsonBytes} byte)`);
  }
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    failInput("JSON non valido");
  }
};

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(args.length === 0 ? 1 : 0);
}

let input;
if (args[0] === "--plan" || args[0] === "--events" || args.includes("--plan") || args.includes("--events")) {
  let planFile, eventsFile;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plan") planFile = args[++i];
    else if (args[i] === "--events") eventsFile = args[++i];
    else {
      usage();
      process.exit(1);
    }
  }
  if (!planFile && !eventsFile) {
    usage();
    process.exit(1);
  }
  const planPart = planFile ? load(planFile) : {};
  let events;
  if (eventsFile) {
    const evPart = load(eventsFile);
    events = evPart.events ?? evPart.receipts ?? (Array.isArray(evPart) ? evPart : undefined);
    if (events === undefined) {
      process.stdout.write("FAIL events: events/receipts deve essere una lista\nRESULT FAIL\n");
      process.exit(1);
    }
  }
  input = { ...planPart, ...(events !== undefined ? { events } : {}) };
} else if (args.length === 1 && !args[0].startsWith("-")) {
  input = load(args[0]);
} else {
  usage();
  process.exit(1);
}

const report = verifyOffline(input);
process.stdout.write(formatReport(report) + "\n");
process.exit(report.ok ? 0 : 1);
