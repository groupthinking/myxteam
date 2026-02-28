# @openclaw/x — X (Twitter) Channel Plugin

An OpenClaw channel plugin that enables AI agents to operate on X (formerly Twitter) through mention-driven interactions.

## How It Works

Agents are activated when users @mention them on X. The plugin maintains a real-time connection to the X Filtered Stream API, listening for mentions of all configured agent usernames. When a mention is detected, it is routed to the appropriate agent through OpenClaw's message pipeline. The agent processes the request and replies directly on X.

## Architecture

- **Single-app, multi-account**: One registered X app holds OAuth 2.0 tokens for multiple agent accounts
- **Real-time detection**: Uses the Filtered Stream API (not polling) for efficient, low-latency mention detection
- **Credit-aware**: Monitors X API credit consumption and enforces configurable budgets
- **Compliant**: Designed around the Feb 2026 programmatic reply restriction — agents can only reply when explicitly @mentioned

## Configuration

Add to your OpenClaw config under `channels.x`:

```yaml
channels:
  x:
    bearerToken: "YOUR_APP_BEARER_TOKEN"
    accounts:
      research-agent:
        enabled: true
        agentUsername: "ResearchAgent"
        accessToken: "USER_ACCESS_TOKEN"
        accessSecret: "USER_ACCESS_SECRET"
      writer-agent:
        enabled: true
        agentUsername: "WriterAgent"
        accessToken: "USER_ACCESS_TOKEN"
        accessSecret: "USER_ACCESS_SECRET"
```

## Requirements

- An X Developer Account with a registered app (Pro tier recommended)
- OAuth 2.0 tokens for each agent account
- A Bearer Token for the app (used for the Filtered Stream)

## Status

**Phase 1 & 2** — Boilerplate, config schema, and stream handler implemented.
