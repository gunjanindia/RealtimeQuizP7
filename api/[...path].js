let handleApi;
let loadError = null;

try {
  const server = require("../server");
  handleApi = server.handleApi;
} catch (err) {
  loadError = err;
  console.error("Critical: Failed to load server module:", err);
}

module.exports = async function api(request, response) {
  if (loadError || !handleApi) {
    if (!response.headersSent) {
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          error: "Server module initialization failed: " + (loadError ? loadError.message : "Unknown error"),
          stack: process.env.NODE_ENV !== "production" && loadError ? loadError.stack : undefined,
        })
      );
    }
    return;
  }

  try {
    const protocol = request.headers["x-forwarded-proto"] || "https";
    const host = request.headers.host || process.env.VERCEL_URL || "localhost";
    const url = new URL(request.url, `${protocol.split(",")[0]}://${host}`);
    await handleApi(request, response, url);
  } catch (error) {
    console.error("API request failed:", error);
    if (!response.headersSent) {
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          error: error.message || "An unexpected server error occurred.",
        })
      );
    }
  }
};
