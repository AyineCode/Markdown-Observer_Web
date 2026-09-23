/*
 * MarkdownObserver.exe —— Windows 侧的"总管"（也是 .md 的"打开方式"指向的那个程序）
 *
 * 它有两个身份：
 *   【打开方式】Explorer 双击 .md 时被叫起来 —— 把文件交给服务；服务不在就起一个。
 *   【托盘后台】右下角一个图标，菜单里能打开阅读器 / 打开文件 / 退出。
 *
 * 为什么需要它：网页读不了任意路径的文件（浏览器的安全规矩），必须有一个浏览器之外的
 * "宿主"替它读。serve.mjs 是那个宿主，这个程序负责"把双击翻译成让宿主去读哪一篇"。
 *
 * 用法：
 *   MarkdownObserver.exe "C:\notes\a.md"   ← Explorer 调的就是这个
 *   MarkdownObserver.exe --tray              常驻托盘（只留一个实例）
 *   MarkdownObserver.exe --quit              服务和托盘一起退干净
 *   MarkdownObserver.exe --status            把状态写进日志（给脚本/排查用）
 *   MarkdownObserver.exe --diag              自检：把"我打算干什么"写进日志并弹出来
 *
 * 为什么用 C# 5 的写法：本机只有 .NET Framework 自带的 csc.exe（C# 5），
 *   所以不能用字符串插值、?. 、表达式体成员这些 C# 6 之后的东西。
 *
 * 配置在同目录的 config.txt（key = value，每行一条，# 开头是注释）：
 *   command = wsl.exe                 # 起服务要运行的程序
 *   args    = -d|Ubuntu|...|{file}    # 参数，用 | 分隔；{file} 会被换成 md 的路径
 *   pathmap = wsl | native            # wsl = 转成 /mnt/c/...；native = 原样交给 Windows 程序
 *   port    = 47821                   # 服务的端口（要跟 args 里的 --port 一致）
 *   tray    = on | off                # 要不要托盘后台
 *   silent  = true | false            # 出错只写日志、不弹框（脚本/自动化用）
 */

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Launcher
{
    /// <summary>出错时日志写这儿，方便远程排查。</summary>
    static readonly string LogPath = Path.Combine(Path.GetTempPath(), "markdown-observer-launcher.log");
    /// <summary>安静模式（config.txt 里的 silent = true）。--diag / --status 也走安静模式。</summary>
    static bool SilentMode = false;

    // ── 托盘只留一个：这两个名字全机唯一 --------------------------------------
    const string TrayMutexName = "Local\\MarkdownObserverTray";
    const string QuitEventName = "Local\\MarkdownObserverQuit";

    /*
      让进程"知道自己活在缩放过的屏幕上"。
      不声明的话，Windows 会先把界面按 96 DPI 画好、再整体拉大——表现就是"窗口很糊"。
      按新→旧的顺序试：每显示器 V2（Win10 1703+）→ 每显示器 → 系统级。
    */
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("shcore.dll")]
    static extern int SetProcessDpiAwareness(int value);

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    /// <summary>告诉资源管理器"文件关联变了"，让它立刻刷新图标（不必等重启或手动刷新）。</summary>
    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    [DllImport("user32.dll")]
    static extern bool FlashWindowEx(ref FLASHWINFO info);

    /// <summary>
    /// 找"已经开着的阅读器窗口"：浏览器窗口的标题会带上页面标题，而页面标题里一直有 Markdown Observer。
    /// （用它当对话框的主人、以及"把窗口叫到前台"，都比猜前台窗口靠谱。）
    /// </summary>
    static IntPtr FindReaderWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr param)
        {
            if (!IsWindowVisible(hWnd)) return true;
            int length = GetWindowTextLength(hWnd);
            if (length <= 0 || length > 512) return true;
            StringBuilder sb = new StringBuilder(length + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().IndexOf("Markdown Observer", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                found = hWnd;
                return false;   // 找到一个就够了
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>常见浏览器的主程序名，用来认出"浏览器窗口"。</summary>
    static readonly string[] BrowserNames = new string[] { "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "chromium" };

    /**
     * 找一个浏览器窗口。
     * 什么时候用：用户切到了**别的标签页**，这时浏览器窗口的标题是他正在看的那个网站，
     * 里面没有 Markdown Observer —— 光靠标题就认不出阅读器在哪，只能退一步把浏览器叫出来。
     *
     * 说清楚一件事：**没有**办法从外部切到某个具体标签页（浏览器的安全规矩）。
     * 所以能做到的极限是"把浏览器窗口带到前台"，剩下那一下点击得用户自己来。
     */
    static IntPtr FindBrowserWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr param)
        {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string name;
            try { name = Process.GetProcessById((int)pid).ProcessName; }
            catch { return true; }
            foreach (string browser in BrowserNames)
            {
                if (name.IndexOf(browser, StringComparison.OrdinalIgnoreCase) < 0) continue;
                found = hWnd;
                return false;   // 找到一个就够
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>把已经开着的阅读器窗口叫到前台（"双击了但看起来没反应"就是缺这一步）。</summary>
    static void BringReaderToFront()
    {
        IntPtr reader = FindReaderWindow();
        // 认不出来（多半是切到别的标签页了）→ 把浏览器窗口叫出来，至少让用户一眼看见
        if (reader == IntPtr.Zero)
        {
            reader = FindBrowserWindow();
            if (reader != IntPtr.Zero) Log("没找到阅读器窗口（大概切到别的标签页了），改叫浏览器窗口");
        }
        if (reader == IntPtr.Zero) return;
        // 只有窗口"最小化"的时候才还原它。别的什么都别做：
        // 随手调 ShowWindow 会把最大化 / 全屏的浏览器变回一个小窗口（全屏看文档的观感就毁了）。
        if (IsIconic(reader)) ShowWindow(reader, 9);   // SW_RESTORE
        if (SetForegroundWindow(reader)) { Log("把阅读器窗口叫到前台"); return; }
        // 抢不到前台（Windows 有防抢焦点的规矩）：至少让任务栏闪几下
        FLASHWINFO info = new FLASHWINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        info.hwnd = reader;
        info.dwFlags = 3;                       // FLASHW_ALL
        info.uCount = 3;
        FlashWindowEx(ref info);
        Log("没能抢到前台，改成闪任务栏");
    }

    static void EnableDpiAwareness()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { /* 老系统没有这个 API */ }
        try { if (SetProcessDpiAwareness(2) == 0) return; } catch { /* 同上 */ }
        try { SetProcessDPIAware(); } catch { /* 尽力了 */ }
    }

    [STAThread]   // 必须：WinForms 的文件对话框要求单线程单元，少了它一弹框就炸
    static int Main(string[] args)
    {
        EnableDpiAwareness();
        try
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string configPath = Path.Combine(exeDir, "config.txt");

            if (args.Length >= 1 && args[0] == "--diag")
            {
                string diag = BuildDiagnostics(exeDir, configPath);
                File.WriteAllText(LogPath, diag, Encoding.UTF8);
                // 配置里写了 silent 就只写日志（自动化测试用），否则弹出来给人看
                bool quiet = File.Exists(configPath) && Config.Load(configPath).Silent;
                SilentMode = quiet;
                if (!quiet) MessageBox.Show(diag, "Markdown Observer · 自检", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }

            if (!File.Exists(configPath))
            {
                /*
                  没有 config.txt —— 这个程序还没装好（安装包是先解包、再写配置的），或者刚被卸载。
                  控制类命令（退出/看状态/卸载/打开阅读器）这时候什么都不用做，安静退出就好：
                  以前它们也会弹框，于是"安装到一半突然蹦出个找不到配置文件"（这个坑踩过）。
                  只有"被人双击"那种调用才值得弹一句提示。
                */
                bool controlOnly = args.Length >= 1
                    && (args[0] == "--quit" || args[0] == "--status" || args[0] == "--uninstall" || args[0] == "--reader");
                Log("没有配置文件（" + configPath + "），当作还没装：安静退出");
                if (controlOnly) return 0;
                Fail("找不到配置文件：\r\n" + configPath + "\r\n\r\n请重新运行一次安装（node tools/win/install.mjs）。");
                return 3;
            }

            if (args.Length >= 1 && args[0] == "--tray") return RunTray(configPath);

            Config config = Config.Load(configPath);
            SilentMode = config.Silent;

            if (args.Length >= 1 && args[0] == "--quit") return QuitEverything(config);
            if (args.Length >= 1 && args[0] == "--status") return ReportStatus(config);
            if (args.Length >= 1 && args[0] == "--reader") return OpenReaderMode(config);
            if (args.Length >= 1 && args[0] == "--uninstall") return Uninstall(Path.GetDirectoryName(Application.ExecutablePath));

            if (args.Length < 1 || args[0].Length == 0 || args[0].StartsWith("--"))
            {
                Fail("没有拿到文件路径。\r\n\r\n这个程序是给 Windows 的“打开方式”用的：\r\n右键一个 .md 文件 → 打开方式 → Markdown Observer。\r\n直接双击它本身没有意义。");
                return 2;
            }

            string file = ResolveTarget(args[0]);
            if (!File.Exists(file))
            {
                Fail("找不到这个文件：\r\n" + file);
                return 4;
            }
            return OpenFile(config, file);
        }
        catch (Exception error)
        {
            Fail("出错了：" + error.Message + "\r\n\r\n日志：" + LogPath);
            Log("EXCEPTION " + error);
            return 1;
        }
    }

    // ─────────────────────────── 打开一篇 ───────────────────────────

    /// <summary>
    /// 双击的入口：服务在跑就把文件交给它，不在跑就起一个。
    /// 交给服务之后由服务决定"复用开着的页面"还是"新开一个标签页"（见 serve.mjs 的 /api/open）。
    /// </summary>
    static int OpenFile(Config config, string file)
    {
        string mapped = config.PathMap == "wsl" ? ToWslPath(file) : file;

        if (ServiceAlive(config))
        {
            Log("服务已经在跑，把文件交给它：" + mapped);
            OpenViaService(config, mapped);
            BringReaderToFront();   // 交给服务之后把窗口叫到前面来，不然"看起来没反应"
            EnsureTray(config);
            return 0;
        }

        Log("服务没在跑，起一个：" + mapped);
        int code = StartService(config, mapped);
        if (code != 0) return code;
        EnsureTray(config);
        return 0;
    }

    /// <summary>起服务。--open 会让服务自己打开浏览器，所以这里只负责把它拉起来。</summary>
    static int StartService(Config config, string file)
    {
        string[] argv = config.BuildArgs(file);
        ProcessStartInfo psi = new ProcessStartInfo(config.Command, QuoteAll(argv));
        psi.UseShellExecute = false;      // 自己起进程，不经由 shell
        psi.CreateNoWindow = true;        // 不闪黑窗口
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.WorkingDirectory = SafeWorkingDirectory();

        Process child;
        try
        {
            child = Process.Start(psi);
        }
        catch (Exception error)
        {
            Fail("跑不起来这条命令：\r\n  " + config.Command + "\r\n\r\n" + error.Message
                + "\r\n\r\n（本机开发模式常见原因：WSL 没启动、或者 node 不在 PATH 里）\r\n\r\n日志：" + LogPath);
            return 5;
        }
        if (child == null)
        {
            Fail("系统没能启动：" + config.Command);
            return 5;
        }
        Log("服务进程 pid = " + child.Id);

        // 盯一会儿：起得来就放手，起不来就把原因摆出来（"双击没反应"是最难查的故障）
        Log("等子进程 1.5 秒…");
        if (!child.WaitForExit(1500))
        {
            Log("子进程还活着，等服务把端口听起来…");
            WaitServiceUp(config, 8000);
            Log("服务就绪检查结束");
            return 0;
        }
        if (child.ExitCode == 0) return 0;
        Log("服务提前退出，退出码 " + child.ExitCode);
        Fail("阅读器没能启动（退出码 " + child.ExitCode + "）。\r\n\r\n"
            + "常见原因：\r\n"
            + "  · 端口被别的程序占用\r\n"
            + "  · 配置里那条命令跑不起来（node 没装、路径变了、WSL 关了）\r\n"
            + "  · 要打开的文件已经被移走或改名\r\n\r\n"
            + "日志：" + LogPath);
        return 6;
    }

    /// <summary>等服务把端口听起来（最多等 timeout 毫秒）。等不到不算失败：浏览器那边可能自己会好。</summary>
    static void WaitServiceUp(Config config, int timeout)
    {
        int waited = 0;
        while (waited < timeout)
        {
            if (ServiceAlive(config)) return;
            Thread.Sleep(250);
            waited += 250;
        }
        Log("等了 " + timeout + "ms 服务还没起来（端口 " + config.Port + "）");
    }

    /// <summary>把一篇交给已经在跑的服务。</summary>
    static void OpenViaService(Config config, string wirePath)
    {
        string url = "http://127.0.0.1:" + config.Port + "/api/open?path=" + Uri.EscapeDataString(wirePath);
        string body = HttpGet(url, 4000);
        Log(body == null ? "交给服务失败" : "服务的回答：" + body);
    }

    /// <summary>端口上是不是我们的服务。</summary>
    static bool ServiceAlive(Config config)
    {
        string body = HttpGet("http://127.0.0.1:" + config.Port + "/api/info", 1500);
        return body != null && body.Contains("\"mode\":\"server\"");
    }

    /// <summary>让服务和托盘一起退干净。</summary>
    static int QuitEverything(Config config)
    {
        Log("请求服务退出（端口 " + config.Port + "）");
        StopService(config);
        SignalTrayQuit();
        return 0;
    }

    /// <summary>请服务自己退出（/api/quit）。</summary>
    static void StopService(Config config)
    {
        HttpGet("http://127.0.0.1:" + config.Port + "/api/quit", 3000);
    }

    /// <summary>叫醒托盘进程让它退出（托盘在等这个事件）。</summary>
    static void SignalTrayQuit()
    {
        try
        {
            EventWaitHandle handle = EventWaitHandle.OpenExisting(QuitEventName);
            handle.Set();
            handle.Close();
        }
        catch
        {
            // 没有托盘在跑：正常
        }
    }

    /// <summary>把当前状态写进日志（排查用）。</summary>
    static int ReportStatus(Config config)
    {
        SilentMode = true;
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("serviceAlive=" + (ServiceAlive(config) ? "yes" : "no"));
        sb.AppendLine("port=" + config.Port);
        sb.AppendLine("info=" + HttpGet("http://127.0.0.1:" + config.Port + "/api/info", 1500));
        sb.AppendLine("trayRunning=" + TrayRunning());
        Log(sb.ToString());
        return 0;
    }

    /// <summary>托盘是不是已经在跑（试着开一下那个互斥体）。</summary>
    static bool TrayRunning()
    {
        bool created;
        Mutex probe = new Mutex(true, TrayMutexName, out created);
        if (created)
        {
            probe.ReleaseMutex();
            probe.Close();
            return false;
        }
        return true;
    }

    /// <summary>还没托盘就拉起一个（它是独立进程，服务不随它生死）。</summary>
    static void EnsureTray(Config config)
    {
        if (!config.Tray) return;
        if (TrayRunning()) return;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(Application.ExecutablePath, "--tray");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.WorkingDirectory = SafeWorkingDirectory();
            Process.Start(psi);
            Log("拉起了托盘");
        }
        catch (Exception error)
        {
            Log("拉托盘失败：" + error.Message);
        }
    }

    // ─────────────── 新式文件夹选择框（Windows 10/11 那个，浏览器用的也是它） ───────────────
    /*
      为什么自己声明这些接口：.NET Framework 的 FolderBrowserDialog 用的是 Windows 最老的那个
      文件夹框（SHBrowseForFolder）——又老气又不跟手。浏览器弹的"选择文件夹"其实是新式的
      IFileOpenDialog（加上 FOS_PICKFOLDERS），所以人家又清晰又现代。这里照做一遍。
    */
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint fos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct COMDLG_FILTERSPEC
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pszName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszSpec;
    }

    /// <summary>
    /// 弹 Windows 10/11 那个新式「打开文件」窗口，只让挑 markdown。
    /// @returns 选中的路径；null = 用户取消或弹不出来
    /// </summary>
    static string PickFileModern(IntPtr owner)
    {
        const uint FOS_FORCEFILESYSTEM = 0x40;
        const uint FOS_PATHMUSTEXIST = 0x800;
        const uint FOS_FILEMUSTEXIST = 0x1000;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        IFileDialog dialog = null;
        IntPtr filterBuffer = IntPtr.Zero;
        try
        {
            Type type = Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7"));
            dialog = (IFileDialog)Activator.CreateInstance(type);
            dialog.SetOptions(FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_FILEMUSTEXIST);
            dialog.SetTitle("打开 Markdown 文档");
            // 文件类型过滤器："Markdown" 放前面（默认选它），留一个"所有文件"做后路
            COMDLG_FILTERSPEC[] specs = new COMDLG_FILTERSPEC[2];
            specs[0].pszName = "Markdown";
            specs[0].pszSpec = "*.md;*.markdown;*.mdown;*.mkd;*.txt";
            specs[1].pszName = "所有文件";
            specs[1].pszSpec = "*.*";
            int size = Marshal.SizeOf(typeof(COMDLG_FILTERSPEC));
            filterBuffer = Marshal.AllocCoTaskMem(size * specs.Length);
            for (int i = 0; i < specs.Length; i++)
            {
                Marshal.StructureToPtr(specs[i], new IntPtr(filterBuffer.ToInt64() + i * size), false);
            }
            dialog.SetFileTypes((uint)specs.Length, filterBuffer);
            dialog.SetFileTypeIndex(1);
            if (dialog.Show(owner) != 0) return null;
            IShellItem item;
            dialog.GetResult(out item);
            string path;
            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
            if (item != null) Marshal.ReleaseComObject(item);
            return path;
        }
        catch (Exception error)
        {
            Log("新式文件框弹不出来：" + error.Message);
            return null;
        }
        finally
        {
            if (filterBuffer != IntPtr.Zero) Marshal.FreeCoTaskMem(filterBuffer);
            if (dialog != null) Marshal.ReleaseComObject(dialog);
        }
    }

    /// <summary>
    /// 弹 Windows 10/11 那个新式「选择文件夹」窗口。
    /// @returns 选中的路径；null = 用户取消或这个系统上弹不出来
    /// </summary>
    static string PickFolderModern(IntPtr owner)
    {
        const uint FOS_PICKFOLDERS = 0x20;      // 只选文件夹
        const uint FOS_FORCEFILESYSTEM = 0x40;  // 只认文件系统里的东西
        const uint FOS_PATHMUSTEXIST = 0x800;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        IFileDialog dialog = null;
        try
        {
            Type type = Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7"));
            dialog = (IFileDialog)Activator.CreateInstance(type);
            dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            dialog.SetTitle("选择要阅读的文件夹");
            if (dialog.Show(owner) != 0) return null;   // 非 0 = 用户取消
            IShellItem item;
            dialog.GetResult(out item);
            string path;
            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
            if (item != null) Marshal.ReleaseComObject(item);
            return path;
        }
        catch (Exception error)
        {
            Log("新式文件夹框弹不出来（改用老办法）：" + error.Message);
            return null;
        }
        finally
        {
            if (dialog != null) Marshal.ReleaseComObject(dialog);
        }
    }

    // ─────────────────────────── 托盘给服务端/网页开的小口子 ───────────────────────────
    /*
      网页拿不到文件夹的真实路径（浏览器的隐私规矩），所以"用服务端快速扫描一个大文件夹"
      这件事只能由系统选择框来做。而弹新式选择框需要这个托盘程序 ——
      于是服务端收到网页的请求后，转手来问这里（127.0.0.1:47822）。
    */
    const int TrayPort = 47822;
    /**
     * 允许哪个源来调这些小接口。
     * 以前回的是 Access-Control-Allow-Origin: *，那等于**任何网站**都能让用户的浏览器
     * 去调 /set-autostart 或弹出选择框（跨站请求伪造）。现在只认我们自己的页面。
     */
    static string allowedOrigin = null;

    // ── 开机自启 ─────────────────────────────────────────────────────────
    /*
      写在 HKCU...Run 里（当前用户），不需要管理员权限。
      默认**不开**：设置面板里可以随时开，安装的时候也会问一句。
      开着的理由只有一个——双击 md 时不用现起后台服务（省 1~2 秒），代价是开机多一个后台进程。
    */
    const string RunKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const string RunValue = "Markdown Observer";

    /// <summary>开机自启开着吗？</summary>
    static bool AutoStartOn()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey, false))
            {
                if (key == null) return false;
                object value = key.GetValue(RunValue);
                return value != null && Convert.ToString(value).Length > 0;
            }
        }
        catch (Exception error)
        {
            Log("读开机自启失败：" + error.Message);
            return false;
        }
    }

    /// <summary>开/关开机自启。@returns 是否改成功</summary>
    static bool SetAutoStart(bool on)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (key == null) return false;
                if (on) key.SetValue(RunValue, "\"" + Application.ExecutablePath + "\" --tray");
                else key.DeleteValue(RunValue, false);
            }
            Log("开机自启 -> " + (on ? "开" : "关"));
            return true;
        }
        catch (Exception error)
        {
            Log("改开机自启失败：" + error.Message);
            return false;
        }
    }

    /// <summary>给页面用：查 / 改开机自启。</summary>
    static string HandleAutoStart(string requestLine)
    {
        if (requestLine.IndexOf("/set-autostart") >= 0)
        {
            bool on = requestLine.IndexOf("on=1") >= 0 || requestLine.IndexOf("on=true") >= 0;
            bool ok = SetAutoStart(on);
            return "{\"ok\":" + (ok ? "true" : "false") + ",\"on\":" + (AutoStartOn() ? "true" : "false") + "}";
        }
        return "{\"on\":" + (AutoStartOn() ? "true" : "false") + "}";
    }

    /// <summary>起一个小接口：收到 /pick-folder 就弹选择框，选完让服务端换根目录。</summary>
    static void StartTrayServer(Config config)
    {
        Thread thread = new Thread(delegate()
        {
            TcpListener listener = null;
            try
            {
                // 绑不上就等一会儿再试：上一个托盘刚退出时，端口可能还在 TIME_WAIT 里
                // （不设 ReuseAddress 的话，这段时间新托盘会一直绑不上，网页就找不到它）
                while (true)
                {
                    try
                    {
                        allowedOrigin = "http://127.0.0.1:" + config.Port;
                listener = new TcpListener(IPAddress.Loopback, TrayPort);
                        listener.ExclusiveAddressUse = false;
                        listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                        listener.Start();
                        break;
                    }
                    catch (Exception error)
                    {
                        Log("控制口绑不上（5 秒后重试）：" + error.Message);
                        Thread.Sleep(5000);
                    }
                }
                Log("托盘控制口在 127.0.0.1:" + TrayPort);
                while (true)
                {
                    using (TcpClient client = listener.AcceptTcpClient())
                    using (NetworkStream stream = client.GetStream())
                    {
                        string line = ReadRequestHead(stream);
                        string origin = line == null ? null : RequestOrigin(line);
                        bool foreign = origin != null && origin.Length > 0 && origin != "null" && origin != allowedOrigin;
                        if (foreign) Log("挡掉一个跨站请求，来源：" + origin);
                        string body = foreign ? "{\"ok\":false,\"error\":\"cross-origin refused\"}"
                            : line != null && line.Contains("/pick-folder") ? HandlePickFolder(config)
                            : line != null && line.Contains("/pick-file") ? HandlePickFile(config)
                            : line != null && line.Contains("autostart") ? HandleAutoStart(line)
                            : "{\"ok\":false,\"error\":\"unknown path\"}";
                        WriteResponse(stream, body);
                    }
                }
            }
            catch (Exception error)
            {
                Log("托盘控制口停了：" + error.Message);
            }
            finally
            {
                if (listener != null) listener.Stop();
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    /// <summary>弹选择框 → 让服务端换根目录。跑在后台线程上，弹框那段切回 UI 线程。</summary>
    static string HandlePickFolder(Config config)
    {
        // 网页可能连点两下加号：这里也挡一道，别排出两个窗口
        if (DialogBusy()) return "{\"ok\":false,\"cancelled\":true}";
        BeginDialog();
        try
        {
            return PickFolderAndSwitch(config);
        }
        finally
        {
            pickingDialog = false;
        }
    }

    /// <summary>弹新式「打开文件」窗口 → 把选中的文件交给服务端（服务端再推给页面）。</summary>
    static string HandlePickFile(Config config)
    {
        if (DialogBusy()) return "{\"ok\":false,\"cancelled\":true}";
        BeginDialog();
        try
        {
            string path = null;
            trayHost.Invoke((MethodInvoker)delegate { path = PickFileModern(DialogOwner()); });
            if (path == null) return "{\"ok\":false,\"cancelled\":true}";   // 用户取消
            string wire = ToWire(config, path);
            Log("托盘选了文件：" + wire);
            string body = HttpGet("http://127.0.0.1:" + config.Port + "/api/open?path=" + Uri.EscapeDataString(wire), 20000);
            if (body == null) return "{\"ok\":false,\"error\":\"server unreachable\"}";
            Log("服务端的回答：" + body);
            BringReaderToFront();   // 复用那个页面时，把它叫到前面来
            return "{\"ok\":true}";
        }
        catch (Exception error)
        {
            Log("打开文件失败：" + error.Message);
            return "{\"ok\":false,\"error\":\"dialog failed\"}";
        }
        finally
        {
            pickingDialog = false;
        }
    }

    /// <summary>弹出新式选择框 → 让服务端换根目录。</summary>
    static string PickFolderAndSwitch(Config config)
    {
        string path = null;
        try
        {
            trayHost.Invoke((MethodInvoker)delegate { path = PickFolderModern(DialogOwner()); });
        }
        catch (Exception error)
        {
            Log("弹选择框失败：" + error.Message);
            return "{\"ok\":false,\"error\":\"dialog failed\"}";
        }
        if (path == null) return "{\"ok\":false,\"cancelled\":true}";
        string wire = ToWire(config, path);
        string body = HttpGet("http://127.0.0.1:" + config.Port + "/api/root?path=" + Uri.EscapeDataString(wire), 20000);
        Log("托盘选了文件夹：" + wire + " -> " + body);
        if (body == null) return "{\"ok\":false,\"error\":\"server unreachable\"}";
        // 把选中的目录一并报回去：页面要认它当**自己**的工作区（各自一棵树，互不干扰）
        return "{\"ok\":true,\"name\":" + JsonString(BaseName(wire)) + ",\"root\":" + JsonString(wire) + "}";
    }

    /// <summary>
    /// 把整个请求头读完（直到空行）。
    /// 为什么要读完而不是只读一行：socket 里只要有没读完的数据就关，TCP 会发 RST 而不是正常关闭，
    /// 对方（浏览器/PowerShell）就会报"远程主机强迫关闭了一个现有的连接"——响应其实已经发出去了。
    /// </summary>
    static string ReadRequestHead(NetworkStream stream)
    {
        StringBuilder sb = new StringBuilder();
        byte[] one = new byte[1];
        for (int i = 0; i < 8192; i++)
        {
            int read;
            try { read = stream.Read(one, 0, 1); } catch { break; }
            if (read <= 0) break;
            sb.Append((char)one[0]);
            int length = sb.Length;
            if (length >= 4 && sb[length - 4] == '\r' && sb[length - 3] == '\n' && sb[length - 2] == '\r' && sb[length - 1] == '\n') break;
        }
        return sb.Length == 0 ? null : sb.ToString();
    }

    /// <summary>请求头里的 Origin（没有就返回 null）。</summary>
    static string RequestOrigin(string head)
    {
        foreach (string raw in head.Split('\n'))
        {
            string line = raw.Trim();
            if (line.StartsWith("Origin:", StringComparison.OrdinalIgnoreCase)) return line.Substring(7).Trim();
        }
        return null;
    }

    /// <summary>回一个最小的 HTTP 响应（只允许我们自己的页面跨站调用）。</summary>
    static void WriteResponse(NetworkStream stream, string body)
    {
        byte[] payload = Encoding.UTF8.GetBytes(body);
        StringBuilder head = new StringBuilder();
        head.Append("HTTP/1.1 200 OK\r\n");
        head.Append("Content-Type: application/json; charset=utf-8\r\n");
        head.Append("Access-Control-Allow-Origin: ").Append(allowedOrigin ?? "http://127.0.0.1").Append("\r\n");
        head.Append("Content-Length: ").Append(payload.Length).Append("\r\n");
        head.Append("Connection: close\r\n\r\n");
        byte[] headBytes = Encoding.ASCII.GetBytes(head.ToString());
        try
        {
            stream.Write(headBytes, 0, headBytes.Length);
            stream.Write(payload, 0, payload.Length);
            stream.Flush();
        }
        catch { /* 对方走了就算了 */ }
    }

    // ─────────────────────────── 卸载 ───────────────────────────

    /**
     * 卸载：停服务 → 删注册表 → 把自己所在的目录删掉。
     * 之所以要它：给"设置 → 应用"里那个"卸载"按钮用，小白不该被要求去跑 node 脚本。
     * 删自己有个先后问题：程序还在跑就删不掉自己的文件，所以交给一个 detached 的
     * cmd 等一秒再删——那时本进程已经退出了。
     */
    static int Uninstall(string exeDir)
    {
        SilentMode = true;
        Log("开始卸载：" + exeDir);

        DialogResult answer = MessageBox.Show(
            "要卸载 Markdown Observer 吗？\n\n"
            + "· 会删掉程序文件、右键菜单、「打开方式」里的条目\n"
            + "· 开机自动启动（如果开过）也会关掉\n\n"
            + "你的 Markdown 文件不会被动。",
            "Markdown Observer", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (answer != DialogResult.Yes) { Log("用户取消了卸载"); return 0; }

        ProgressForm progress = new ProgressForm("正在卸载 Markdown Observer…");
        progress.Show();
        progress.Step("正在停止后台服务…", 1);

        // ① 先把服务和托盘停掉（托盘会占着 exe）
        try
        {
            string configPath = Path.Combine(exeDir, "config.txt");
            if (File.Exists(configPath))
            {
                Config config = Config.Load(configPath);
                StopService(config);
            }
        }
        catch (Exception error) { Log("停服务失败（继续）：" + error.Message); }
        SignalTrayQuit();
        /*
          等托盘真的退干净再往下走。以前只 Sleep(1200) 就不管了——
          托盘要是还没退，后面 rmdir 删不掉它的文件，它就一直活着（"卸载完托盘还在"就是这么来的）。
          等不到就强杀，但绝不杀自己。
        */
        /*
          等它自己退，**但不强杀**。
          两个原因：① 被杀掉的托盘会在通知区留下"幽灵图标"；
          ② 更重要的——"枚举进程并结束它"是恶意软件的动作，一个刚装上的新程序干这个，
          行为监控会直接把它删掉（安装器上就踩过这个坑，见 setup.cs 的 StopRunning）。
          真退不掉就在最后那句话里说清楚。
        */
        int me = Process.GetCurrentProcess().Id;
        bool stubborn = false;
        for (int i = 0; i < 24; i++)
        {
            Process[] alive = Process.GetProcessesByName("MarkdownObserver");
            bool anyOther = false;
            foreach (Process one in alive)
            {
                if (one.Id != me) anyOther = true;
                one.Dispose();
            }
            if (!anyOther) break;
            if (i == 23) stubborn = true;
            Thread.Sleep(250);
        }
        if (stubborn) Log("还有进程没退干净，个别文件可能删不掉（不再强杀：那是恶意软件的动作）");
        progress.Step("正在清理注册表…", 2);

        // ② 删注册表（右键菜单、"打开方式"、ProgID、Applications、以及"设置→应用"里这一条）
        string[] exts = new string[] { ".md", ".markdown", ".mdown", ".mkd" };
        const string classes = "Software\\Classes";
        DeleteKey(Registry.CurrentUser, classes + "\\MarkdownObserver.md");
        DeleteKey(Registry.CurrentUser, classes + "\\Applications\\" + Path.GetFileName(Application.ExecutablePath));
        foreach (string ext in exts)
        {
            RegistryKey openWith = Registry.CurrentUser.OpenSubKey(classes + "\\" + ext + "\\OpenWithProgids", true);
            if (openWith != null)
            {
                try { openWith.DeleteValue("MarkdownObserver.md", false); } catch { }
                openWith.Close();
            }
            DeleteKey(Registry.CurrentUser, classes + "\\SystemFileAssociations\\" + ext + "\\shell\\MarkdownObserver");
        }
        DeleteKey(Registry.CurrentUser, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MarkdownObserver");
        // 开机自启也要摘掉：留着的话，下次开机 Windows 会去启动一个已经不存在的程序
        SetAutoStart(false);
        /*
          清掉 .md 的"默认打开方式"选择。
          它记在 HKCU\...\Explorer\FileExts\.md\UserChoice 里，带一个防篡改哈希——
          程序**改**不了（Windows 不让），但"整条删掉"是允许的，删掉就回到系统默认。
          不删的话，卸载之后 .md 的图标和双击行为还指着一个已经不存在的程序。
        */
        foreach (string ext in exts)
        {
            try
            {
                string choiceKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\" + ext + "\\UserChoice";
                using (RegistryKey choice = Registry.CurrentUser.OpenSubKey(choiceKey, false))
                {
                    if (choice == null) continue;
                    string progId = Convert.ToString(choice.GetValue("ProgId"));
                    if (progId == null || progId.IndexOf("MarkdownObserver", StringComparison.OrdinalIgnoreCase) < 0) continue;
                }
                DeleteKey(Registry.CurrentUser, choiceKey);
                Log("清掉了默认程序选择：" + ext);
            }
            catch (Exception error) { Log("清 FileExts 失败 " + ext + "：" + error.Message); }
        }
        // 告诉 Explorer "关联变了"，别等它自己发现（图标缓存也跟着刷）
        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);

        // 开始菜单快捷方式 + App Paths：不清的话，搜索里会留一个点不开的空壳
        try
        {
            string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "Microsoft", "Windows", "Start Menu", "Programs", "Markdown Observer.lnk");
            if (File.Exists(lnk)) File.Delete(lnk);
        }
        catch (Exception error) { Log("删快捷方式失败：" + error.Message); }
        DeleteKey(Registry.CurrentUser, "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\MarkdownObserver.exe");

        progress.Step("正在删除程序文件…", 3);
        progress.Close();

        // ③ 说一声再走（用户是从"设置 → 应用"点进来的，给个明确的收尾）
        MessageBox.Show(
            "Markdown Observer 卸载完成。\n\n"
            + "· 右键菜单、「打开方式」里的条目都清掉了\n"
            + "· 开机自动启动（如果开过）也关掉了\n\n"
            + "你的 Markdown 文件一个都没动。"
            + (stubborn
                ? "\n\n⚠ 有一个进程没退干净，个别文件可能没删掉。\n重启后手动删掉这个目录即可：\n" + exeDir
                : ""),
            "Markdown Observer", MessageBoxButtons.OK, MessageBoxIcon.Information);

        // ④ 删自己所在的目录：交给一个 detached 的 cmd，等一秒（那时本进程已经退了）
        try
        {
            string command = "ping -n 2 127.0.0.1 >nul & rmdir /s /q \"" + exeDir + "\"";
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c " + command);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.WorkingDirectory = SafeWorkingDirectory();
            Process.Start(psi);
        }
        catch (Exception error) { Log("删目录失败：" + error.Message); }
        Log("卸载完成");
        return 0;
    }

    /// <summary>删一个注册表键（不存在就算了）。</summary>
    static void DeleteKey(RegistryKey root, string path)
    {
        try { root.DeleteSubKeyTree(path, false); }
        catch (Exception error) { Log("删注册表键失败 " + path + "：" + error.Message); }
    }

    // ─────────────────────────── 托盘 ───────────────────────────

    static EventWaitHandle quitEvent = null;
    /// <summary>
    /// 托盘那个"主人窗口"：一个**永远不会显示**的窗口。
    /// 为什么要重写 SetVisibleCore：WinForms 在建窗口句柄、或者往它上面 Invoke 的时候，
    /// 有可能真把它显示出来——用户就会看到一个空白小窗口，而关掉它托盘也跟着没了（它是主窗口）。
    /// 这里把"显示"这个动作按死；再拦一手"用户手动关闭"，别让它把托盘带走。
    /// </summary>
    class HiddenHost : Form
    {
        protected override void SetVisibleCore(bool value)
        {
            base.SetVisibleCore(false);   // 不管谁来要求显示，都当没听见
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // 手动关它不算数；Application.Exit() 走的是 ApplicationExitCall，不受影响
            if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; return; }
            base.OnFormClosing(e);
        }
    }

    /// <summary>托盘的"主人窗口"：看不见，但对话框需要它当 owner（现在多半用前台窗口当 owner）。</summary>
    static Form trayHost = null;
    /// <summary>正在弹对话框？挡住重复请求——连点两下菜单不该排出两个窗口（"弹弹弹"真的发生过）。</summary>
    static bool pickingDialog = false;
    /// <summary>这次"正在弹"是什么时候开始的（用来收拾"对话框丢了但闸还占着"的情况）。</summary>
    static DateTime pickingSince = DateTime.MinValue;

    /// <summary>
    /// 有对话框正开着吗？（超过 5 分钟没动静就当它丢了，放行新的请求——
    /// 否则那个闸会被一个看不见的窗口一直占着，用户点什么都没反应。）
    /// </summary>
    static bool DialogBusy()
    {
        if (!pickingDialog) return false;
        if ((DateTime.Now - pickingSince).TotalMinutes > 5)
        {
            Log("上一个对话框超过 5 分钟没动静，当它丢了，放行新的请求");
            pickingDialog = false;
            return false;
        }
        return true;
    }

    /// <summary>开始/结束"正在弹对话框"这段状态。</summary>
    static void BeginDialog()
    {
        pickingDialog = true;
        pickingSince = DateTime.Now;
    }

    /// <summary>
    /// 该让谁当对话框的主人：**当前前台窗口**（通常是浏览器）。
    /// 拿我们自己那个看不见的小窗口当主人，对话框会被摆到屏幕外、或躲在别的窗口后面——
    /// 表现就是"点了没反应"（这个坑刚踩过，日志里一堆"已经有一个对话框开着"就是它）。
    /// </summary>
    static IntPtr DialogOwner()
    {
        IntPtr reader = FindReaderWindow();
        if (reader != IntPtr.Zero) return reader;   // 首选：已经开着的阅读器窗口
        IntPtr foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero)
        {
            uint pid;
            GetWindowThreadProcessId(foreground, out pid);
            // 前台窗口要是"我们自己"（比如刚点过的托盘菜单），拿它当主人反而可能出问题——
            // 那种情况返回 0，让系统自己挑一个主人
            if (pid != (uint)Process.GetCurrentProcess().Id) return foreground;
        }
        return IntPtr.Zero;
    }

    /// <summary>托盘：右下角一个图标，菜单里能打开阅读器 / 打开文件 / 退出。只留一个实例。</summary>
    static int RunTray(string configPath)
    {
        bool created;
        Mutex mutex = new Mutex(true, TrayMutexName, out created);
        if (!created) return 0;   // 已经有一个托盘在跑了

        Config config = Config.Load(configPath);
        SilentMode = config.Silent;
        Application.EnableVisualStyles();
        // 只在这个线程上抓 UI 异常：出问题写日志 + 弹一个看得懂的框，别让托盘默默死掉
        Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e)
        {
            Log("UI 线程异常：" + e.Exception);
            Fail("操作出错了：" + e.Exception.Message + "\r\n\r\n日志：" + LogPath);
        };

        // 一个看不见的窗口：给对话框兜底当主人，也给菜单一个"收干净之后再弹框"的落点
        trayHost = new HiddenHost();
        trayHost.ShowInTaskbar = false;
        trayHost.FormBorderStyle = FormBorderStyle.None;
        trayHost.StartPosition = FormStartPosition.Manual;
        trayHost.Location = new System.Drawing.Point(-32000, -32000);
        trayHost.Size = new System.Drawing.Size(1, 1);
        IntPtr force = trayHost.Handle;   // 逼它把窗口句柄建出来
        GC.KeepAlive(force);

        NotifyIcon icon = new NotifyIcon();
        icon.Icon = LoadAppIcon();
        icon.Text = "Markdown Observer";
        ContextMenu menu = new ContextMenu();
        // 菜单还开着的时候弹模态对话框容易把消息循环卡住，所以等菜单收干净再弹（BeginInvoke）
        menu.MenuItems.Add("打开阅读器", delegate(object s, EventArgs e)
        {
            trayHost.BeginInvoke((MethodInvoker)delegate { OpenReader(config); });
        });
        menu.MenuItems.Add("打开文件…", delegate(object s, EventArgs e)
        {
            trayHost.BeginInvoke((MethodInvoker)delegate { PickAndOpen(config); });
        });
        menu.MenuItems.Add("打开文件夹…", delegate(object s, EventArgs e)
        {
            trayHost.BeginInvoke((MethodInvoker)delegate { PickFolder(config); });
        });
        menu.MenuItems.Add("-");
        menu.MenuItems.Add("卸载 Markdown Observer…", delegate(object s, EventArgs e)
        {
            // Windows 11 从"开始菜单 → 卸载"只会把你丢到设置的应用列表，还得自己搜一遍；
            // 托盘上这一条是更顺手的入口（里面还会再确认一次）。
            trayHost.BeginInvoke((MethodInvoker)delegate
            {
                Uninstall(Path.GetDirectoryName(Application.ExecutablePath));
                Application.Exit();
            });
        });
        menu.MenuItems.Add("退出（同时停掉阅读器服务）", delegate(object s, EventArgs e)
        {
            StopService(config);
            icon.Visible = false;
            Application.Exit();
        });
        icon.ContextMenu = menu;
        // 左键单击直接打开阅读器（右键才出菜单）。不要再挂 DoubleClick：那样一次双击会开三次。
        icon.MouseClick += delegate(object s, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) OpenReader(config);
        };
        icon.Visible = true;
        Log("托盘起来了（端口 " + config.Port + "）");
        // 自启项里存的是"当时那个 exe 的路径"：换了安装位置就失效了，所以每次起来顺手刷新一下
        if (AutoStartOn()) SetAutoStart(true);
        StartTrayServer(config);   // 让服务端/网页能请它弹"选择文件夹"

        quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName);
        Thread waiter = new Thread(delegate()
        {
            quitEvent.WaitOne();
            Log("收到退出信号");
            icon.Visible = false;
            Application.Exit();
        });
        waiter.IsBackground = true;
        waiter.Start();

        Application.Run(new ApplicationContext(trayHost));
        icon.Dispose();
        trayHost.Dispose();
        return 0;
    }

    /// <summary>
    /// 左键：开一个**新的**阅读器页面（干净的 start 页，不自动打开任何文档）。
    /// n=时间戳 是为了让每次的地址都不一样——否则浏览器会跳到已经开着的那个同地址标签，
    /// 用户看到的就是"怎么还是刚才那篇"。
    /// </summary>
    /// <summary>开始菜单/桌面快捷方式走这条：把服务叫起来（或接上已经在跑的那个），然后开阅读器。</summary>
    static int OpenReaderMode(Config config)
    {
        Log("从快捷方式打开阅读器");
        if (!ServiceAlive(config)) StartService(config, null);   // null = 只起服务，不打开具体哪一篇
        EnsureTray(config);
        OpenReader(config);
        return 0;
    }

    static void OpenReader(Config config)
    {
        OpenInBrowser("http://127.0.0.1:" + config.Port + "/?blank=1&n=" + DateTime.Now.Ticks);
    }

    /// <summary>菜单里的"打开文件…"：选一个 md，然后走同一条"交给服务"的路。</summary>
    static void PickAndOpen(Config config)
    {
        if (DialogBusy()) { Log("已经有一个对话框开着，忽略这次「打开文件」"); return; }
        BeginDialog();
        try
        {
            Log("弹出「打开文件」对话框…");
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "用 Markdown Observer 打开";
                dialog.Filter = "Markdown (*.md;*.markdown;*.mdown;*.mkd)|*.md;*.markdown;*.mdown;*.mkd|所有文件 (*.*)|*.*";
                DialogResult result = dialog.ShowDialog(trayHost);
                Log("对话框结果：" + result);
                if (result != DialogResult.OK) return;
                OpenFile(config, dialog.FileName);
            }
        }
        catch (Exception error)
        {
            Log("打开文件失败：" + error);
            Fail("打开文件时出错了：" + error.Message + "\r\n\r\n日志：" + LogPath);
        }
        finally
        {
            pickingDialog = false;
        }
    }

    /**
     * 菜单里的"打开文件夹…"：选一个文件夹，交给服务端扫描。
     * 服务端扫描会跳过 node_modules 这类目录（实测 7 万文件的仓库 0.1 秒），
     * 所以大文件夹也秒开——这是"网页里让浏览器自己读"做不到的。
     */
    static void PickFolder(Config config)
    {
        if (DialogBusy()) { Log("已经有一个对话框开着，忽略这次「打开文件夹」"); return; }
        BeginDialog();
        try
        {
            if (!ServiceAlive(config))
            {
                Fail("阅读器服务没在跑。先双击一个 .md 文件把它带起来，再用这个菜单。");
                return;
            }
            string picked = PickFolderModern(DialogOwner());
            if (picked == null) return;   // 用户取消
            string wire = ToWire(config, picked);
            Log("打开文件夹（新工作区）：" + wire);
            // keep=1：只把这个目录加进允许列表，**不动**别人正在看的根目录
            string body = HttpGet("http://127.0.0.1:" + config.Port + "/api/root?keep=1&path=" + Uri.EscapeDataString(wire), 20000);
            if (body == null) { Fail("没能让服务端打开这个文件夹（日志里有详情）。"); return; }
            Log("服务端的回答：" + body);
            // 再开一个**新页面**，它认这个文件夹当自己的工作区（各自一棵树、各自一份"打开的文档"）
            OpenInBrowser("http://127.0.0.1:" + config.Port + "/?root=" + Uri.EscapeDataString(wire) + "&n=" + DateTime.Now.Ticks);
        }
        catch (Exception error)
        {
            Log("打开文件夹失败：" + error);
            Fail("打开文件夹时出错了：" + error.Message + "\r\n\r\n日志：" + LogPath);
        }
        finally
        {
            pickingDialog = false;
        }
    }

    /// <summary>路径最后一段（给页面显示文件夹名用）。</summary>
    static string BaseName(string path)
    {
        string trimmed = path.TrimEnd('/');
        int slash = trimmed.LastIndexOf('/');
        return slash < 0 ? trimmed : trimmed.Substring(slash + 1);
    }

    /// <summary>把一个字符串裹成 JSON 字符串字面量（路径里可能有引号/反斜杠）。</summary>
    static string JsonString(string value)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    /// <summary>本机路径 → 服务端认的"正斜杠路径"。</summary>
    static string ToWire(Config config, string path)
    {
        string mapped = config.PathMap == "wsl" ? ToWslPath(path) : path;
        return mapped.Replace('\\', '/');
    }

    /// <summary>用系统默认浏览器打开一个地址。</summary>
    static void OpenInBrowser(string url)
    {
        try
        {
            // ShellExecute 直接开网址：不绕 cmd（cmd 会拿 % 当变量展开，URL 里的 %2F 有风险）
            ProcessStartInfo psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception error)
        {
            Log("开浏览器失败：" + error.Message);
            Fail("没能打开浏览器：" + error.Message);
        }
    }

    /// <summary>托盘图标：优先用 exe 自己的图标；没有就现画一个（保证托盘上看得见东西）。</summary>
    static System.Drawing.Icon LoadAppIcon()
    {
        // 第一选择：编在程序里的资源（跟 exe 放在哪儿无关，从 WSL 共享路径跑也没问题）
        try
        {
            using (Stream stream = typeof(Launcher).Assembly.GetManifestResourceStream("AppIcon"))
            {
                if (stream != null) return new System.Drawing.Icon(stream);
            }
        }
        catch
        {
            // 落到下面
        }
        try
        {
            System.Drawing.Icon own = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (own != null) return own;
        }
        catch
        {
            // 落到下面自己画
        }
        System.Drawing.Bitmap bitmap = new System.Drawing.Bitmap(32, 32);
        using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(bitmap))
        {
            g.Clear(System.Drawing.Color.FromArgb(86, 134, 254));
            using (System.Drawing.SolidBrush pen = new System.Drawing.SolidBrush(System.Drawing.Color.White))
            {
                g.FillRectangle(pen, 9, 6, 14, 20);
            }
        }
        return System.Drawing.Icon.FromHandle(bitmap.GetHicon());
    }

    // ─────────────────────────── 小工具 ───────────────────────────

    /// <summary>
    /// 挑一个"子进程当前目录"用的本地目录。两条硬性要求：
    ///   ① 不能是 UNC（\\server\share 或 \\wsl.localhost\...）——CreateProcess 直接不干；
    ///   ② **不能是安装目录**——Windows 里"进程的当前目录"会锁住那个目录，
    ///      于是服务还活着的时候卸载就会 EACCES 删不掉（这个坑踩过）。
    /// </summary>
    static string SafeWorkingDirectory()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (local.Length > 0 && !local.StartsWith("\\\\")) return local;
        string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (win.Length > 0 && !win.StartsWith("\\\\")) return win;
        return "C:\\";
    }

    /// <summary>把 Explorer 给的路径整理成绝对路径（可能是相对路径、可能带引号）。</summary>
    static string ResolveTarget(string raw)
    {
        string value = raw.Trim().Trim('"');
        try { return Path.GetFullPath(value); }
        catch { return value; }
    }

    /// <summary>Windows 路径 → WSL 路径。认三种：C:\... 、\\wsl.localhost\发行版\... 、\\wsl$\发行版\...</summary>
    static string ToWslPath(string winPath)
    {
        string p = winPath.Replace('/', '\\');

        string[] uncHeads = new string[] { "\\\\wsl.localhost\\", "\\\\wsl$\\" };
        foreach (string head in uncHeads)
        {
            if (p.StartsWith(head, StringComparison.OrdinalIgnoreCase))
            {
                string rest = p.Substring(head.Length);
                int slash = rest.IndexOf('\\');
                if (slash < 0) return "/";
                return rest.Substring(slash).Replace('\\', '/');
            }
        }

        if (p.Length >= 2 && p[1] == ':')
        {
            string drive = p.Substring(0, 1).ToLowerInvariant();
            return "/mnt/" + drive + p.Substring(2).Replace('\\', '/');
        }

        return winPath;
    }

    /// <summary>
    /// 把参数拼成命令行。只在必要时加引号（空参数、含空格或制表符）。
    /// 为什么不无脑全加引号：wsl.exe 对引号的处理和别的程序不一样——
    /// 实测把参数写成 "-l" 时它不认这是选项，会把它当成"要执行的命令"交给默认 shell。
    /// </summary>
    static string QuoteAll(string[] parts)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string part in parts)
        {
            string value = part ?? "";
            if (sb.Length > 0) sb.Append(' ');
            bool needQuote = value.Length == 0 || value.IndexOf(' ') >= 0 || value.IndexOf('\t') >= 0;
            if (needQuote) sb.Append('"').Append(value.Replace("\"", "\\\"")).Append('"');
            else sb.Append(value);
        }
        return sb.ToString();
    }

    /// <summary>发一个 GET 请求；失败（连不上、超时）返回 null。</summary>
    static string HttpGet(string url, int timeoutMs)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.Method = "GET";
            // 只连本机：绕开系统代理。不设这个的话，.NET 会自动探测代理（WPAD），
            // 在没有代理的机器上可能一卡就是几十秒——"双击没反应"的经典成因。
            request.Proxy = null;
            request.KeepAlive = false;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }
        catch
        {
            return null;
        }
    }

    static string BuildDiagnostics(string exeDir, string configPath)
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("Markdown Observer 总管自检");
        sb.AppendLine("程序位置：" + Application.ExecutablePath);
        sb.AppendLine("配置文件：" + configPath + (File.Exists(configPath) ? "（找到了）" : "（没有！）"));
        sb.AppendLine("日志位置：" + LogPath);
        if (File.Exists(configPath))
        {
            try
            {
                Config config = Config.Load(configPath);
                sb.AppendLine("要运行的程序：" + config.Command);
                sb.AppendLine("参数模板    ：" + string.Join(" | ", config.Args));
                sb.AppendLine("路径转换    ：" + config.PathMap);
                sb.AppendLine("端口        ：" + config.Port);
                sb.AppendLine("托盘        ：" + (config.Tray ? "要" : "不要"));
                sb.AppendLine("服务在跑吗  ：" + (ServiceAlive(config) ? "在" : "不在"));
                sb.AppendLine("托盘在跑吗  ：" + (TrayRunning() ? "在" : "不在"));
                string probe = Path.Combine(exeDir, "probe.md");
                sb.AppendLine();
                sb.AppendLine("举例：双击 C:\\notes\\a.md");
                sb.AppendLine("  → " + config.Command + " " + QuoteAll(config.BuildArgs(ToWslPath(probe))));
            }
            catch (Exception error)
            {
                sb.AppendLine("读配置失败：" + error.Message);
            }
        }
        return sb.ToString();
    }

    static void Log(string line)
    {
        try
        {
            File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + "\r\n", Encoding.UTF8);
        }
        catch { /* 日志写不了就算了，不能因此让功能挂掉 */ }
    }

    /// <summary>出错：写日志；除非配了 silent，否则弹一个看得懂的框。</summary>
    static void Fail(string message)
    {
        Log("FAIL " + message);
        if (SilentMode) return;
        MessageBox.Show(message, "Markdown Observer", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}

/// <summary>config.txt 里那几行配置。</summary>
class Config
{
    public string Command = "wsl.exe";
    public string[] Args = new string[] { };
    public string PathMap = "native";
    public int Port = 47821;
    public bool Tray = true;
    /// <summary>安静模式：出错只写日志，不弹提示框（给脚本/自动化测试用）。</summary>
    public bool Silent = false;
    /// <summary>诊断用：等子进程多久（毫秒），0 = 不等。平时不写。</summary>
    public int Wait = 0;
    /// <summary>诊断用：把子进程的输出写到这个文件。平时不写。</summary>
    public string Capture = null;

    public static Config Load(string path)
    {
        Config config = new Config();
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string key = line.Substring(0, eq).Trim().ToLowerInvariant();
            string value = line.Substring(eq + 1).Trim();
            if (key == "command") config.Command = value;
            else if (key == "pathmap") config.PathMap = value;
            else if (key == "port") config.Port = int.Parse(value, CultureInfo.InvariantCulture);
            else if (key == "tray") config.Tray = value == "on" || value == "true" || value == "1";
            else if (key == "silent") config.Silent = value == "true" || value == "1";
            else if (key == "wait") config.Wait = int.Parse(value, CultureInfo.InvariantCulture);
            else if (key == "capture") config.Capture = value;
            else if (key == "args")
            {
                string[] parts = value.Split('|');
                int n = 0;
                for (int i = 0; i < parts.Length; i++) if (parts[i].Length > 0) n++;
                string[] kept = new string[n];
                int k = 0;
                for (int i = 0; i < parts.Length; i++) if (parts[i].Length > 0) kept[k++] = parts[i];
                config.Args = kept;
            }
        }
        if (config.Args.Length == 0) throw new Exception("config.txt 里没有 args");
        if (config.PathMap != "wsl" && config.PathMap != "native") throw new Exception("config.txt 的 pathmap 只能是 wsl 或 native");
        return config;
    }

    /// <summary>把 {file} 换成真实路径，返回最终参数表。</summary>
    public string[] BuildArgs(string file)
    {
        string[] result = new string[Args.Length];
        for (int i = 0; i < Args.Length; i++) result[i] = Args[i].Replace("{file}", file);
        return result;
    }
}

