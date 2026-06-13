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
        <div className="min-h-screen bg-[#061116] p-6 text-slate-100">
          <div className="mx-auto mt-16 max-w-xl rounded-xl border border-rose-300/20 bg-rose-400/10 p-5">
            <h1 className="text-lg font-semibold text-rose-100">OmniMath hit a rendering error</h1>
            <p className="mt-2 text-sm leading-6 text-slate-200/75">
              The app stayed alive, but one view failed to render. Check the browser console for the full stack.
            </p>
            <pre className="mt-4 max-h-56 overflow-auto rounded-lg bg-black/30 p-3 text-xs text-rose-50/80">
              {this.state.error?.message || String(this.state.error)}
            </pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
