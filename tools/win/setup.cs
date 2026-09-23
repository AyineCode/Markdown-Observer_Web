/*
  setup.cs —— "Markdown Observer 安装程序"的界面壳（编译进安装包 exe 的前半截）。

  它自己只做三件事：
    1. 把自己尾巴上的压缩包解开，落到安装目录；
    2. 用包里自带的 node.exe 跑 tools/win/install.mjs —— 配置和注册表那套逻辑只有那一份，
       这里绝不重写一遍（不然两处迟早不一致）；
    3. 装完给一页人话说明，外加一个"设为 .md 默认打开方式"的按钮（Windows 不允许程序自己抢默认，
       只能把系统那个选择窗口打开、让用户点一下）。

  也给脚本和测试留了口子：
    "安装程序.exe" --silent [--dir <目录>] [--autostart|--no-autostart]
    "安装程序.exe" --extract-only <目录>      只解包，不装（自测用）
*/
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using System.Windows.Forms;

static class Program
{
    const string Magic = "MDOBSET1";   // 正好 8 字节，和打包脚本保持一致
    static readonly string LogPath = Path.Combine(Path.GetTempPath(), "markdown-observer-setup.log");

    /// <summary>默认装到当前用户的 AppData\Local 下（不需要管理员）。</summary>
    static string DefaultDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MarkdownObserver");
    }

    static void Log(string message)
    {
        try { File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine); }
        catch { /* 日志写不了也不该影响安装 */ }
    }

    [STAThread]
    static int Main(string[] args)
    {
        string dir = DefaultDir();
        string extractOnly = null;
        bool? autoStart = null;
        bool silent = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--silent") silent = true;
            else if (args[i] == "--dir" && i + 1 < args.Length) dir = args[++i];
            else if (args[i] == "--extract-only" && i + 1 < args.Length) extractOnly = args[++i];
            else if (args[i] == "--autostart") autoStart = true;
            else if (args[i] == "--no-autostart") autoStart = false;
        }

        if (extractOnly != null)
        {
            try { ExtractAll(extractOnly, null); Log("extracted -> " + extractOnly); return 0; }
            catch (Exception error) { Log("extract failed: " + error); return 1; }
        }
        if (silent)
        {
            try { Install(dir, autoStart, null); Log("silent install ok -> " + dir); return 0; }
            catch (Exception error) { Log("silent install failed: " + error); return 1; }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(dir, autoStart));
        return 0;
    }

    // ── 给界面线程用的入口（下面这些是私有的）────────────────────────────
    public static void InstallForUi(string dir, bool autoStart, Action<int, int> onStep) { Install(dir, autoStart, onStep); }
    public static void LogForUi(string message) { Log(message); }
    public static string LogPathForUi { get { return LogPath; } }

    /// <summary>窗口/任务栏用的图标：从 exe 自己身上取，和托盘、资源管理器里那个一致。</summary>
    public static Icon AppIcon()
    {
        // 优先用编在程序里的那份：它跟"exe 放在哪儿"无关。
        // 从 \\wsl.localhost\... 这种共享路径运行时，ExtractAssociatedIcon 会失败，
        // 窗口就只剩系统那个空白默认图标（这个坑踩过）。
        try
        {
            using (Stream stream = typeof(Program).Assembly.GetManifestResourceStream("AppIcon"))
            {
                if (stream != null) return new Icon(stream);
            }
        }
        catch { }
        try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { return SystemIcons.Application; }
    }

    static void Install(string dir, bool? autoStart, Action<int, int> onStep)
    {
        Directory.CreateDirectory(dir);
        /*
          解包**之前**先让旧的退干净。
          顺序反了会翻车：托盘和 node.exe 正在跑的时候，它们的文件是被占用的，
          File.Create 会直接抛"文件被另一个进程使用"——也就是"更新安装必然失败"。
          （以前是先解包、后由 install.mjs 去停，遇到正在跑的实例就会卡住。）
        */
        StopRunning(dir);
        ExtractAll(dir, onStep);
        RunInstallScript(dir, autoStart);
    }

    /// <summary>
    /// 请已经装好的那一份退干净（服务 + 托盘）。
    ///
    /// **这里绝对不要杀进程。** 安装包是用户刚从网上下下来的、零信誉的可执行文件，
    /// 而"枚举进程并结束它"是恶意软件最典型的动作之一 —— Defender 的行为监控会当场把它删掉。
    /// 这个坑真踩过：给安装器加上"覆盖更新前先停旧实例"（里面带了 Kill）之后，
    /// 安装包立刻开始被杀软删除；去掉 Kill 就没事了。
    ///
    /// 退不掉就把话说明白，让用户自己点托盘里的"退出"——多一步，但不会被当成木马。
    /// </summary>
    static void StopRunning(string dir)
    {
        string exe = Path.Combine(dir, "MarkdownObserver.exe");
        if (!File.Exists(exe) || !File.Exists(Path.Combine(dir, "config.txt"))) return;
        Log("先请正在跑的旧实例退出");
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(exe, "--quit");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WorkingDirectory = Path.GetTempPath();
            using (Process process = Process.Start(info)) process.WaitForExit(15000);
        }
        catch (Exception error) { Log("请旧实例退出失败（继续）：" + error.Message); }

        for (int i = 0; i < 24; i++)
        {
            if (Process.GetProcessesByName("MarkdownObserver").Length == 0) { Log("旧实例已退出"); return; }
            System.Threading.Thread.Sleep(250);
        }
        throw new InvalidOperationException(
            "已经装好的那一份还在运行，文件被占着，装不进去。\n\n"
            + "请先退出它：右键右下角托盘里的 Markdown Observer 图标 → 「退出」，然后再装一次。");
    }

    /// <summary>包里这一版的构建标记（编成了资源，读起来是瞬时的）。</summary>
    public static string PayloadStamp()
    {
        try
        {
            using (Stream stream = typeof(Program).Assembly.GetManifestResourceStream("AppStamp"))
            {
                if (stream == null) return null;
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd().Trim();
            }
        }
        catch { return null; }
    }

    /// <summary>开机自启现在开着吗（读的是托盘写的那条，装的时候好把勾选状态对上）。</summary>
    public static bool AutoStartOn()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", false))
            {
                return key != null && key.GetValue("Markdown Observer") != null;
            }
        }
        catch { return false; }
    }

    /// <summary>这个目录里装过的那一版是什么时候构建的（没有就是没装过）。</summary>
    public static string InstalledStamp(string dir)
    {
        try
        {
            string file = Path.Combine(dir, "build-stamp.txt");
            if (File.Exists(file)) return File.ReadAllText(file).Trim();
        }
        catch { }
        return null;
    }

    static void ExtractAll(string dir) { ExtractAll(dir, null); }

    /// <summary>解包。onStep(已完成, 总数) 用来喂进度条。</summary>
    static void ExtractAll(string dir, Action<int, int> onStep)
    {
        byte[] raw = Inflate(ReadPayload());
        int headerLength = BitConverter.ToInt32(raw, 0);
        string header = Encoding.UTF8.GetString(raw, 4, headerLength);
        int dataStart = 4 + headerLength;
        string[] lines = header.Split('\n');
        int done = 0;
        foreach (string line in lines)
        {
            if (line.Length == 0) continue;
            string[] parts = line.Split('\t');
            if (parts.Length != 3) continue;
            string full = Path.Combine(dir, parts[0].Replace('/', Path.DirectorySeparatorChar));
            int size = int.Parse(parts[1]);
            int offset = int.Parse(parts[2]);
            string parent = Path.GetDirectoryName(full);
            if (parent != null && parent.Length > 0) Directory.CreateDirectory(parent);
            using (FileStream file = File.Create(full)) file.Write(raw, dataStart + offset, size);
            done += 1;
            if (onStep != null) onStep(done, lines.Length - 1);
        }
    }

    /// <summary>
    /// 取出编在里面的文件包。
    /// 它是**正规的 PE 资源**（csc /resource:），不是贴在 exe 尾巴上的数据——
    /// 后者是 dropper 的典型形状，杀软一眼就盯上。
    /// </summary>
    static byte[] ReadPayload()
    {
        byte[] all = File.ReadAllBytes(Application.ExecutablePath);
        if (all.Length < 32) throw new InvalidOperationException("这个 exe 不完整。");
        string magic = Encoding.ASCII.GetString(all, all.Length - 8, 8);
        if (magic != Magic) throw new InvalidOperationException("这个 exe 里没有安装包（是不是被别的东西改过？）");
        int length = BitConverter.ToInt32(all, all.Length - 16);
        byte[] packed = new byte[length];
        Buffer.BlockCopy(all, all.Length - 16 - length, packed, 0, length);
        return packed;
    }

    static byte[] Inflate(byte[] packed)
    {
        using (MemoryStream input = new MemoryStream(packed))
        using (DeflateStream inflate = new DeflateStream(input, CompressionMode.Decompress))
        using (MemoryStream output = new MemoryStream())
        {
            byte[] buffer = new byte[81920];
            int read;
            while ((read = inflate.Read(buffer, 0, buffer.Length)) > 0) output.Write(buffer, 0, read);
            return output.ToArray();
        }
    }

    /// <summary>用自带的 node.exe 跑 install.mjs（安装逻辑只有那一份）。</summary>
    static void RunInstallScript(string dir, bool? autoStart)
    {
        string node = Path.Combine(dir, "node.exe");
        string script = Path.Combine(dir, "tools", "win", "install.mjs");
        if (!File.Exists(node)) throw new InvalidOperationException("包里没有 node.exe。");
        if (!File.Exists(script)) throw new InvalidOperationException("包里没有 tools\\win\\install.mjs。");

        List<string> parts = new List<string>();
        parts.Add(Quote(script));
        parts.Add("--dir"); parts.Add(Quote(dir));
        parts.Add("--node"); parts.Add(Quote(node));
        if (autoStart == true) parts.Add("--autostart");
        if (autoStart == false) parts.Add("--no-autostart");

        ProcessStartInfo info = new ProcessStartInfo(node, string.Join(" ", parts.ToArray()));
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.WorkingDirectory = Path.GetTempPath();   // 别占着安装目录（卸载时要删它）
        using (Process process = Process.Start(info))
        {
            string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
            process.WaitForExit();
            Log("install.mjs 输出：" + Environment.NewLine + output);
            if (process.ExitCode != 0) throw new InvalidOperationException("安装脚本退出码 " + process.ExitCode + "，详情见 " + LogPath);
        }
    }

    static string Quote(string value) { return value.IndexOf(' ') >= 0 ? "\"" + value + "\"" : value; }

}

