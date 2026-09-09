/** Canvas helpers for react-easy-crop → File */

export type CropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function createImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () =>
      reject(new Error("Не удалось прочитать изображение")),
    );
    image.crossOrigin = "anonymous";
    image.src = url;
  });
}

function rad(deg: number) {
  return (deg * Math.PI) / 180;
}

function rotatedSize(width: number, height: number, rotation: number) {
  const r = rad(rotation);
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  return {
    width: Math.ceil(width * cos + height * sin),
    height: Math.ceil(width * sin + height * cos),
  };
}

/**
 * Crop + optional rotation. Outputs a square JPEG suitable for avatars.
 */
export async function getCroppedAvatarFile(
  imageSrc: string,
  pixelCrop: CropArea,
  rotation = 0,
  outputSize = 1024,
): Promise<File> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas недоступен");

  const { width: bBoxWidth, height: bBoxHeight } = rotatedSize(
    image.width,
    image.height,
    rotation,
  );
  canvas.width = bBoxWidth;
  canvas.height = bBoxHeight;

  ctx.translate(bBoxWidth / 2, bBoxHeight / 2);
  ctx.rotate(rad(rotation));
  ctx.translate(-image.width / 2, -image.height / 2);
  ctx.drawImage(image, 0, 0);

  // Always export at target size so high-DPI desktop call UI stays sharp
  // (small crop areas used to produce tiny JPEGs that looked soft when scaled).
  const size = Math.max(256, Math.round(outputSize));
  const cropped = document.createElement("canvas");
  cropped.width = size;
  cropped.height = size;
  const croppedCtx = cropped.getContext("2d");
  if (!croppedCtx) throw new Error("Canvas недоступен");

  croppedCtx.imageSmoothingEnabled = true;
  croppedCtx.imageSmoothingQuality = "high";
  croppedCtx.drawImage(
    canvas,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    size,
    size,
  );

  const blob = await new Promise<Blob | null>((resolve) => {
    cropped.toBlob((value) => resolve(value), "image/jpeg", 0.96);
  });

  canvas.width = 0;
  canvas.height = 0;
  cropped.width = 0;
  cropped.height = 0;

  if (!blob) throw new Error("Не удалось обрезать фото");
  return new File([blob], `avatar-${Date.now()}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}
