"use client";

import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";

/** Mount on first use, then retain state and exit animations while closed. */
export class FeatureGate extends Component<{ active: boolean; children: ReactNode }, { used: boolean }> {
  state = { used: this.props.active };
  static getDerivedStateFromProps(props: { active: boolean }, state: { used: boolean }) {
    return props.active && !state.used ? { used: true } : null;
  }
  render() { return this.state.used ? this.props.children : null; }
}

/** Keep a failed optional chunk from taking down the working chat. */
export function deferredFeature<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  const loadComponent = () => load().then(component => ({ default: component }));
  return class DeferredFeature extends Component<Props, { failed: boolean }> {
    state = { failed: false };
    private Panel = lazy(loadComponent);
    static getDerivedStateFromError() { return { failed: true }; }
    private retry = () => {
      this.Panel = lazy(loadComponent);
      this.setState({ failed: false });
    };
    render() {
      if (this.state.failed) return <div className="feature-load-error" role="alert">
        Не удалось открыть панель. <button type="button" onClick={this.retry}>Повторить</button>
      </div>;
      const Panel = this.Panel;
      // Lazy descendants mount after their parent animation may have begun exiting.
      // Keep their motion registrations local so they cannot hold an outer panel open.
      return <Suspense fallback={<div className="feature-loading" role="status">Загрузка…</div>}>
        <AnimatePresence><Panel {...this.props} /></AnimatePresence>
      </Suspense>;
    }
  };
}
