"use client";

import { Component, type ReactNode } from "react";

type Props = {
  firstMessageKey: string;
  scrollerRef: (element: HTMLElement | null) => void;
  onScroll: () => void;
  children: ReactNode;
};
type Anchor = { row: HTMLElement; top: number } | null;

// Electron's embedded UI uses native scroll anchoring. Keep loaded history in
// the DOM so recycling and estimated row heights cannot override wheel input.
// The only manual correction is a single prepend commit at the top boundary,
// where Chromium does not apply native scroll anchoring itself.
export class DesktopMessageScroller extends Component<Props> {
  private element: HTMLDivElement | null = null;
  private bindElement = (element: HTMLDivElement | null) => {
    this.element = element;
    this.props.scrollerRef(element);
  };

  getSnapshotBeforeUpdate(previous: Props): Anchor {
    if (previous.firstMessageKey === this.props.firstMessageKey || !this.element) return null;
    const bounds = this.element.getBoundingClientRect();
    for (const row of this.element.querySelectorAll<HTMLElement>("[id^='msg-']")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) return { row, top: rect.top };
    }
    return null;
  }

  componentDidUpdate(previous: Props, _state: unknown, anchor: Anchor) {
    if (previous.scrollerRef !== this.props.scrollerRef) {
      previous.scrollerRef(null);
      this.props.scrollerRef(this.element);
    }
    if (anchor && this.element?.contains(anchor.row)) {
      this.element.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
    }
  }

  render() {
    return <div className="room__messages room__messages--native" ref={this.bindElement} onScroll={this.props.onScroll}>
      <div className="room__messages-native-content">
        <div className="room__messages-anchor" />
        {this.props.children}
      </div>
    </div>;
  }
}
