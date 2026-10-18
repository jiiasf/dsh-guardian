using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

class FakeDsh
{
    static void Main(string[] args)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;

        // Child role: its command line contains dsh-desktop-host\lib\index.js, so the
        // guardian classifies it as the Agent host. It only needs to stay alive.
        if (args.Length > 0 && args[0].IndexOf("dsh-desktop-host", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Thread.Sleep(Timeout.Infinite);
            return;
        }

        string failFlag = Path.Combine(baseDir, "fail.flag");
        string crashFlag = Path.Combine(baseDir, "crash.flag");

        bool fail = File.Exists(failFlag);
        if (fail) File.Delete(failFlag);
        bool crash = File.Exists(crashFlag);
        if (crash) File.Delete(crashFlag);

        // Simulates a plugin that prevents the app from starting.
        if (fail)
        {
            Thread.Sleep(2000);
            Environment.Exit(3);
            return;
        }

        TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;

        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        ProcessStartInfo psi = new ProcessStartInfo(self, "dsh-desktop-host\\lib\\index.js " + port.ToString());
        psi.UseShellExecute = false;
        Process child = Process.Start(psi);

        Thread server = new Thread(delegate()
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = listener.AcceptTcpClient();
                }
                catch
                {
                    break;
                }
                try
                {
                    NetworkStream stream = client.GetStream();
                    stream.ReadTimeout = 2000;
                    byte[] request = new byte[8192];
                    int total = 0;
                    while (total < request.Length)
                    {
                        int read = stream.Read(request, total, request.Length - total);
                        if (read <= 0) break;
                        total += read;
                        if (total >= 4 && Encoding.ASCII.GetString(request, 0, total).IndexOf("\r\n\r\n") >= 0) break;
                    }
                    byte[] response = Encoding.ASCII.GetBytes(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    stream.Write(response, 0, response.Length);
                    stream.Flush();
                }
                catch
                {
                    // Keep serving: a single aborted client must not stop the app.
                }
                finally
                {
                    try { client.Close(); } catch { }
                }
            }
        });
        server.IsBackground = true;
        server.Start();

        // Simulates a plugin that crashes a healthy app after loading.
        if (crash)
        {
            Thread.Sleep(5000);
            Environment.Exit(4);
        }

        Thread.Sleep(Timeout.Infinite);
    }
}
