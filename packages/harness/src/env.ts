/** Host and cloud credentials never reach an agent: the orchestrator is the one that talks to the git host. */
const ALWAYS_DROP = [
  /^GH_/, /^GITHUB_/, /^GITLAB_/, /^GLAB_/, /^BITBUCKET_/, /^AZURE_DEVOPS/, /^SYSTEM_ACCESSTOKEN$/, /^CI_JOB_TOKEN$/,
  /^NPM_TOKEN$/, /^NODE_AUTH_TOKEN$/, /^AWS_/, /^GOOGLE_APPLICATION_CREDENTIALS$/, /^AZURE_/, /^ARM_/,
  /^SSH_AUTH_SOCK$/, /^DOCKER_/, /^KUBECONFIG$/, /^CREWREVIEW_TOKEN/,
];

/** Anything that looks like a secret is dropped too, unless the adapter needs it to sign in to its own provider. */
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY|SESSION_?KEY)/i;

export interface ScrubOptions {
  /** Variables the harness needs for its own login (e.g. ANTHROPIC_API_KEY). */
  keep?: readonly RegExp[];
  /** Names the user explicitly passes through in config. These win over everything. */
  passthrough?: readonly string[];
}

export function scrubEnv(env: Record<string, string | undefined>, options: ScrubOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const pass = new Set(options.passthrough ?? []);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (pass.has(k)) {
      out[k] = v;
      continue;
    }
    if (ALWAYS_DROP.some((re) => re.test(k))) continue;
    if (SECRETISH.test(k) && !(options.keep ?? []).some((re) => re.test(k))) continue;
    out[k] = v;
  }
  out.NO_COLOR = "1";
  out.CREWREVIEW_AGENT = "1";
  return out;
}
