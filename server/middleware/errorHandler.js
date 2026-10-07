function errorHandler(error, _request, response, _next) {
  if (response.headersSent) return;
  if (error?.type === "entity.parse.failed") {
    return response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } });
  }
  console.error("Request failed:", error?.name || "Error");
  return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
}

module.exports = errorHandler;
