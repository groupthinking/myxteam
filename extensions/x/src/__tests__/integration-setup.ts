/**
 * Integration Test Setup for the X Channel Plugin
 *
 * Provides a mock X API server and helper utilities for end-to-end
 * testing of the plugin without hitting the real X API.
 *
 * Usage:
 *   1. Start the mock server: `const server = await startMockXApi()`
 *   2. Configure the plugin with `server.baseUrl` as the API base
 *   3. Run your integration tests
 *   4. Stop the server: `await server.stop()`
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MockXApiServer {
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
  /** Get all requests received by the mock server. */
  getRequests: () => RecordedRequest[];
  /** Clear recorded requests. */
  clearRequests: () => void;
  /** Set a custom response for a specific endpoint. */
  setResponse: (method: string, path: string, response: MockResponse) => void;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  timestamp: number;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

// ─── Default Responses ───────────────────────────────────────────────────────

const DEFAULT_RESPONSES: Record<string, MockResponse> = {
  "GET /2/tweets/search/stream/rules": {
    status: 200,
    body: { data: [] },
  },
  "POST /2/tweets/search/stream/rules": {
    status: 200,
    body: { data: [], meta: { sent: new Date().toISOString(), summary: { created: 0, not_created: 0 } } },
  },
  "POST /2/tweets": {
    status: 201,
    body: { data: { id: "mock-post-id-" + Date.now(), text: "" } },
  },
  "GET /2/users/by/username/": {
    status: 200,
    body: { data: { id: "mock-user-id", name: "Mock User", username: "mockuser" } },
  },
  "GET /2/usage/tweets": {
    status: 200,
    body: { data: [{ date: "2026-03-01", usage: [{ bucket: "tweets", value: 0 }] }] },
  },
};

// ─── Mock Server ─────────────────────────────────────────────────────────────

/**
 * Start a mock X API server on a random available port.
 * Returns a handle with the base URL and control methods.
 */
export async function startMockXApi(): Promise<MockXApiServer> {
  const requests: RecordedRequest[] = [];
  const customResponses = new Map<string, MockResponse>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";

    // Read body
    let body: unknown;
    if (method === "POST" || method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        body = Buffer.concat(chunks).toString();
      }
    }

    // Record the request
    requests.push({
      method,
      path,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
      timestamp: Date.now(),
    });

    // Check for custom response
    const key = `${method} ${path}`;
    const customResponse = customResponses.get(key);
    if (customResponse) {
      res.writeHead(customResponse.status ?? 200, {
        "Content-Type": "application/json",
        ...customResponse.headers,
      });
      res.end(JSON.stringify(customResponse.body ?? {}));
      return;
    }

    // Check default responses (prefix match)
    for (const [pattern, defaultResponse] of Object.entries(DEFAULT_RESPONSES)) {
      const [patternMethod, patternPath] = pattern.split(" ");
      if (method === patternMethod && path.startsWith(patternPath!)) {
        res.writeHead(defaultResponse.status ?? 200, {
          "Content-Type": "application/json",
        });

        // For POST /2/tweets, echo the text back
        if (pattern === "POST /2/tweets" && body && typeof body === "object") {
          const postBody = body as Record<string, unknown>;
          res.end(JSON.stringify({
            data: {
              id: "mock-post-" + Date.now(),
              text: postBody.text ?? "",
            },
          }));
          return;
        }

        res.end(JSON.stringify(defaultResponse.body ?? {}));
        return;
      }
    }

    // Default 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No mock handler for ${method} ${path}` }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      resolve({
        baseUrl,
        port,
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
        getRequests: () => [...requests],
        clearRequests: () => {
          requests.length = 0;
        },
        setResponse: (method: string, path: string, response: MockResponse) => {
          customResponses.set(`${method} ${path}`, response);
        },
      });
    });
  });
}

/**
 * Build a minimal OpenClaw config for testing.
 */
export function buildTestConfig(overrides?: {
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  accounts?: Record<string, {
    agentUsername: string;
    accessToken: string;
    refreshToken?: string;
    name?: string;
    enabled?: boolean;
  }>;
}) {
  return {
    channels: {
      x: {
        bearerToken: overrides?.bearerToken ?? "test-bearer-token",
        clientId: overrides?.clientId ?? "test-client-id",
        clientSecret: overrides?.clientSecret ?? "test-client-secret",
        accounts: overrides?.accounts ?? {
          default: {
            agentUsername: "TestAgent",
            accessToken: "test-access-token",
            refreshToken: "test-refresh-token",
            name: "Test Agent",
            enabled: true,
          },
        },
      },
    },
  };
}
