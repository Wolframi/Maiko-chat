/** Read pixel size of an image or video File (for album mosaic + persist). */

export type MediaPixelSize = {
  width: number;
  height: number;
};

function finishSize(width: number, height: number): MediaPixelSize | null {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  if (w > 16000 || h > 16000) return null;
  return { width: w, height: h };
}

function readImageSize(file: File): Promise<MediaPixelSize | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(finishSize(img.naturalWidth, img.naturalHeight));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function readVideoSize(file: File): Promise<MediaPixelSize | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const size = finishSize(video.videoWidth, video.videoHeight);
      URL.revokeObjectURL(url);
      resolve(size);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

export async function readMediaSize(file: File): Promise<MediaPixelSize | null> {
  const mime = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
    return readImageSize(file);
  }
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(name)) {
    return readVideoSize(file);
  }
  return null;
}
