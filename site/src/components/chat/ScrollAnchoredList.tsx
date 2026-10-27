"use client";

import { Component, forwardRef, type Ref } from "react";
import type { ListProps } from "react-virtuoso";

type Props = ListProps & { context?: { preserveScroll: boolean; anchorKey: string; scrollRevision: { current: number } }; listRef: Ref<HTMLDivElement> };
type Anchor = { id: string; top: number; contentTop: number; scrollTop: number; scroller: HTMLElement; revision: number } | null;

// A prepend can also change the day separator and measurements of nearby rows.
// Take the anchor immediately before each DOM commit, including any user input
// during the request, and compensate before the browser paints that commit.
class AnchoredList extends Component<Props> {
  private element: HTMLDivElement | null = null;
  private pendingAnchor: Anchor = null;
  private heldAnchor: Anchor = null;
  private bindElement = (element: HTMLDivElement | null) => {
    this.element = element;
    const { listRef } = this.props;
    if (typeof listRef === "function") listRef(element);
    else if (listRef) listRef.current = element;
  };

  getSnapshotBeforeUpdate(previous: Props): Anchor {
    const context = this.props.context;
    if (!context?.preserveScroll) { this.heldAnchor = null; return null; }
    if (previous.context?.anchorKey !== context.anchorKey || this.heldAnchor?.revision !== context.scrollRevision.current) this.heldAnchor = null;
    if (this.heldAnchor) return this.heldAnchor;
    const scroller = this.element?.closest<HTMLElement>(".room__messages");
    if (!scroller) return null;
    const bounds = scroller.getBoundingClientRect();
    for (const row of this.element!.querySelectorAll<HTMLElement>("[id^='msg-']")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
        return this.heldAnchor = { id: row.id, top: rect.top, contentTop: rect.top - bounds.top + scroller.scrollTop, scrollTop: scroller.scrollTop, scroller, revision: context.scrollRevision.current };
      }
    }
    return null;
  }

  componentDidUpdate(previous: Props, _state: unknown, anchor: Anchor) {
    if (previous.listRef !== this.props.listRef) {
      if (typeof previous.listRef === "function") previous.listRef(null);
      else if (previous.listRef) previous.listRef.current = null;
      if (typeof this.props.listRef === "function") this.props.listRef(this.element);
      else if (this.props.listRef) this.props.listRef.current = this.element;
    }
    if (!anchor || this.pendingAnchor) return;
    this.pendingAnchor = anchor;
    // Let Virtuoso finish its layout effects (including prepend compensation)
    // before correcting variable row heights, still before the next paint.
    queueMicrotask(() => {
      this.pendingAnchor = null;
      if (this.props.context?.scrollRevision.current !== anchor.revision) return;
      const row = document.getElementById(anchor.id);
      if (!row || !this.element?.contains(row)) return;
      const top = row.getBoundingClientRect().top;
      const contentTop = top - anchor.scroller.getBoundingClientRect().top + anchor.scroller.scrollTop;
      // Distinguish native scroll momentum from a layout correction only after
      // the new rows and their offsets have committed.
      if (Math.abs(contentTop - anchor.contentTop) < 0.5 && Math.abs(anchor.scroller.scrollTop - anchor.scrollTop) > 0.5) anchor.top = top;
      const delta = top - anchor.top;
      if (Math.abs(delta) > 0.5) anchor.scroller.scrollTop += delta;
      anchor.scrollTop = anchor.scroller.scrollTop;
      anchor.contentTop = contentTop;
    });
  }

  render() {
    return <div data-testid={this.props["data-testid"]} style={this.props.style} ref={this.bindElement}>{this.props.children}</div>;
  }
}

export const ScrollAnchoredList = forwardRef<HTMLDivElement, Omit<Props, "listRef" | "ref">>(function ScrollAnchoredList(props, ref) {
  return <AnchoredList {...props} listRef={ref} />;
});
