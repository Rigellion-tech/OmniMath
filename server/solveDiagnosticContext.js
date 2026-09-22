import { AsyncLocalStorage } from "node:async_hooks";

// Correlation only: concurrent requests must not borrow one another's IDs.
const solveDiagnostics = new AsyncLocalStorage();

export function withSolveDiagnosticContext(details, callback) {
  return solveDiagnostics.run(details, callback);
}

export function getSolveDiagnosticContext() {
  return solveDiagnostics.getStore() || {};
}
