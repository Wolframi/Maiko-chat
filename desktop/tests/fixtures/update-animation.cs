using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

class UpdateAnimationTest {
    static void OcclusionModel(string file, bool front, bool back) {
        using (var w = new BinaryWriter(File.Create(file))) {
            w.Write(0x4e414b4d); w.Write(1); w.Write((front ? 1 : 0) + (back ? 1 : 0));
            w.Write(1); w.Write(2); w.Write(1); w.Write(1f); w.Write(0);
            foreach (double z in front && back ? new [] { .5, -.5 } : new [] { front ? .5 : -.5 }) {
                double p = 4.8 / (4.8 - z), x = .5 / (31 * p), y = -x;
                // Put both particles at the same pixel center after projection.
                w.Write((short)Math.Round((x * Math.Cos(-.06) + z * Math.Sin(-.06)) * 8192));
                w.Write((short)Math.Round(y * 8192));
                w.Write((short)Math.Round((-x * Math.Sin(-.06) + z * Math.Cos(-.06)) * 8192));
                w.Write((short)0); w.Write((short)0); w.Write((short)32767);
                w.Write(new byte[] { 0, 0, 0, 0, 255, 0, 0, 0, 90 });
            }
            for (int frame = 0; frame < 2; frame++)
                foreach (short value in new short[] { 4096, 0, 0, 0, 4096, 0, 0, 0, 4096, 0, 0, 0 }) w.Write(value);
        }
    }
    static void CheckOcclusion(string directory) {
        int[] levels = new int[3];
        for (int variant = 0; variant < 3; variant++) {
            string file = Path.Combine(directory, "occlusion-" + variant + ".bin");
            OcclusionModel(file, variant != 2, variant != 0);
            using (var animation = new MaikoAnimation(file, 100, 100, 0)) {
                animation.Render(1.5);
                levels[variant] = animation.Image.GetPixel(50, 50).A;
            }
        }
        if (levels[0] < 40 || levels[2] < 40) throw new Exception("Occlusion fixture must paint both surfaces");
        if (levels[0] != levels[1]) throw new Exception("Back particles washed out the foreground detail");
    }
    static string Fingerprint(Bitmap image) {
        var bits = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
        var pixels = new byte[image.Width * image.Height * 4];
        try { Marshal.Copy(bits.Scan0, pixels, 0, pixels.Length); }
        finally { image.UnlockBits(bits); }
        int visible = 0;
        for (int i = 3; i < pixels.Length; i += 4) if (pixels[i] > 40) visible++;
        if (visible < 1000) throw new Exception("Model vanished during the update");
        using (var hash = SHA256.Create()) return Convert.ToBase64String(hash.ComputeHash(pixels));
    }
    static int Main(string[] args) {
        try {
            CheckOcclusion(args[2]);
            foreach (string intro in new [] { "hiphop", "samba" }) {
                foreach (int dpr in new [] { 1, 2 }) {
                    using (var animation = new MaikoAnimation(Path.Combine(args[0], "maiko-" + intro + ".bin"), 1000 * dpr, 658 * dpr, 0, dpr)) {
                        animation.Render(8);
                        string first = Fingerprint(animation.Image);
                        animation.Render(9);
                        if (first == Fingerprint(animation.Image)) throw new Exception("Animation froze after seven seconds");
                        animation.Render(20);
                        if (first != Fingerprint(animation.Image)) throw new Exception("Loop changed the clip or replayed its entrance");
                        animation.Render(13.1);
                        Fingerprint(animation.Image);
                        animation.Image.Save(Path.Combine(args[1], "update-" + intro + "-" + dpr + "x.png"), ImageFormat.Png);
                        animation.Render(1.5);
                        animation.Image.Save(Path.Combine(args[1], "update-quality-" + intro + "-" + dpr + "x.png"), ImageFormat.Png);
                        var watch = Stopwatch.StartNew();
                        for (int i = 0; i < 60; i++) animation.Render(20 + i / 60.0);
                        Console.WriteLine(intro + " " + dpr + "x: " + (watch.Elapsed.TotalMilliseconds / 60).ToString("F1", System.Globalization.CultureInfo.InvariantCulture) + " ms/frame");
                    }
                }
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
