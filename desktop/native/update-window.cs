using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A standalone native process outside the installation directory. It holds no
// Electron modules or executable open while NSIS replaces the old application.
class UpdateWindow : Form {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    readonly string directory, token;
    readonly Image shell;
    readonly MaikoAnimation animation;
    readonly double initialTime;
    readonly int bodyTop;
    readonly Dictionary<string, object> config;
    readonly Timer timer = new Timer();
    readonly Stopwatch elapsed = Stopwatch.StartNew();
    bool signalled, previewNext;
    static double Number(Dictionary<string, object> value, string key) { return Convert.ToDouble(value[key]); }

    UpdateWindow(string folder, string secret, Dictionary<string, object> data, Rectangle bounds) {
        directory = folder; token = secret; config = data;
        shell = Image.FromFile(Path.Combine(directory, "shell.png"));
        double pixelRatio = bounds.Width / Math.Max(1, Number(data, "width"));
        bodyTop = (int)Math.Round(42 * pixelRatio);
        // Render at physical window resolution. Scaling a 900px bitmap made
        // particles blurry, especially on high-DPI and maximized windows.
        animation = new MaikoAnimation(Path.Combine(directory, "model.bin"), bounds.Width,
            Math.Max(1, bounds.Height - bodyTop), Number(data, "danceStart"), pixelRatio);
        initialTime = Number(data, "animationElapsed");
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual; Bounds = bounds;
        BackColor = Color.FromArgb(12, 12, 14); Text = "Майко — обновление";
        Icon = SystemIcons.Application; DoubleBuffered = true;
        bool visible = Convert.ToBoolean(data["visible"]);
        ShowInTaskbar = visible; TopMost = visible;
        if (!visible) Opacity = 0;
        timer.Interval = 15; timer.Tick += Tick; timer.Start();
        var close = new Button { Text = "×", Width = 44, Height = 40, Top = 0,
            Left = bounds.Width - 44, Anchor = AnchorStyles.Top | AnchorStyles.Right,
            FlatStyle = FlatStyle.Flat, BackColor = BackColor, ForeColor = Color.LightGray,
            Font = new Font("Segoe UI", 16), TabStop = false };
        close.FlatAppearance.BorderSize = 0;
        close.AccessibleName = "Скрыть окно обновления";
        close.Click += (sender, args) => Close(); Controls.Add(close);
    }
    bool Signal(string name) {
        try { return File.ReadAllText(Path.Combine(directory, name)) == token; }
        catch { return false; }
    }
    void Tick(object sender, EventArgs args) {
        if (Signal("complete") || Signal("cancel")) { Close(); return; }
        animation.Render(initialTime + elapsed.Elapsed.TotalSeconds);
        Invalidate();
        if (!signalled) {
            Update();
            if (config.ContainsKey("preview") && Convert.ToBoolean(config["preview"])) {
                animation.Render(Math.Max(1.5, initialTime + elapsed.Elapsed.TotalSeconds));
                using (var image = new Bitmap(ClientSize.Width, ClientSize.Height)) {
                    DrawToBitmap(image, ClientRectangle);
                    image.Save(Path.Combine(directory, "preview.png"), System.Drawing.Imaging.ImageFormat.Png);
                }
                animation.Render(initialTime + elapsed.Elapsed.TotalSeconds);
            }
            // Acknowledge only after the replacement window has been painted.
            File.WriteAllText(Path.Combine(directory, "ready.json"), new JavaScriptSerializer().Serialize(
                new { token = token, pid = Process.GetCurrentProcess().Id }));
            signalled = true;
        }
        if (!previewNext && elapsed.Elapsed.TotalSeconds >= 3 && config.ContainsKey("preview") && Convert.ToBoolean(config["preview"])) {
            using (var image = new Bitmap(ClientSize.Width, ClientSize.Height)) {
                DrawToBitmap(image, ClientRectangle);
                image.Save(Path.Combine(directory, "preview-next.png"), System.Drawing.Imaging.ImageFormat.Png);
            }
            previewNext = true;
        }
        // Never leave an orphaned topmost window indefinitely after a failure.
        if (elapsed.Elapsed.TotalMinutes > 15) Close();
    }
    protected override void OnPaint(PaintEventArgs args) {
        base.OnPaint(args);
        var g = args.Graphics;
        g.DrawImage(shell, ClientRectangle);
        int top = bodyTop;
        var body = new Rectangle(0, top, ClientSize.Width, Math.Max(1, ClientSize.Height - top));
        using (var fill = new SolidBrush(BackColor)) g.FillRectangle(fill, body);
        g.DrawImageUnscaled(animation.Image, 0, top);
        double scale = Math.Min(Math.Min(body.Width * .44, body.Height * .31), 285 * ClientSize.Width / Math.Max(1, Number(config, "width")));
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using (var ground = new Pen(Color.FromArgb(45, 45, 51)))
            g.DrawEllipse(ground, (float)(body.Width / 2.0 - scale * 1.15), (float)(top + body.Height / 2.0 + scale * 1.08),
                (float)(scale * 2.3), (float)(scale * .24));
        using (var copy = new Font("Segoe UI", 10))
        using (var muted = new SolidBrush(Color.FromArgb(138, 138, 146)))
        using (var centered = new StringFormat { Alignment = StringAlignment.Center }) {
            g.DrawString(elapsed.Elapsed.TotalSeconds > 120 ? "Запуск занимает больше времени. Можно открыть Майко снова." : "Обновляем Майко", copy, muted,
                new RectangleF(16, ClientSize.Height - 30, ClientSize.Width - 32, 24), centered);
        }
    }
    protected override void Dispose(bool disposing) {
        if (disposing) { timer.Dispose(); shell.Dispose(); animation.Dispose(); }
        base.Dispose(disposing);
    }
    [STAThread] static int Main(string[] args) {
        string folder = null;
        try {
            if (args.Length != 2) return 1;
            folder = Path.GetFullPath(args[0]);
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder, "config.json")));
            if ((string)data["token"] != args[1]) return 1;
            uint owner;
            var window = new IntPtr(long.Parse((string)data["windowId"]));
            if (GetWindowThreadProcessId(window, out owner) == 0 || owner != Convert.ToUInt32(data["owner"])) return 1;
            SetProcessDPIAware();
            Rect rect; var origin = new Point();
            if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref origin)) return 1;
            var bounds = new Rectangle(origin.x, origin.y, Math.Max(500, rect.right), Math.Max(360, rect.bottom));
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new UpdateWindow(folder, args[1], data, bounds)) Application.Run(form);
            return 0;
        } catch { return 1; }
        finally { if (folder != null) try { File.WriteAllText(Path.Combine(folder, "closed"), "closed"); } catch { } }
    }
}
