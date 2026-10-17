const { handleApi } = require("../server");

module.exports = async function api(request, response) {
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
      response.end(JSON.stringify({ error: "An unexpected server error occurred." }));
    }
  }
};