/// <summary>界面配色：和图标的蓝一致，别用 WinForms 那种灰扑扑的默认样。</summary>
static class Look
{
    public static readonly Color Top = Color.FromArgb(136, 198, 230);
    public static readonly Color Bottom = Color.FromArgb(32, 107, 163);
    public static readonly Color Ink = Color.FromArgb(28, 32, 40);
    public static readonly Color Muted = Color.FromArgb(122, 130, 142);
    public static readonly Color Line = Color.FromArgb(228, 232, 238);
    public static readonly Color Track = Color.FromArgb(232, 236, 242);

    /// <summary>扁平按钮：主按钮填蓝底白字，次按钮白底描边。</summary>
    public static Button MakeButton(string text, bool primary)
    {
        Button button = new Button();
        button.Text = text;
        button.Height = 36;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = primary ? 0 : 1;
        button.FlatAppearance.BorderColor = Line;
        button.BackColor = primary ? Bottom : Color.White;
        button.ForeColor = primary ? Color.White : Ink;
        button.Font = new Font("Microsoft YaHei UI", 9.5f, primary ? FontStyle.Bold : FontStyle.Regular);
        button.Cursor = Cursors.Hand;
        return button;
    }

    /// <summary>顶上那条渐变色带（浅蓝 → 深蓝，和图标一样）。</summary>
    public static Panel Header(string title, string subtitle, Icon icon)
    {
        Panel panel = new Panel();
        panel.Dock = DockStyle.Top;
        panel.Height = 86;
        panel.Paint += delegate(object sender, PaintEventArgs e)
        {
            using (LinearGradientBrush brush = new LinearGradientBrush(panel.ClientRectangle, Top, Bottom, 0f))
            {
                e.Graphics.FillRectangle(brush, panel.ClientRectangle);
            }
            if (icon != null)
            {
                e.Graphics.DrawIcon(icon, new Rectangle(20, 22, 42, 42));
            }
            using (Font big = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold))
            using (Font small = new Font("Microsoft YaHei UI", 9f))
            using (SolidBrush white = new SolidBrush(Color.White))
            using (SolidBrush soft = new SolidBrush(Color.FromArgb(226, 240, 250)))
            {
                e.Graphics.DrawString(title, big, white, 78, 20);
                e.Graphics.DrawString(subtitle, small, soft, 80, 52);
            }
        };
        return panel;
    }
}

