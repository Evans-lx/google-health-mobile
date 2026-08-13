import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GoogleHealthClient } from "./google-health.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dataType = z.enum(["steps", "distance", "active-energy-burned", "total-calories", "active-minutes", "heart-rate", "daily-resting-heart-rate", "daily-heart-rate-variability", "sleep", "exercise", "weight", "body-fat", "oxygen-saturation", "respiratory-rate"]);

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

export function createMcpServer(client: GoogleHealthClient): McpServer {
  const server = new McpServer({ name: "google-health-mobile", version: "0.1.0" });
  server.registerTool("google_health_status", {
    title: "Google Health connection status", description: "Check whether this personal Google Health account is connected.", inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => result(await client.status()));
  server.registerTool("google_health_summary", {
    title: "Google Health summary", description: "Read a non-medical summary for a date range up to 90 days.",
    inputSchema: { start: date, end: date }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ start, end }) => result(await client.summary(start, end)));
  server.registerTool("google_health_exercises", {
    title: "Google Health exercise sessions", description: "Read workouts recorded as exercise sessions, including available type, time, duration and summary metrics.",
    inputSchema: { start: date, end: date }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ start, end }) => result(await client.exercises(start, end)));
  server.registerTool("google_health_data", {
    title: "Google Health data", description: "Read one supported health data type for a date range up to 90 days.",
    inputSchema: { data_type: dataType, start: date, end: date, aggregate: z.boolean().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ data_type, start, end, aggregate }) => result({ data_type, start, end, data: await client.query(data_type, start, end, aggregate) }));
  return server;
}
