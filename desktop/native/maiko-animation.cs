using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

// Reads the same local skinned particle model as site/src/lib/maikoDance.ts.
// Rendering in this independent process keeps the dance alive while Electron's
// installed files are replaced, without a second Electron runtime or a video.
sealed class MaikoAnimation : IDisposable {
    readonly int count, bones, frames, fps, width, height;
    readonly float[] data, palette, pose;
    readonly byte[] pixels;
    readonly double start, pixelRatio;
    public readonly Bitmap Image;
    double previous = -1;
    static double Clamp(double x) { return Math.Max(0, Math.Min(1, x)); }
    static double Smooth(double a, double b, double t) { double x = Clamp((t - a) / (b - a)); return x * x * (3 - 2 * x); }
    static double Fract(double x) { return x - Math.Floor(x); }

    public MaikoAnimation(string file, int w, int h, double danceStart, double dpr = 1) {
        width = Math.Max(1, w); height = Math.Max(1, h);
        pixelRatio = Math.Max(1, dpr);
        Image = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
        pixels = new byte[width * height * 4];
        using (var reader = new BinaryReader(File.OpenRead(file))) {
            if (reader.ReadUInt32() != 0x4e414b4d || reader.ReadUInt32() != 1) throw new InvalidDataException("Invalid Maiko model");
            int total = reader.ReadInt32(); bones = reader.ReadInt32(); frames = reader.ReadInt32(); fps = reader.ReadInt32();
            double duration = reader.ReadSingle(); reader.ReadInt32();
            if (total < 1 || total > 100000 || bones < 1 || bones > 255 || frames < 2 || frames > 1024 || fps < 1 || fps > 120
                || Double.IsNaN(duration) || Double.IsInfinity(duration) || Math.Abs(duration - (frames - 1.0) / fps) > .001
                || reader.BaseStream.Length != 32L + total * 21L + bones * frames * 24L) throw new InvalidDataException("Incomplete Maiko model");
            start = Math.Max(0, Math.Min(danceStart, Math.Max(0, duration - 6)));
            count = Math.Min(total, 84000); data = new float[count * 16];
            for (int i = 0; i < count; i++) {
                int source = (int)((long)i * total / count), k = i * 16;
                reader.BaseStream.Position = 32 + source * 21L;
                for (int j = 0; j < 3; j++) data[k + j] = reader.ReadInt16() / 8192f;
                for (int j = 0; j < 3; j++) data[k + 3 + j] = reader.ReadInt16() / 32767f;
                for (int j = 0; j < 4; j++) { data[k + 6 + j] = reader.ReadByte(); if (data[k + 6 + j] >= bones) throw new InvalidDataException("Invalid Maiko joint"); }
                for (int j = 0; j < 4; j++) data[k + 10 + j] = reader.ReadByte() / 255f;
                data[k + 14] = (float)(.045 + .955 * Math.Pow(reader.ReadByte() / 255.0, .65));
                data[k + 15] = (float)Fract(source * .61803398875);
            }
            reader.BaseStream.Position = 32 + total * 21L;
            palette = new float[bones * frames * 12];
            pose = new float[bones * 12];
            for (int i = 0; i < palette.Length; i++) palette[i] = reader.ReadInt16() / 4096f;
        }
    }
    public void Render(double elapsed) {
        // Reverse the same clip continuously, without replaying the entrance or
        // jumping between unrelated first/last poses during a long install.
        double time = Math.Max(0, elapsed);
        if (time == previous) return;
        previous = time; Array.Clear(pixels, 0, pixels.Length);
        double cycle = Math.Max(0, time - 1.1) % 12;
        double frame = Math.Min(frames - 1, (start + (cycle <= 6 ? cycle : 12 - cycle)) * fps);
        int first = (int)frame, second = Math.Min(frames - 1, first + 1);
        double blend = frame - first, scale = Math.Min(Math.Min(width * .44, height * .31), 285 * pixelRatio), angle = -.06;
        double cos = Math.Cos(angle), sin = Math.Sin(angle), radius = Math.Min(1.32, Math.Min(width, height) / scale * .4);
        // Interpolate each bone once per frame, rather than for every particle
        // and influence. The hot loop only transforms positions and normals.
        for (int i = 0; i < pose.Length; i++) pose[i] = (float)(palette[first * pose.Length + i] * (1 - blend) + palette[second * pose.Length + i] * blend);
        double fade = Smooth(0, .15, time);
        for (int i = 0; i < count; i++) {
            int k = i * 16; double x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0;
            for (int j = 0; j < 4; j++) {
                double weight = data[k + 10 + j]; if (weight == 0) continue;
                int a = (int)data[k + 6 + j] * 12;
                double restX = data[k], restY = data[k + 1], restZ = data[k + 2];
                double dx = data[k + 3], dy = data[k + 4], dz = data[k + 5];
                x += (pose[a] * restX + pose[a + 3] * restY + pose[a + 6] * restZ + pose[a + 9]) * weight;
                y += (pose[a + 1] * restX + pose[a + 4] * restY + pose[a + 7] * restZ + pose[a + 10]) * weight;
                z += (pose[a + 2] * restX + pose[a + 5] * restY + pose[a + 8] * restZ + pose[a + 11]) * weight;
                nx += (pose[a] * dx + pose[a + 3] * dy + pose[a + 6] * dz) * weight;
                ny += (pose[a + 1] * dx + pose[a + 4] * dy + pose[a + 7] * dz) * weight;
                nz += (pose[a + 2] * dx + pose[a + 5] * dy + pose[a + 8] * dz) * weight;
            }
            double rx = x * cos - z * sin; z = x * sin + z * cos; x = rx;
            double front = Math.Max(0, (nx * sin + nz * cos) / Math.Max(.0001, Math.Sqrt(nx * nx + ny * ny + nz * nz)));
            double seed = data[k + 15], entry = Smooth(.14 + seed * .18, .95 + seed * .18, time), scatter = (1 - entry) * (1 - entry);
            if (scatter > 0) {
                double latitude = 1 - 2 * Fract(Math.Sin(seed * 127.1 + .731) * 4375.85453), ring = Math.Sqrt(Math.Max(0, 1 - latitude * latitude));
                double spiral = seed * Math.PI * 2 + scatter * 5.5 + time * .5, r = radius * (.88 + .12 * Fract(seed * 59.7));
                x = x * (1 - scatter) + Math.Cos(spiral) * ring * r * scatter;
                y = y * (1 - scatter) + latitude * r * scatter;
                z = z * (1 - scatter) + Math.Sin(spiral) * ring * r * scatter;
            }
            double perspective = 4.8 / Math.Max(.1, 4.8 - z);
            double px = width / 2.0 + x * perspective * scale, py = height / 2.0 - y * perspective * scale;
            double alpha = Math.Min(1, ((.05 + Math.Sqrt(front) * 1.28) * data[k + 14] * entry + .18 * (1 - entry)) * fade);
            if (pixelRatio > 1.1) {
                // Preserve the particle's CSS size on scaled displays while
                // rasterizing coverage directly into physical pixels.
                double half = pixelRatio * .5;
                double left = px - half, right = px + half, top = py - half, bottom = py + half;
                for (int sampleY = (int)Math.Floor(top); sampleY < bottom; sampleY++) {
                    double coverageY = Math.Max(0, Math.Min(sampleY + 1, bottom) - Math.Max(sampleY, top));
                    for (int sampleX = (int)Math.Floor(left); sampleX < right; sampleX++) {
                        double coverageX = Math.Max(0, Math.Min(sampleX + 1, right) - Math.Max(sampleX, left));
                        Put(sampleX, sampleY, (int)(255 * alpha * coverageX * coverageY));
                    }
                }
                continue;
            }
            // Subpixel coverage avoids jitter when a particle crosses a pixel.
            int ix = (int)Math.Floor(px), iy = (int)Math.Floor(py);
            double fx = px - ix, fy = py - iy, level = 255 * alpha;
            Put(ix, iy, (int)(level * (1 - fx) * (1 - fy)));
            Put(ix + 1, iy, (int)(level * fx * (1 - fy)));
            Put(ix, iy + 1, (int)(level * (1 - fx) * fy));
            Put(ix + 1, iy + 1, (int)(level * fx * fy));
        }
        var bits = Image.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        try { Marshal.Copy(pixels, 0, bits.Scan0, pixels.Length); } finally { Image.UnlockBits(bits); }
    }
    void Put(int x, int y, int level) {
        if (x < 0 || y < 0 || x >= width || y >= height || level < 1) return;
        int offset = (y * width + x) * 4;
        // White source-over, matching the WebGL blend instead of burning out
        // facial detail when several particles cover the same pixel.
        byte value = (byte)(pixels[offset] + Math.Min(255, level) * (255 - pixels[offset]) / 255);
        pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value; pixels[offset + 3] = value;
    }
    public void Dispose() { Image.Dispose(); }
}
