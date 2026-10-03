import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("OmniMath render error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-white p-6 text-neutral-900">
          <div className="mx-auto mt-16 max-w-xl rounded-xl border border-rose-200 bg-rose-50 p-5 shadow-sm">
            <h1 className="text-lg font-semibold text-rose-900">OmniMath hit a rendering error</h1>
            <p className="mt-2 text-sm leading-6 text-neutral-700">
              The app stayed alive, but one view failed to render. Check the browser console for the full stack.
            </p>
            <pre className="mt-4 max-h-56 overflow-auto rounded-lg border border-rose-200 bg-white p-3 text-xs text-rose-800">
              {this.state.error?.message || String(this.state.error)}
            </pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
