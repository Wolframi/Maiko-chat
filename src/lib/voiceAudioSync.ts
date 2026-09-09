type WaveSurferLike = {
  pause: () => void;
};

let currentWave: WaveSurferLike | null = null;

export function setActiveWaveSurfer(ws: WaveSurferLike) {
  if (currentWave && currentWave !== ws) {
    try {
      currentWave.pause();
    } catch {
      /* already stopped */
    }
  }
  currentWave = ws;
}

export function clearWaveSurfer(ws: WaveSurferLike) {
  if (currentWave === ws) currentWave = null;
}
