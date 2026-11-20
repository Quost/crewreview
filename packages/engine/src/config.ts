import { readFile } from "node:fs/promises";
import { BALANCES, DEFAULT_POLICY, DEFAULT_RULES, SEVERITIES } from "@crewreview/core";
import { z } from "zod";
import { configFile } from "./paths.ts";

/** "90s", "20m", "1h", "1500ms" or a number of milliseconds. */
export function parseDuration(v: string | number): number {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(v.trim());
  if (!m) throw new Error(`invalid duration "${v}" (use 90s, 20m, 1h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

const Duration = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

const HarnessSettings = z
  .object({
    executable: z.string().optional(),
    envPassthrough: z.array(z.string()).optional(),
    isolate: z.boolean().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
  })
  .strict();

const AcpAgent = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().optional(),
    command: z.array(z.string()).min(1),
    authEnv: z.array(z.string()).optional(),
    envPassthrough: z.array(z.string()).optional(),
  })
  .strict();

const CustomHarness = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().optional(),
    read: z.array(z.string()).min(1).optional(),
    write: z.array(z.string()).min(1).optional(),
    output: z.enum(["text", "claude-stream-json", "codex-jsonl"]).optional(),
    authEnv: z.array(z.string()).optional(),
    envPassthrough: z.array(z.string()).optional(),
  })
  .strict();

const Severity = z.enum(SEVERITIES);

const SEAT_ID = /^[a-z0-9][a-z0-9-]*$/;

/** One agent the crew can hire: a harness, and the model and effort to ask it for. */
const Seat = z
  .object({
    harness: z.string().regex(SEAT_ID),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    /** Most agent runs this seat makes a day. Unset: only the overall limits.dailyRuns. */
    dailyRuns: z.number().int().min(1).optional(),
  })
  .strict();

/** The seats that may do a job, by seat name (or a harness id, for that harness with its own settings), and how to share it. */
const Role = z.union([
  z
    .array(z.string().regex(SEAT_ID))
    .min(1)
    .transform((seats) => ({ seats, balance: "order" as const })),
  z
    .object({ seats: z.array(z.string().regex(SEAT_ID)).min(1), balance: z.enum(BALANCES).default("order") })
    .strict(),
]);

export const ConfigSchema = z
  .object({
    /** Interface language. Unset: the system language. */
    language: z.string().optional(),
    harness: z
      .object({
        default: z.string().default("auto"),
        /** Harness for the verifier. A different vendor than the lenses makes a stronger check. */
        verifier: z.string().optional(),
        /** Harnesses that take over, in order, while the chosen one is paused at its usage limit. */
        fallback: z.array(z.string()).optional(),
        claude: HarnessSettings.optional(),
        codex: HarnessSettings.optional(),
        kiro: HarnessSettings.optional(),
        acp: z.array(AcpAgent).default([]),
        custom: z.array(CustomHarness).default([]),
      })
      .strict()
      .prefault({}),
    /** Seats, by a name you choose (docs/plans/crew-mode.md). */
    seats: z.record(z.string().regex(SEAT_ID), Seat).default({}),
    /** Which seats do each job. A job left out works as before: harness.default, verifier and fallback. */
    roles: z
      .object({ review: Role.optional(), verify: Role.optional(), attend: Role.optional() })
      .strict()
      .prefault({}),
    limits: z
      .object({
        maxConcurrentAgents: z.number().int().min(1).max(32).optional(),
        agentTimeout: Duration.default(20 * 60_000),
        stallTimeout: Duration.default(8 * 60_000),
        maxDiffLines: z.number().int().min(1).default(4000),
        /** Most agent runs a day (each lens, verifier and attendant run counts one). Unset: no limit. */
        dailyRuns: z.number().int().min(1).optional(),
      })
      .strict()
      .prefault({}),
    schedule: z
      .object({
        /** How often linked repositories are checked during peak hours. */
        interval: Duration.default(3 * 60_000),
        /** And outside them. */
        offHoursInterval: Duration.default(20 * 60_000),
        /** Local hours, "8-19". Weekends count as off hours. */
        peakHours: z.string().regex(/^\d{1,2}-\d{1,2}$/).default("8-19"),
        maxReviewsPerCycle: z.number().int().min(1).max(50).default(2),
        /** Keep the computer from sleeping (not the screen) while agents work, so a job isn't cut off halfway. */
        keepAwake: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    updates: z
      .object({
        /** Look for a new release once a day while the daemon runs. */
        check: z.boolean().default(true),
        /** Install it when idle, then exit so the service manager restarts the new binary. */
        auto: z.boolean().default(false),
        channel: z.enum(["stable", "beta"]).default("stable"),
      })
      .strict()
      .prefault({}),
    attend: z
      .object({
        /** Wait until the newest comment is this old, so a whole review lands first. */
        quiet: Duration.default(45_000),
        /** Time limit for each validation command. */
        validateTimeout: Duration.default(10 * 60_000),
        maxPerCycle: z.number().int().min(1).max(50).default(2),
      })
      .strict()
      .prefault({}),
    review: z
      .object({
        /** Wait after a new head appears before reviewing it. */
        settle: Duration.default(DEFAULT_RULES.settleMs),
        /** Wait for running CI up to this long. */
        ciMaxWait: Duration.default(DEFAULT_RULES.ciMaxWaitMs),
        maxFailures: z.number().int().min(1).default(DEFAULT_RULES.maxFailures),
        lenses: z.array(z.string()).default(["correctness", "security", "architecture", "tests", "ui"]),
        verifier: z.boolean().default(true),
        /** Language the agents write findings in. Unset: the interface language. */
        commentLanguage: z.string().optional(),
        policy: z
          .object({
            requestChangesAt: Severity.default(DEFAULT_POLICY.requestChangesAt),
            allowApprove: z.boolean().default(DEFAULT_POLICY.allowApprove),
            approveBlockedAt: Severity.default(DEFAULT_POLICY.approveBlockedAt),
            approveMaxChangedLines: z.number().int().min(0).default(DEFAULT_POLICY.approveMaxChangedLines),
            requireVerifier: z.boolean().default(DEFAULT_POLICY.requireVerifier),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Config = z.output<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseConfig(value: unknown, path = "<inline>"): Config {
  const r = ConfigSchema.safeParse(value ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(path, msg);
  }
  return r.data;
}

/** Load the user's config. A missing file means defaults. */
export async function loadConfig(path = configFile()): Promise<{ config: Config; path: string; exists: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: parseConfig({}), path, exists: false };
    throw new ConfigError(path, (e as Error).message);
  }
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    throw new ConfigError(path, (e as Error).message);
  }
  return { config: parseConfig(raw, path), path, exists: true };
}

export function defaultConcurrency(cpus: number): number {
  return Math.max(1, Math.min(4, Math.floor(cpus / 2)));
}
