import sharp from "sharp";

/** Real pixels with the orientation and proportions of the displayed photo. */
export async function encodeMediaMicroPreview(source: string | Buffer): Promise<string> {
  const jpeg = await sharp(source, { pages: 1 })
    .autoOrient()
    .resize({ width: 32, height: 32, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#20242b" })
    .toColourspace("srgb")
    .jpeg({ quality: 35, chromaSubsampling: "4:2:0" })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** Stop waiting without cancelling shared work for other clients. */
export async function microPreviewWithin(job: Promise<string | undefined>, milliseconds = 1200) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job, new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
