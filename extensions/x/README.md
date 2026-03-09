# @openclaw/x — X (Twitter) Channel Plugin

An OpenClaw channel plugin that enables AI agents to operate on X (formerly Twitter) through mention-driven interactions.

## How It Works

Agents are activated when users @mention them on X. The plugin maintains a real-time connection to the X Filtered Stream API, listening for mentions of all configured agent usernames. When a mention is detected, it is routed to the appropriate agent through OpenClaw's message pipeline. The agent processes the request and replies directly on X.

## Architecture

- **Single-app, multi-account**: One registered X app holds OAuth 2.0 tokens for multiple agent accounts
- **Real-time detection**: Uses the Filtered Stream API (not polling) for efficient, low-latency mention detection
- **OAuth 2.0 token refresh**: Automatic token rotation with configurable refresh intervals and error handling
- **Dual-layer rate limiting**: App-level and per-user sliding-window rate limiters prevent API throttling
- **Credit-aware**: Monitors X API credit consumption and enforces configurable budgets
- **Compliant**: Designed around the Feb 2026 programmatic reply restriction — agents can only reply when explicitly @mentioned

## File Structure

```
extensions/x/
├── index.ts                    # Plugin entrypoint — registers with OpenClaw
├── package.json                # Extension package with OpenClaw channel metadata
├── openclaw.plugin.json        # Plugin manifest
├── tsconfig.json               # TypeScript configuration
├── vitest.config.ts            # Test configuration
├── README.md                   # This file
├── src/
    ├── channel.ts              # ChannelPlugin implementation (config, gateway, outbound, mentions)
    ├── config-schema.ts        # Zod validation schema for X channel config
    ├── types.ts                # Account resolution helpers and type definitions
    ├── runtime.ts              # OpenClaw runtime accessor (set during plugin registration)
    ├── stream-handler.ts       # Filtered Stream connection with reconnection + backoff
    ├── x-api-client.ts         # X API v2 client (posts, users, threads, usage)
    ├── token-refresh.ts        # OAuth 2.0 token refresh with proactive rotation
    ├── rate-limiter.ts         # Sliding-window token bucket rate limiter
    ├── credit-budget.ts        # X API credit budget enforcement
    ├── smart-reply.ts          # Intent/sentiment classification pipeline
    ├── llm-client.ts           # Lightweight multi-provider LLM client
    ├── event-bus.ts            # Internal typed event bus for pipeline routing
    ├── thread-state.ts         # Per-conversation thread-chaining state
    ├── oauth1.ts               # OAuth 1.0a HMAC-SHA1 request signing
    └── __tests__/
        ├── rate-limiter.test.ts      # Rate limiter unit tests
        ├── token-refresh.test.ts     # Token refresh unit tests
        ├── types.test.ts             # Account resolution unit tests
        ├── x-api-client.test.ts      # API client unit tests
        ├── stream-handler.test.ts    # Stream handler unit tests
        ├── smart-reply.test.ts       # Smart reply pipeline unit tests
        ├── llm-client.test.ts        # LLM client unit tests
        ├── event-bus.test.ts         # Event bus unit tests
        ├── credit-budget.test.ts     # Credit budget unit tests
        ├── thread-state.test.ts      # Thread state unit tests
        └── integration-setup.ts      # Mock X API server for integration testing
```

## Configuration

Add to your OpenClaw config under `channels.x`:

**OAuth 2.0 (recommended for new apps):**

```yaml
channels:
  x:
    bearerToken: "YOUR_APP_BEARER_TOKEN"
    clientId: "YOUR_OAUTH2_CLIENT_ID" # For token refresh
    clientSecret: "YOUR_OAUTH2_CLIENT_SECRET" # For token refresh
    creditBudget: 10000 # Monthly credit cap (optional)
    usageCheckIntervalMinutes: 60 # How often to check credit usage
    accounts:
      research-agent:
        enabled: true
        agentUsername: "ResearchAgent"
        accessToken: "USER_ACCESS_TOKEN"
        refreshToken: "USER_REFRESH_TOKEN" # For automatic token rotation
        name: "Research Agent"
      writer-agent:
        enabled: true
        agentUsername: "WriterAgent"
        accessToken: "USER_ACCESS_TOKEN"
        refreshToken: "USER_REFRESH_TOKEN"
        name: "Writer Agent"
```

**OAuth 1.0a (for apps using Consumer Key/Secret):**

