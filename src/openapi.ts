export function openApi(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: { title: "Google Health Mobile", version: "0.2.0", description: "Read-only personal Google Health data for a Custom GPT." },
    servers: [{ url: baseUrl }],
    components: { schemas: {}, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/status": { get: { operationId: "googleHealthStatus", summary: "Check whether Google Health is connected", responses: { "200": { description: "Connection status" } } } },
      "/api/summary": { get: {
        operationId: "getGoogleHealthSummary", summary: "Get steps, activity, sleep, heart, weight and body-fat summary", parameters: dateParameters(),
        responses: { "200": { description: "Health summary" } }
      } },
      "/api/exercises": { get: {
        operationId: "getGoogleHealthExercises", summary: "Get recorded workout sessions such as runs, walks and bike rides", parameters: dateParameters(),
        responses: { "200": { description: "Recorded exercise sessions, including available type, time, duration and summary metrics" } }
      } },
      "/api/data/{dataType}": { get: {
        operationId: "getGoogleHealthData", summary: "Get one supported Google Health data type",
        parameters: [
          { name: "dataType", in: "path", required: true, schema: { type: "string", enum: ["steps", "distance", "active-energy-burned", "total-calories", "active-minutes", "heart-rate", "daily-resting-heart-rate", "daily-heart-rate-variability", "sleep", "exercise", "weight", "body-fat", "oxygen-saturation", "respiratory-rate"] } },
          ...dateParameters(),
          { name: "aggregate", in: "query", schema: { type: "boolean", default: true }, description: "Use daily rollups. Session types exercise and sleep always return detailed reconciled records." }
        ],
        responses: { "200": { description: "Google Health data" } }
      } }
    }
  };
}

function dateParameters() {
  return [
    { name: "start", in: "query", required: true, schema: { type: "string", format: "date" }, description: "Start date, YYYY-MM-DD." },
    { name: "end", in: "query", required: true, schema: { type: "string", format: "date" }, description: "End date, YYYY-MM-DD. Maximum 90-day range." }
  ];
}
