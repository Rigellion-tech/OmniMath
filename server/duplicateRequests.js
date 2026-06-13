const inFlightRequests = new Map();

export async function runDeduplicatedRequest(key, createRequest) {
  const active = inFlightRequests.get(key);
  if (active) {
    return {
      duplicate: true,
      value: await active,
    };
  }

  const promise = Promise.resolve().then(createRequest);
  inFlightRequests.set(key, promise);

  try {
    return {
      duplicate: false,
      value: await promise,
    };
  } finally {
    inFlightRequests.delete(key);
  }
}
