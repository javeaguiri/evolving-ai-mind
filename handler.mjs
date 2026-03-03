// handler.mjs
import processRouter from "./src/api/process/index.mjs";
import slackbotRouter from "./src/api/slackbot/index.mjs";

export async function handler(event) {
  // 1. Detect SQS Trigger (ProcStepOrchestrator)
  if (event.Records && event.Records[0].eventSource === 'aws:sqs') {
    console.log("Processing SQS Message...");
    // SQS logic usually goes to your processRouter
    return await processRouter(event); 
  }

  // 2. Detect API Gateway Trigger (MyFunction)
  if (event.httpMethod || event.requestContext) {
    const path = event.path || event.requestContext.http.path;
    
    if (path.startsWith("/api/process/")) {
      return await processRouter(event);
    }

    if (path.startsWith("/api/slackbot/")) {
      return await slackbotRouter(event);
    }
  }

  return {
    statusCode: 404,
    body: JSON.stringify({ error: "Route not found", event: event })
  };
}