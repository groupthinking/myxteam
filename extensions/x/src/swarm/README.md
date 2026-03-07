# X Agent Swarm

Multi-agent system for autonomous X (Twitter) interactions. Integrates with OpenClaw's X channel plugin.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Swarm Coordinator                           │
├─────────────────────────────────────────────────────────────────┤
│  Tier 1 (Parallel)          │  Tier 2 (Conditional)             │
│  ┌─────────────────┐        │  ┌─────────────────┐              │
│  │ ContextAnalyzer │        │  │ ActionPlanner   │              │
│  │ IntentClassifier│        │  │ ContentGenerator│              │
│  │ SentimentAnalyzer│       │  │ VerificationAgent│             │
│  └─────────────────┘        │  └─────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   X API Client  │
                    └─────────────────┘
```

## Quick Start

### 1. Install Dependencies

The swarm uses the same dependencies as the X channel. No additional packages required.

### 2. Configure Environment

Add to your `.env`:

```bash
# XAI API Key for Grok LLM
XAI_API_KEY=your_xai_api_key_here
```

### 3. Update OpenClaw Config

Add swarm configuration to your `openclaw.config.yaml`:

```yaml
channels:
  x:
    bearerToken: "your_bearer_token"
    clientId: "your_client_id"
    clientSecret: "your_client_secret"
    
    # Swarm configuration
    swarm:
      maxConcurrentTasks: 5
      taskTimeoutMs: 30000
      enableTier1Parallel: true
      enableTier2Parallel: true
      cacheResults: true
      cacheTtlMs: 3600000
    
    # LLM configuration
    llmConfig:
      apiKey: "${XAI_API_KEY}"
      model: "grok-2"
      temperature: 0.7
      maxTokens: 1000
    
    accounts:
      my-agent:
        agentUsername: "MyAgent"
        accessToken: "your_access_token"
```

### 4. Use Swarm-Enabled Channel

Replace the import in your channel entry point:

```typescript
// Before
import { XChannelPlugin } from "./channel.js";

// After
import { XChannelPluginWithSwarm } from "./swarm-integration.js";

// In your plugin registration
runtime.registerChannel(new XChannelPluginWithSwarm());
```

## Agent Descriptions

### Tier 1: Analysis Agents (Parallel)

| Agent | Purpose | Latency |
|-------|---------|---------|
| **ContextAnalyzer** | Fetches thread history, user context | 300-800ms |
| **IntentClassifier** | Determines user intent | 150-300ms |
| **SentimentAnalyzer** | Analyzes emotional tone | 150-250ms |

### Tier 2: Action Agents (Conditional)

| Agent | Purpose | Latency |
|-------|---------|---------|
| **ActionPlanner** | Decides which X actions to take | 200-400ms |
| **ContentGenerator** | Crafts replies | 300-600ms |
| **VerificationAgent** | Reviews content before posting | 200-400ms |

## Execution Flow

```
0ms     200ms   400ms   600ms   800ms
│        │       │       │       │
├────────┴───────┴───────┤       │
│  Tier 1 PARALLEL       │       │
│  (Context/Intent/Sentiment)    │
│                         │       │
│              ┌──────────┴───────┤
│              │  Context Fusion  │
│              └──────────┬───────┘
│                         │
│              ┌──────────┴──────────┐
│              │  Tier 2 Agents      │
│              │  (Plan/Generate/Verify)│
│              └──────────┬──────────┘
│                         │
│              ┌──────────┴──────────┐
│              │  Execute Action     │
│              └─────────────────────┘
```

**Total Latency: ~800-900ms**

## Configuration Options

### SwarmCoordinatorConfig

```typescript
interface SwarmCoordinatorConfig {
  maxConcurrentTasks: number;    // Max parallel tasks (default: 10)
  taskTimeoutMs: number;         // Task timeout (default: 30000)
  enableTier1Parallel: boolean;  // Run Tier 1 in parallel (default: true)
  enableTier2Parallel: boolean;  // Run Tier 2 in parallel (default: true)
  cacheResults: boolean;         // Enable LLM caching (default: true)
  cacheTtlMs: number;            // Cache TTL (default: 3600000)
}
```

### LLMConfig

```typescript
interface LLMConfig {
  apiKey: string;           // XAI API key (required)
  model?: string;           // Model name (default: "grok-2")
  temperature?: number;     // Sampling temp (default: 0.7)
  maxTokens?: number;       // Max tokens (default: 1000)
  baseUrl?: string;         // API base URL (optional)
}
```

## Metrics

The coordinator tracks detailed metrics:

```typescript
const metrics = swarmCoordinator.getMetrics();

console.log(metrics);
// {
//   totalTasks: 150,
//   successfulTasks: 145,
//   failedTasks: 5,
//   successRate: 0.9667,
//   averageExecutionTimeMs: 850,
//   agentMetrics: [...],
//   messageBusMetrics: {...}
// }
```

## Cost Optimization

The swarm includes several cost optimization features:

1. **LLM Caching**: Responses cached for 1 hour (30-50% cost reduction)
2. **Parallel Execution**: Tier 1 agents run simultaneously
3. **Configurable Timeouts**: Prevent runaway tasks
4. **Metrics Tracking**: Monitor token usage and costs

Example cost metrics:

```typescript
const llmMetrics = swarmCoordinator.getMetrics().agentMetrics[0];
console.log(`Cache hit rate: ${llmMetrics.llmMetrics.cacheHitRate}`);
console.log(`Estimated cost: $${llmMetrics.llmMetrics.estimatedCostUsd}`);
```

## Testing

Run the test suite:

```bash
# From extensions/x directory
npm test

# Run specific tests
npm test -- swarm
```

## Troubleshooting

### High Latency

If responses are slow:

1. Check `enableTier1Parallel` is `true`
2. Reduce `taskTimeoutMs` to fail faster
3. Monitor individual agent metrics

### High Costs

If LLM costs are high:

1. Enable `cacheResults: true`
2. Reduce `maxTokens` in LLM config
3. Check cache hit rate in metrics

### Agent Failures

If agents are failing:

1. Check XAI_API_KEY is set correctly
2. Verify X API credentials
3. Review agent error logs

## API Reference

### SwarmCoordinator

```typescript
class SwarmCoordinator {
  constructor(config: SwarmCoordinatorConfig, deps: CoordinatorDependencies);
  
  // Process a mention through the swarm
  async processMention(
    mention: Mention,
    priority?: Priority
  ): Promise<SwarmExecutionResult>;
  
  // Get metrics
  getMetrics(): SwarmMetrics;
  
  // Reset all agents
  reset(): void;
}
```

### Creating Custom Agents

```typescript
import { BaseAgent, AgentInput, AgentOutput } from "./swarm/index.js";

class MyCustomAgent extends BaseAgent {
  protected getRequiredInputFields(): string[] {
    return ["mention", "someData"];
  }
  
  protected async process(input: AgentInput): Promise<unknown> {
    // Your processing logic
    return { result: "something" };
  }
}
```

## License

MIT - Same as OpenClaw project
