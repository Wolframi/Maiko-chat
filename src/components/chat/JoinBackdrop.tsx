"use client";

/**
 * Full-bleed atmospheric backdrop for auth / boot screens.
 * Pure CSS motion — no canvas, respects prefers-reduced-motion.
 */
export function JoinBackdrop() {
  return (
    <div className="join-backdrop" aria-hidden>
      <div className="join-backdrop__base" />
      <div className="join-backdrop__glow join-backdrop__glow--teal" />
      <div className="join-backdrop__glow join-backdrop__glow--sand" />
      <div className="join-backdrop__glow join-backdrop__glow--moss" />

      <div className="join-backdrop__rings">
        <span className="join-backdrop__ring join-backdrop__ring--1" />
        <span className="join-backdrop__ring join-backdrop__ring--2" />
        <span className="join-backdrop__ring join-backdrop__ring--3" />
        <span className="join-backdrop__ring join-backdrop__ring--4" />
      </div>

      <svg
        className="join-backdrop__waves"
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
      >
        <path
          className="join-backdrop__wave join-backdrop__wave--a"
          d="M-40 420 C 160 340, 280 500, 480 430 S 820 320, 1040 410 S 1280 500, 1360 440"
          fill="none"
        />
        <path
          className="join-backdrop__wave join-backdrop__wave--b"
          d="M-60 480 C 140 560, 300 400, 520 470 S 860 560, 1080 450 S 1300 380, 1400 460"
          fill="none"
        />
        <path
          className="join-backdrop__wave join-backdrop__wave--c"
          d="M-20 360 C 200 300, 340 420, 560 350 S 900 280, 1120 360 S 1320 420, 1380 380"
          fill="none"
        />
      </svg>

      <div className="join-backdrop__orbs">
        <span className="join-backdrop__orb join-backdrop__orb--1" />
        <span className="join-backdrop__orb join-backdrop__orb--2" />
        <span className="join-backdrop__orb join-backdrop__orb--3" />
        <span className="join-backdrop__orb join-backdrop__orb--4" />
        <span className="join-backdrop__orb join-backdrop__orb--5" />
      </div>

      <div className="join-backdrop__grain" />
    </div>
  );
}
