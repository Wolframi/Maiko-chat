"use client";

import { Component, forwardRef, type Ref } from "react";
import type { ListProps } from "react-virtuoso";

type Props = ListProps & { context?: { preserveScroll: boolean; anchorKey: string; scrollRevision: { current: number } }; listRef: Ref<HTMLDivElement> };
type Anchor = { id: string; top: number; scrollTop: number; scroller: HTMLElement; revision: number } | null;

// A prepend can also change the day separator and measurements of nearby rows.
// Take the anchor immediately before each DOM commit, including any user input
// during the request, and compensate before the browser paints that commit.
class AnchoredList extends Component<Props> {
  private element: HTMLDivElement | null = null;
  private pendingAnchor: Anchor = null;
  private pageAnchor: Anchor = null;
  private settleFrame = 0;
  private layoutScroll = 0;
  private restoreScrollBy: (() => void) | null = null;
  private bindElement = (element: HTMLDivElement | null) => {
    this.restoreScrollBy?.();
    this.restoreScrollBy = null;
    this.element = element;
    const scroller = element?.closest<HTMLElement>(".room__messages");
    if (scroller) {
      // Virtuoso applies its measured-height compensation through scrollBy.
      // Track those writes separately from wheel/touch momentum; both cause
      // trusted scroll events, so an onScroll handler cannot distinguish them.
      const ownScrollBy = Object.getOwnPropertyDescriptor(scroller, "scrollBy");
      const scrollBy = scroller.scrollBy;
      const trackedScrollBy = (...args: unknown[]) => {
        const before = scroller.scrollTop;
        Reflect.apply(scrollBy, scroller, args);
        this.layoutScroll += scroller.scrollTop - before;
      };
      scroller.scrollBy = trackedScrollBy;
      this.restoreScrollBy = () => {
        if (scroller.scrollBy !== trackedScrollBy) return;
        if (ownScrollBy) Object.defineProperty(scroller, "scrollBy", ownScrollBy);
        else delete (scroller as Partial<HTMLElement>).scrollBy;
      };
    }
    const { listRef } = this.props;
    if (typeof listRef === "function") listRef(element);
    else if (listRef) listRef.current = element;
  };

  componentWillUnmount() {
    cancelAnimationFrame(this.settleFrame);
    this.restoreScrollBy?.();
  }

  getSnapshotBeforeUpdate(previous: Props): Anchor {
    const context = this.props.context;
    if (!context?.preserveScroll) { this.pageAnchor = null; return null; }
    const newPage = previous.context?.anchorKey !== context.anchorKey;
    if (newPage) {
      this.pageAnchor = null;
      cancelAnimationFrame(this.settleFrame);
      // Virtuoso commits the prepend and its measurements separately. Hold
      // only this short transaction, never the subsequent reading position.
      let previousSize = "";
      let stableFrames = 0;
      let frames = 0;
      const settle = () => {
        if (!this.pageAnchor || !this.element) return;
        const size = `${this.element.offsetHeight}:${this.element.style.cssText}`;
        stableFrames = size === previousSize ? stableFrames + 1 : 0;
        previousSize = size;
        if (stableFrames >= 3 || ++frames >= 30) { this.pageAnchor = null; return; }
        this.settleFrame = requestAnimationFrame(settle);
      };
      this.settleFrame = requestAnimationFrame(settle);
    }
    if (this.pageAnchor) {
      const anchor = this.pageAnchor;
      // Momentum has no new input event. Advance the retained screen position
      // by the native movement before this commit changes the row geometry.
      anchor.top -= anchor.scroller.scrollTop - anchor.scrollTop - this.layoutScroll;
      anchor.scrollTop = anchor.scroller.scrollTop;
      anchor.revision = context.scrollRevision.current;
      this.layoutScroll = 0;
      return anchor;
    }
    const scroller = this.element?.closest<HTMLElement>(".room__messages");
    if (!scroller) return null;
    const bounds = scroller.getBoundingClientRect();
    for (const row of this.element!.querySelectorAll<HTMLElement>("[id^='msg-']")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
        // Capture the current reading position for this commit. A coordinate
        // retained from a previous commit would undo native scroll momentum.
        const anchor = { id: row.id, top: rect.top, scrollTop: scroller.scrollTop, scroller, revision: context.scrollRevision.current };
        this.layoutScroll = 0;
        if (newPage) this.pageAnchor = anchor;
        return anchor;
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
      this.restoreAnchor(anchor);
    });
  }

  private restoreAnchor(anchor: NonNullable<Anchor>) {
    if (this.props.context?.scrollRevision.current !== anchor.revision) return;
    const row = document.getElementById(anchor.id);
    if (!row || !this.element?.contains(row)) return;
    const delta = row.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) anchor.scroller.scrollTop += delta;
    anchor.scrollTop = anchor.scroller.scrollTop;
    this.layoutScroll = 0;
  }

  render() {
    return <div data-testid={this.props["data-testid"]} style={this.props.style} ref={this.bindElement}>{this.props.children}</div>;
  }
}

export const ScrollAnchoredList = forwardRef<HTMLDivElement, Omit<Props, "listRef" | "ref">>(function ScrollAnchoredList(props, ref) {
  return <AnchoredList {...props} listRef={ref} />;
});
