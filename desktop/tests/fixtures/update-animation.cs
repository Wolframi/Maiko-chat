using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

class UpdateAnimationTest {
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
