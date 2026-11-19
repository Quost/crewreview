# Contributing to Crewreview

Thanks for wanting to help! Please follow the [code of conduct](CODE_OF_CONDUCT.md). Found a security problem? Report it privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Getting started

You need [Bun](https://bun.sh) 1.3+ and git.

```bash
git clone https://github.com/Quost/crewreview
cd crewreview
bun install
bun run check      # typecheck, tests, translations, changelog
bun run dev help   # run the CLI from source
```

## Layout

| Path | What lives there |
|---|---|
| `packages/core` | Pure rules: the data model, diff parsing, evidence checks, dedupe, the verdict, agent output parsing. No I/O. |
| `packages/harness` | Adapters for each harness, the ACP client, the flag deny-list, the conformance test. |
| `packages/engine` | Config, git, the review pipeline, prompts, lens rubrics, reports. |
| `packages/i18n` | Interface strings in every language. |
| `apps/cli` | The `crewreview` command. |
| `scripts` | Build, translation and changelog checks. |

## Rules of the road

- **Rules stay pure.** Anything that decides (verdicts, dedupe, eligibility, what to fix) goes in `packages/core` with tests. I/O goes elsewhere.
- **The model proposes, code decides.** Never let an agent's answer pick the verdict or decide what gets posted without a rule in code.
- **Agents never get more than they need.** Read-only roles stay read-only, host tokens never reach an agent, and nothing gets added to the flag deny-list exceptions.
- **Every user-facing string is translated.** Add the key to `packages/i18n/locales/en.json` and to every other locale; `bun run check:l10n` fails otherwise. If you can't translate, copy the English text and say so in the PR.
- **Write it yourself.** Don't paste code, prompts or rubrics from other projects unless their license allows it and you say where they came from.
- **Changelog.** Add a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything users will notice.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`. The subject starts in lowercase, and no line is longer than 100 characters. Scopes: `core`, `harness`, `engine`, `cli`, `i18n`, `hosts`, `web`, `desktop`, `site`, `ci`, `release`, `deps`, `docs`.

### Sign-off (DCO)

Crewreview uses the [Developer Certificate of Origin](https://developercertificate.org) instead of a CLA. Sign off every commit to certify that you wrote it or have the right to submit it under the project's license:

```bash
git commit -s -m "fix(core): keep findings on renamed files"
```

That adds `Signed-off-by: Your Name <you@example.com>`. There is no CLA on purpose: nobody, the maintainer included, can relicense your contribution as closed source.

## Pull requests

Keep them focused. Describe what changed and how you tested it. CI runs the typecheck, the tests and the translation check on macOS, Linux and Windows.