```yaml
channels:
  x:
    bearerToken: "YOUR_APP_BEARER_TOKEN"
    oauth1ConsumerKey: "YOUR_CONSUMER_KEY" # API Key from Developer Portal
    oauth1ConsumerSecret: "YOUR_CONSUMER_SECRET"
    creditBudget: 10000
    accounts:
      agent-account:
        enabled: true
        agentUsername: "YourAgentUsername"
        oauth1AccessToken: "USER_OAUTH1_ACCESS_TOKEN"
        oauth1AccessTokenSecret: "USER_OAUTH1_ACCESS_TOKEN_SECRET"
        name: "My Agent"
```

## Requirements

- An X Developer Account with a registered app (Pro tier recommended)
- OAuth 2.0 tokens for each agent account (access token + refresh token)
- A Bearer Token for the app (used for the Filtered Stream)
- OAuth 2.0 Client ID and Client Secret (for automatic token refresh)

## Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run with coverage
pnpm test:coverage
```

## Rate Limiting

The plugin implements dual-layer rate limiting:

- **App-level**: Shared across all agents. Default: 300 posts per 15-minute window.
- **Per-user**: Independent per agent account. Default: 200 posts per 15-minute window.

When a rate limit is hit, the client will wait (up to 60 seconds by default) for a slot to open before failing. HTTP 429 responses from the X API are also detected and surfaced.

## Token Refresh

OAuth 2.0 tokens are automatically refreshed before expiry:

- Tokens are proactively refreshed 5 minutes before expiry
- Refresh uses the standard `POST /2/oauth2/token` endpoint with `grant_type=refresh_token`
- Failed refreshes are retried with exponential backoff
- An `onRefreshed` callback is provided for persisting new tokens to config

## Smart Reply (Intent Classification)

The smart-reply pipeline adds an optional LLM-powered classification layer for incoming mentions. When enabled, each mention is classified by **intent** and **sentiment** before being routed to OpenClaw's message pipeline.

### How It Works

1. **Classification**: A single LLM call classifies the mention into an intent category (`question`, `complaint`, `praise`, `request`, `social`, `spam`, `escalation`, `unknown`) and a sentiment (`positive`, `negative`, `neutral`).
2. **Routing**: Deterministic rules are applied on top of the LLM's suggestion:
   - `spam` intent is always routed to **ignore** (silently dropped).
   - `escalation` intent or low confidence (below threshold) is routed to **escalate** (forwarded with escalation metadata for human review).
   - All other intents with sufficient confidence are routed to **reply** (forwarded to the agent pipeline).
3. **Metadata**: The classification result is attached as `metadata.smartReply` on the inbound message, allowing downstream handlers to inspect intent, sentiment, and confidence.

When `useSmartReply` is `false` (the default), mentions flow straight to OpenClaw's pipeline with no LLM call — identical to the original behaviour.

### LLM Provider Configuration

The pipeline supports any **OpenAI-compatible chat completions endpoint**: Grok/xAI, OpenAI, Anthropic (via proxy), or self-hosted models. Configure the provider via the `smartReply` block:

```yaml
channels:
  x:
    useSmartReply: true
    smartReply:
      apiKey: "xai-..." # API key for the LLM provider
      model: "grok-2" # Model identifier (default: grok-2)
      baseUrl: "https://api.x.ai/v1" # Chat completions endpoint (default: xAI)
      temperature: 0.2 # Sampling temperature (default: 0.2)
      maxTokens: 200 # Max tokens per classification (default: 200)
      confidenceThreshold: 0.5 # Min confidence to auto-reply (default: 0.5)
```

| Parameter             | Default               | Description                                                      |
| --------------------- | --------------------- | ---------------------------------------------------------------- |
| `apiKey`              | _(required)_          | API key for the chosen LLM provider                              |
| `model`               | `grok-2`              | Model identifier                                                 |
| `baseUrl`             | `https://api.x.ai/v1` | Base URL for the chat completions endpoint                       |
| `temperature`         | `0.2`                 | Sampling temperature (0–2)                                       |
| `maxTokens`           | `200`                 | Maximum tokens to generate per classification                    |
| `confidenceThreshold` | `0.5`                 | Minimum confidence to auto-reply; below this triggers escalation |

## Status

**Phase 1–6 complete.** The plugin implements:

1. Boilerplate, config schema, and Zod validation
2. Filtered Stream handler with reconnection and backoff
3. Full runtime wiring — incoming mentions trigger agent responses via OpenClaw's message pipeline
4. OAuth 2.0 token refresh and dual-layer rate limiting
5. Unit tests for all modules and integration test setup
6. Smart-reply pipeline with LLM-powered intent classification and deterministic routing
