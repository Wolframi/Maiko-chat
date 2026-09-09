/** Shared motion language — soft, calm (Motion.dev defaults tuned down). */

export const easeOut = [0.22, 1, 0.36, 1] as const;
/** Slightly longer settle — good for large scene changes. */
export const easeOutSoft = [0.16, 1, 0.3, 1] as const;
/** Crisp micro-interactions (hover follow-through). */
export const easeSnap = [0.2, 0.8, 0.2, 1] as const;

/**
 * Soft panel / toast enter — physical spring (Discord-smooth).
 */
export const softSpring = {
  type: "spring" as const,
  stiffness: 300,
  damping: 30,
};

/** Heavier sheets (profile, call). */
export const sheetSpring = {
  type: "spring" as const,
  stiffness: 300,
  damping: 32,
};

/** Tiny UI pops (reaction, badge). */
export const popSpring = {
  type: "spring" as const,
  stiffness: 380,
  damping: 28,
};

/** Default for MotionConfig children (opacity/color tweens + soft transform). */
export const defaultTransition = {
  type: "spring" as const,
  stiffness: 300,
  damping: 30,
  opacity: { type: "tween" as const, duration: 0.2, ease: easeOutSoft },
};

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

export const riseIn = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 },
};

export const panelVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

export const listContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { when: "beforeChildren" as const, staggerChildren: 0.035 },
  },
};

export const listItem = {
  hidden: { opacity: 0, y: 6 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 300, damping: 30 },
  },
};

export function duration(ms: number, reduced?: boolean | null) {
  return reduced ? 0.01 : ms / 1000;
}
