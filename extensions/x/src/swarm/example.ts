/**
 * Swarm Usage Example
 * 
 * This example shows how to use the SwarmCoordinator directly
 * for processing X mentions.
 */

import { SwarmCoordinator } from "./coordinator.js";
import { XApiClient } from "../x-api-client.js";
import { Priority, Mention } from "./types.js";

async function main() {
  // Initialize X API client
  const xApiClient = new XApiClient({
    accessToken: process.env.X_ACCESS_TOKEN!,
    accountId: "my-agent",
  });

  // Initialize SwarmCoordinator
  const swarm = new SwarmCoordinator(
    {
      maxConcurrentTasks: 5,
      taskTimeoutMs: 30000,
      enableTier1Parallel: true,
      enableTier2Parallel: true,
      cacheResults: true,
      cacheTtlMs: 3600000,
    },
    {
      xApiClient,
      account: {
        accountId: "my-agent",
        agentUsername: "MyAgent",
        enabled: true,
        configured: true,
        accessToken: process.env.X_ACCESS_TOKEN!,
        authMode: "oauth2",
        config: { agentUsername: "MyAgent" },
      },
      llmConfig: {
        apiKey: process.env.XAI_API_KEY!,
        model: "grok-2",
        temperature: 0.7,
        maxTokens: 1000,
      },
    }
  );

  // Example mention
  const mention: Mention = {
    id: "1234567890",
    text: "@MyAgent What do you think about the latest AI developments?",
    authorId: "987654321",
    authorUsername: "curious_user",
    createdAt: new Date().toISOString(),
    conversationId: "conv_123",
  };

  console.log("Processing mention through swarm...");
  console.log(`From: @${mention.authorUsername}`);
  console.log(`Text: ${mention.text}`);
  console.log("---");

  // Process through swarm
  const result = await swarm.processMention(mention, Priority.HIGH);

  console.log("\n=== Result ===");
  console.log(`Success: ${result.success}`);
  console.log(`Action: ${result.actionTaken}`);
  console.log(`Execution time: ${result.executionTimeMs}ms`);

  if (result.content) {
    console.log(`\nGenerated content:`);
    console.log(result.content);
  }

  if (result.postId) {
    console.log(`\nPosted reply ID: ${result.postId}`);
  }

  if (result.error) {
    console.log(`\nError: ${result.error}`);
  }

  // Print metrics
  console.log("\n=== Metrics ===");
  const metrics = swarm.getMetrics();
  console.log(`Total tasks: ${metrics.totalTasks}`);
  console.log(`Successful: ${metrics.successfulTasks}`);
  console.log(`Failed: ${metrics.failedTasks}`);
  console.log(`Success rate: ${(metrics.successRate * 100).toFixed(1)}%`);
  console.log(`Avg execution time: ${metrics.averageExecutionTimeMs.toFixed(0)}ms`);

  // Print agent metrics
  console.log("\n=== Agent Metrics ===");
  for (const agent of metrics.agentMetrics) {
    console.log(`\n${agent.name}:`);
    console.log(`  Executions: ${agent.executionCount}`);
    console.log(`  Avg time: ${agent.averageExecutionTimeMs.toFixed(0)}ms`);
    if (agent.lastError) {
      console.log(`  Last error: ${agent.lastError}`);
    }
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