/// <summary>
/// 一个极简的进度窗口：一行字 + 一条进度条。安装/卸载时让用户看见"正在做什么"。
/// 每走一步调一次 Step()，里面用 DoEvents 把界面刷出来（这几步都跑在 UI 线程上）。
/// </summary>
class ProgressForm : Form
{
    readonly Label caption = new Label();
    readonly SlimBar bar = new SlimBar();

    public ProgressForm(string title)
    {
        Text = "Markdown Observer";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        ControlBox = false;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new System.Drawing.Size(400, 150);
        BackColor = System.Drawing.Color.White;
        Font = new System.Drawing.Font("Microsoft YaHei UI", 9f);
        try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        Panel header = new Panel();
        header.Dock = DockStyle.Top;
        header.Height = 56;
        header.Paint += delegate(object sender, PaintEventArgs e)
        {
            using (System.Drawing.Drawing2D.LinearGradientBrush brush = new System.Drawing.Drawing2D.LinearGradientBrush(
                header.ClientRectangle, System.Drawing.Color.FromArgb(136, 198, 230), System.Drawing.Color.FromArgb(32, 107, 163), 0f))
            {
                e.Graphics.FillRectangle(brush, header.ClientRectangle);
            }
            using (System.Drawing.Font font = new System.Drawing.Font("Microsoft YaHei UI", 11f, System.Drawing.FontStyle.Bold))
            using (System.Drawing.SolidBrush white = new System.Drawing.SolidBrush(System.Drawing.Color.White))
            {
                e.Graphics.DrawString("Markdown Observer", font, white, 18, 16);
            }
        };
        Controls.Add(header);

        caption.Text = title;
        caption.AutoSize = true;
        caption.ForeColor = System.Drawing.Color.FromArgb(28, 32, 40);
        caption.Location = new System.Drawing.Point(22, 74);
        Controls.Add(caption);

        bar.Location = new System.Drawing.Point(24, 104);
        bar.Width = 352;
        Controls.Add(bar);
    }

    /// <summary>报一步。value = 已经做到第几步。</summary>
    public void Step(string text, int value)
    {
        caption.Text = text;
        bar.Set(value, 3);
        Refresh();
        Application.DoEvents();
    }
}

/// <summary>自己画的细进度条（原生 ProgressBar 染不上色）。</summary>
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
        e.Graphics.Clear(System.Drawing.Color.FromArgb(232, 236, 242));
        int width = (int)(Width * Math.Min(1.0, (double)value / max));
        if (width <= 0) return;
        using (System.Drawing.SolidBrush brush = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(32, 107, 163)))
        {
            e.Graphics.FillRectangle(brush, 0, 0, width, Height);
        }
    }
}
