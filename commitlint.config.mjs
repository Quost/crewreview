// Conventional Commits: https://www.conventionalcommits.org
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [1, 'always', [
      'core', 'harness', 'engine', 'cli', 'i18n', 'hosts', 'web', 'desktop', 'site', 'ci', 'release', 'deps', 'docs',
    ]],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 100],
    'trailer-exists': [2, 'always', 'Signed-off-by:'],
  },
};
