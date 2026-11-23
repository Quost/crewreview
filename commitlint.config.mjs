// Conventional Commits: https://www.conventionalcommits.org
export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot's commits carry changelogs with long lines (and its own sign-off). The PR title, which becomes the
  // squashed commit's title on main, is still checked by the pr-title job.
  ignores: [(message) => /^Signed-off-by: dependabot\[bot\]/m.test(message)],
  rules: {
    'scope-enum': [1, 'always', [
      'core', 'harness', 'engine', 'cli', 'i18n', 'hosts', 'web', 'desktop', 'site', 'ci', 'release', 'deps', 'docs',
    ]],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 100],
    'trailer-exists': [2, 'always', 'Signed-off-by:'],
  },
};
