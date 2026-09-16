exports.handler = async () => {
  const environment =
    process.env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({
      environment,
      applicationId: process.env.SQUARE_APPLICATION_ID || "",
      locationId: process.env.SQUARE_LOCATION_ID || "",
      jsSrc:
        environment === "production"
          ? "https://web.squarecdn.com/v1/square.js"
          : "https://sandbox.web.squarecdn.com/v1/square.js",
    }),
  };
};
