/** Client-side image compression before upload — keeps device RAM / disk lean. */

const IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|bmp|heic|heif)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|heic|heif)$/i;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.76;

let webpSupported: boolean | null = null;

function canEncodeWebp() {
  if (webpSupported != null) return webpSupported;
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    webpSupported = probe.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpSupported = false;
  }
  return webpSupported;
}

function isCompressibleImage(file: File) {
  if (/gif/i.test(file.type) || /\.gif$/i.test(file.name)) return false;
  if (IMAGE_MIME.test(file.type) || IMAGE_EXT.test(file.name)) return true;
  // Mobile cameras sometimes omit MIME / use vague types.
  if (!file.type || file.type === "application/octet-stream") {
    return IMAGE_EXT.test(file.name);
  }
  return false;
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall through to <img> */
      }
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось прочитать изображение"));
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Downscale + re-encode large images to JPEG/WebP.
 * Non-images and tiny files pass through unchanged.
 * HEIC is converted when the browser can decode it (Safari).
 */
export async function compressImageFile(file: File): Promise<File> {
  if (!isCompressibleImage(file)) return file;
  const forceConvert =
    /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);
  if (!forceConvert && file.size < 120_000) return file;

  try {
    const source = await loadBitmap(file);
    const srcW =
      "width" in source ? source.width : (source as ImageBitmap).width;
    const srcH =
      "height" in source ? source.height : (source as ImageBitmap).height;
    const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));

    if (!forceConvert && scale >= 0.98 && file.size < 420_000) {
      if ("close" in source && typeof source.close === "function") source.close();
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      if ("close" in source && typeof source.close === "function") source.close();
      return file;
    }
    ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
    if ("close" in source && typeof source.close === "function") source.close();

    const outType = canEncodeWebp() ? "image/webp" : "image/jpeg";
    const blob = await canvasToBlob(canvas, outType, JPEG_QUALITY);
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return file;
    if (!forceConvert && blob.size >= file.size * 0.92) return file;

    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    const ext = outType === "image/webp" ? "webp" : "jpg";
    return new File([blob], `${base}.${ext}`, {
      type: outType,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

export async function compressUploadBatch(files: File[]): Promise<File[]> {
  if (!files.length) return files;
  const out: File[] = new Array(files.length);
  let next = 0;
  const workers = Math.min(3, files.length);
  async function worker() {
    while (next < files.length) {
      const index = next;
      next += 1;
      out[index] = await compressImageFile(files[index]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
