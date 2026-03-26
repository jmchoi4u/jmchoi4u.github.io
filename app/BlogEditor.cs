using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

class BlogEditor
{
    static Process serverProcess;

    static void Main()
    {
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        // Navigate up if exe is in app/ subfolder, or use current dir
        string serverScript = Path.Combine(appDir, "server.mjs");
        if (!File.Exists(serverScript))
        {
            // Try looking in app/ relative to exe location
            serverScript = Path.Combine(appDir, "app", "server.mjs");
            if (!File.Exists(serverScript))
            {
                Console.WriteLine("[ERROR] server.mjs not found.");
                Console.ReadKey();
                return;
            }
            appDir = Path.Combine(appDir, "app");
        }

        // Check Node.js
        try
        {
            var check = Process.Start(new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "--version",
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            });
            check.WaitForExit();
        }
        catch
        {
            Console.WriteLine("[ERROR] Node.js is not installed or not in PATH.");
            Console.ReadKey();
            return;
        }

        Console.Title = "JM Blog Editor";
        Console.WriteLine("Starting blog editor server...");

        // Start node server
        serverProcess = new Process();
        serverProcess.StartInfo = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = "server.mjs",
            WorkingDirectory = appDir,
            UseShellExecute = false
        };

        // Handle Ctrl+C gracefully
        Console.CancelKeyPress += (s, e) =>
        {
            e.Cancel = true;
            Shutdown();
        };

        AppDomain.CurrentDomain.ProcessExit += (s, e) => Shutdown();

        serverProcess.Start();

        Console.WriteLine("Blog editor running at http://127.0.0.1:4317");
        Console.WriteLine("Press Ctrl+C or close this window to stop.");

        serverProcess.WaitForExit();
    }

    static void Shutdown()
    {
        if (serverProcess != null && !serverProcess.HasExited)
        {
            try
            {
                serverProcess.Kill();
                serverProcess.WaitForExit(3000);
            }
            catch { }
        }
    }
}
