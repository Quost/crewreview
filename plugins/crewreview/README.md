# Crewreview plugin for Claude Code

Adds the [Crewreview](https://crewreview.pururucos.com.br/?ref=claude-plugin) MCP server, a skill and the `/crewreview` command, so Claude Code can review your branch before you commit, check what the crew is doing, read the inbox, link repositories and explain settings when you ask. It never approves, posts or pushes for you.

Needs the `crewreview` binary on your PATH:

```bash
curl -fsSL https://crewreview.pururucos.com.br/install.sh | sh
```

Install the plugin:

```text
/plugin marketplace add Quost/crewreview
/plugin install crewreview@crewreview
```