/// <summary>一条自己画的细进度条（原生 ProgressBar 染不上色，绿条配蓝界面太跳）。</summary>
class SlimBar : Panel
{
    int value;
    int max = 1;

    public SlimBar()
    {
        Height = 6;
        DoubleBuffered = true;
    }

    public void Set(int done, int total)
    {
        value = done;
        max = Math.Max(1, total);
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(Look.Track);
        int width = (int)(Width * Math.Min(1.0, (double)value / max));
        if (width <= 0) return;
        using (SolidBrush brush = new SolidBrush(Look.Bottom)) e.Graphics.FillRectangle(brush, 0, 0, width, Height);
    }
}

/// <summary>一页到底的安装向导：装之前一页，装完一页。</summary>
class SetupForm : Form
{
    readonly string installDir;
    readonly bool? autoStart;
    readonly Panel before = new Panel();
    readonly Panel after = new Panel();
    readonly TextBox dirBox = new TextBox();
    readonly CheckBox autoBox = new CheckBox();
    readonly Button installButton;
    readonly string previousStamp;
    readonly string payloadStamp;
    readonly string action;
    bool installed;
    readonly Label status = new Label();
    readonly SlimBar bar = new SlimBar();

    public SetupForm(string dir, bool? autoStart)
    {
        this.installDir = dir;
        this.autoStart = autoStart;
        /*
          三个词要分清：
            · 没装过            → 安装
            · 装过、包里是新版   → 更新
            · 装过、版本一样     → 修复（用户就是想"再来一遍"，说"更新"会让人以为有新东西）
        */
        this.previousStamp = Program.InstalledStamp(dir);
        this.payloadStamp = Program.PayloadStamp();
        this.installed = previousStamp != null;
        this.action = previousStamp == null
            ? "安装"
            : (payloadStamp != null && payloadStamp != previousStamp ? "更新" : "修复");
        installButton = Look.MakeButton(action, true);

        Text = "Markdown Observer";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 372);
        BackColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 9f);
        try { Icon = Program.AppIcon(); } catch { }

        BuildBefore();
        BuildAfter();
        Controls.Add(before);
        Controls.Add(after);
        after.Visible = false;
    }

    /// <summary>造一个标签（别叫 Text：会和 Form.Text 撞名）。</summary>
    Label Caption(string text, int x, int y, float size, Color color, bool bold)
    {
        Label label = new Label();
        label.Text = text;
        label.AutoSize = true;
        label.Location = new Point(x, y);
        label.Font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular);
        label.ForeColor = color;
        return label;
    }

    void BuildBefore()
    {
        before.Dock = DockStyle.Fill;
        before.BackColor = Color.White;
        before.Controls.Add(Look.Header("Markdown Observer",
            installed
                ? "这台机器上已经装过（" + previousStamp + "），这次是" + action
                : "安安静静读 markdown 的小工具",
            Program.AppIcon()));

        before.Controls.Add(Caption("安装完成后，双击 .md 即可使用；右键菜单里有「用 Markdown Observer 阅读」；", 24, 108, 9.5f, Look.Ink, false));
        before.Controls.Add(Caption("「打开方式」列表里也会出现它。", 24, 130, 9.5f, Look.Ink, false));

        before.Controls.Add(Caption(installed ? "安装位置（已经装在这里；想换位置请先卸载）" : "安装位置", 24, 172, 9f, Look.Muted, false));
        dirBox.Text = installDir;
        dirBox.Enabled = !installed;
        dirBox.Location = new Point(26, 194);
        dirBox.Width = 396;
        dirBox.Height = 28;
        dirBox.BorderStyle = BorderStyle.FixedSingle;
        before.Controls.Add(dirBox);

        Button browse = Look.MakeButton("浏览…", false);
        browse.Location = new Point(432, 193);
        browse.Width = 100;
        if (installed) browse.Enabled = false;
        browse.Click += delegate
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "安装位置";
                dialog.SelectedPath = dirBox.Text;
                if (dialog.ShowDialog(this) == DialogResult.OK) dirBox.Text = dialog.SelectedPath;
            }
        };
        before.Controls.Add(browse);

        autoBox.Text = "开机自动启动（开启后首次双击 .md 启动更快，会多一个后台进程）";
        autoBox.Location = new Point(26, 238);
        autoBox.Width = 452;
        autoBox.ForeColor = Look.Ink;
        // 装过的话，按"现在实际是什么状态"勾好——用户不动它就不会被悄悄改掉
        autoBox.Checked = installed ? Program.AutoStartOn() : autoStart == true;
        autoBox.Visible = !installed;
        before.Controls.Add(autoBox);

        if (installed)
        {
            // 已经装过：这一项属于"改设置"，折进「高级」别挡路
            Button advanced = Look.MakeButton("高级 ▸", false);
            advanced.Location = new Point(478, 234);
            advanced.Width = 54;
            advanced.Height = 28;
            advanced.Click += delegate
            {
                autoBox.Visible = !autoBox.Visible;
                advanced.Text = autoBox.Visible ? "高级 ▾" : "高级 ▸";
            };
            before.Controls.Add(advanced);
        }

        bar.Location = new Point(26, 288);
        bar.Width = 506;
        bar.Visible = false;
        before.Controls.Add(bar);

        status.AutoSize = true;
        status.ForeColor = Look.Muted;
        status.Location = new Point(26, 300);
        before.Controls.Add(status);

        Panel footer = new Panel();
        footer.Dock = DockStyle.Bottom;
        footer.Height = 64;
        footer.BackColor = Color.White;
        footer.Paint += delegate(object sender, PaintEventArgs e)
        {
            using (Pen pen = new Pen(Look.Line)) e.Graphics.DrawLine(pen, 0, 0, footer.Width, 0);
        };
        cancelButton(footer);
        installButton.Location = new Point(326, 14);
        installButton.Width = 100;
        installButton.Click += delegate { StartInstall(); };
        footer.Controls.Add(installButton);
        before.Controls.Add(footer);
    }

    void cancelButton(Panel footer)
    {
        Button cancel = Look.MakeButton("取消", false);
        cancel.Location = new Point(436, 14);
        cancel.Width = 100;
        cancel.Click += delegate { Close(); };
        footer.Controls.Add(cancel);
    }

    void BuildAfter()
    {
        after.Dock = DockStyle.Fill;
        after.BackColor = Color.White;
        after.Controls.Add(Look.Header(action + "完成", "接下来只差一步", Program.AppIcon()));

        after.Controls.Add(Caption("已经注册到「打开方式」和右键菜单。", 24, 108, 9.5f, Look.Ink, false));
        after.Controls.Add(Caption("· 右键任意 .md → 「用 Markdown Observer 阅读」", 24, 142, 9.5f, Look.Ink, false));
        after.Controls.Add(Caption("· 右键一个 .md → 打开方式 → 选择其他应用 →", 24, 168, 9.5f, Look.Ink, false));
        after.Controls.Add(Caption("  Markdown Observer，并勾选「始终使用此应用打开 .md 文件」", 24, 190, 9.5f, Look.Ink, false));
        after.Controls.Add(Caption("  （Windows 不允许程序自己抢默认，只能你自己点这一下）", 24, 216, 9f, Look.Muted, false));
        after.Controls.Add(Caption("· 开始菜单搜 Markdown Observer，或双击托盘图标即可打开阅读器", 24, 246, 9.5f, Look.Ink, false));

        Panel footer = new Panel();
        footer.Dock = DockStyle.Bottom;
        footer.Height = 64;
        footer.BackColor = Color.White;
        footer.Paint += delegate(object sender, PaintEventArgs e)
        {
            using (Pen pen = new Pen(Look.Line)) e.Graphics.DrawLine(pen, 0, 0, footer.Width, 0);
        };
        Button done = Look.MakeButton("完成", true);
        done.Location = new Point(436, 14);
        done.Width = 100;
        done.Click += delegate { Close(); };
        footer.Controls.Add(done);

        after.Controls.Add(Caption("卸载：设置 → 应用 → Markdown Observer。", 24, 282, 9f, Look.Muted, false));
        after.Controls.Add(footer);
    }

    /// <summary>安装放后台线程做，界面别卡住（90 MB 解包要几秒）。</summary>
    void StartInstall()
    {
        installButton.Enabled = false;
        status.Text = "正在准备…";
        bar.Visible = true;
        bar.Set(0, 1);
        string target = dirBox.Text.Trim();
        bool wanted = autoBox.Checked;
        Thread worker = new Thread(delegate()
        {
            try
            {
                Program.InstallForUi(target, wanted, delegate(int done, int total)
                {
                    if (!IsHandleCreated) return;
                    BeginInvoke((MethodInvoker)delegate
                    {
                        bar.Set(done, total);
                        status.Text = done >= total ? "正在写入配置和注册表…" : "正在解包 " + done + " / " + total + " …";
                    });
                });
                BeginInvoke((MethodInvoker)delegate { before.Visible = false; after.Visible = true; });
            }
            catch (Exception error)
            {
                Program.LogForUi("界面安装失败：" + error);
                BeginInvoke((MethodInvoker)delegate
                {
                    installButton.Enabled = true;
                    status.Text = "安装失败，详情见 " + Program.LogPathForUi;
                    MessageBox.Show(this, "安装未能完成：\n" + error.Message, "Markdown Observer",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            }
        });
        worker.IsBackground = true;
        worker.Start();
    }
}
