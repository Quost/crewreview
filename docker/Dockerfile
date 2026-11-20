# Crewreview on a shared team machine: the daemon, git, and the Claude Code and Codex CLIs.
#
#   docker build -t crewreview https://github.com/Quost/crewreview.git#main:docker
#
# It installs the release binary for VERSION after checking it against the release's signed checksums, with the
# same key `crewreview update` uses. The guide: docs/team-machine.md.
FROM node:22-bookworm-slim

ARG VERSION=0.6.0
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git minisign tini \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) arch=x64 ;; \
    arm64) arch=arm64 ;; \
    *) echo "Crewreview has no Linux build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  base="https://github.com/Quost/crewreview/releases/download/v${VERSION}"; \
  cd /tmp; \
  curl -fsSL -O "$base/SHA256SUMS" -O "$base/SHA256SUMS.minisig" -O "$base/crewreview-linux-$arch"; \
  minisign -Vm SHA256SUMS -P RWTk8l0TkAFZQOxVkYWEHrU6Nj+j1UTCGOMps627c4qsvaX3fvRFzhpx; \
  grep " crewreview-linux-$arch\$" SHA256SUMS | sha256sum -c -; \
  install -m 0755 "crewreview-linux-$arch" /usr/local/bin/crewreview; \
  rm -f SHA256SUMS SHA256SUMS.minisig "crewreview-linux-$arch"; \
  crewreview --version

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

RUN useradd --create-home --uid 10001 crew && mkdir -p /data && chown crew:crew /data
USER crew
WORKDIR /home/crew

# Everything that should survive a rebuild lives in /data: Crewreview's config, repositories, inbox and history, and
# the agents' logins when you sign in inside the container.
ENV CREWREVIEW_HOME=/data \
  CLAUDE_CONFIG_DIR=/data/claude \
  CODEX_HOME=/data/codex \
  DISABLE_AUTOUPDATER=1
VOLUME ["/data"]

ENTRYPOINT ["tini", "--", "crewreview"]
CMD ["run", "--port", "4620"]
