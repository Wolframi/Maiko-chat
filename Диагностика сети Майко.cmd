@echo off
setlocal
chcp 65001 >nul
set "MAIKO_DIAGNOSTICS_FILE=%~f0"
echo Проверяем доступ к Майко. Дождитесь завершения проверки.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $lines = Get-Content -LiteralPath $env:MAIKO_DIAGNOSTICS_FILE -Encoding UTF8; $marker = [Array]::IndexOf($lines, '# MAIKO_POWERSHELL_BEGIN'); if ($marker -lt 0) { throw 'Embedded diagnostic script is missing' }; $script = [ScriptBlock]::Create(($lines[($marker + 1)..($lines.Length - 1)] -join [Environment]::NewLine)); $reportPath = Join-Path ([IO.Path]::GetDirectoryName($env:MAIKO_DIAGNOSTICS_FILE)) 'Maiko-network-report.txt'; & $script -OutputPath $reportPath } catch { Write-Host $_; exit 1 }"
set "MAIKO_DIAGNOSTICS_EXIT=%errorlevel%"
if defined MAIKO_DIAGNOSTICS_NO_PAUSE goto maiko_done
echo.
pause
:maiko_done
exit /b %MAIKO_DIAGNOSTICS_EXIT%
# MAIKO_POWERSHELL_BEGIN
param(
    [string]$InterfaceAlias,
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\output\network-diagnostics.txt')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$domain = 'maiko.galacticvps.qzz.io'
$serverAddress = '179.254.175.134'
$report = New-Object System.Collections.Generic.List[string]
function Write-Report([string]$Text) {
    $report.Add($Text)
    Write-Host $Text
}

# Windows IP_UNICAST_IF selects the physical interface for this socket only.
# Binding the source address alone does not guarantee that a TUN VPN is bypassed.
# No routes, VPN settings, DNS settings or certificate checks are changed.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text;

public static class MaikoDirectNetwork {
    public static string Request(string address, string host, string path,
        int index, string source, bool tls12, bool websocket) {
        var timer = Stopwatch.StartNew();
        string phase = "TCP:443";
        using (var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)) {
            try {
                socket.SendTimeout = socket.ReceiveTimeout = 10000;
                socket.SetSocketOption(SocketOptionLevel.IP, (SocketOptionName)31,
                    IPAddress.HostToNetworkOrder(index));
                socket.Bind(new IPEndPoint(IPAddress.Parse(source), 0));
                var connect = socket.BeginConnect(IPAddress.Parse(address), 443, null, null);
                try {
                    if (!connect.AsyncWaitHandle.WaitOne(10000)) throw new TimeoutException("TCP connection timed out");
                    socket.EndConnect(connect);
                } finally { connect.AsyncWaitHandle.Close(); }
                phase = "TLS (certificate validation enabled)";
                using (var tls = new SslStream(new NetworkStream(socket, false), false)) {
                    tls.ReadTimeout = tls.WriteTimeout = 10000;
                    var auth = tls.AuthenticateAsClientAsync(host, null,
                        tls12 ? SslProtocols.Tls12 : SslProtocols.None, true);
                    if (!auth.Wait(10000)) throw new TimeoutException("TLS handshake timed out");
                    phase = "HTTPS";
                    string upgrade = websocket
                        ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + Convert.ToBase64String(Guid.NewGuid().ToByteArray()) + "\r\n"
                        : "Connection: close\r\n";
                    string accept = path.StartsWith("/dns-query?") ? "Accept: application/dns-json\r\n" : "";
                    var data = Encoding.ASCII.GetBytes("GET " + path + " HTTP/1.1\r\nHost: " + host
                        + "\r\nUser-Agent: MaikoNetworkDiagnostics/1.0\r\nAccept-Encoding: identity\r\n" + accept + upgrade + "\r\n");
                    tls.Write(data, 0, data.Length);
                    using (var reader = new StreamReader(tls, Encoding.UTF8)) {
                        string status = reader.ReadLine();
                        string line;
                        int headers = 0;
                        while (!String.IsNullOrEmpty(line = reader.ReadLine())) {
                            if (++headers > 200) throw new IOException("Too many response headers");
                        }
                        if (status == null) throw new IOException("Empty HTTP response");
                        if (websocket) return status + "; " + tls.SslProtocol + "; " + timer.ElapsedMilliseconds + " ms";
                        // Read the entire page, not just the TLS handshake or headers.
                        // This also detects transfers that stall after the first packet.
                        var body = new StringBuilder();
                        var buffer = new char[4096];
                        int count;
                        while ((count = reader.Read(buffer, 0, buffer.Length)) > 0) {
                            body.Append(buffer, 0, count);
                            if (body.Length > 2000000) throw new IOException("Response exceeds diagnostic size limit");
                        }
                        string preview = path == "/" ? "HTML received" : body.ToString();
                        int previewLimit = path.StartsWith("/dns-query?") ? 1000 : 260;
                        if (preview.Length > previewLimit) preview = preview.Substring(0, previewLimit);
                        return status + "; " + tls.SslProtocol + "; " + timer.ElapsedMilliseconds
                            + " ms; chars=" + body.Length + "; " + preview.Replace("\n", " ").Replace("\r", " ");
                    }
                }
            } catch (Exception e) {
                return "FAIL at " + phase + ": " + e.GetBaseException().Message + "; " + timer.ElapsedMilliseconds + " ms";
            }
        }
    }
}
'@

try {
    Write-Report ('Maiko network diagnostics: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
    Write-Report ('Target: https://' + $domain + '; known server IPv4: ' + $serverAddress)
    Write-Report 'HTTPS tests below bypass VPN routing through the selected physical adapter. Certificates are validated.'
    $physical = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up')
    $candidates = @(Get-NetIPConfiguration | Where-Object {
        $_.IPv4DefaultGateway -and $_.IPv4Address -and
        ($physical.ifIndex -contains $_.InterfaceIndex) -and
        (!$InterfaceAlias -or $_.InterfaceAlias -eq $InterfaceAlias)
    } | Sort-Object { $_.NetIPv4Interface.InterfaceMetric })
    if (!$candidates.Count) { throw 'No active physical adapter with an IPv4 gateway. Connect Wi-Fi/Ethernet or supply -InterfaceAlias.' }
    $adapter = $candidates[0]
    $sourceAddress = @($adapter.IPv4Address)[0].IPAddress
    Write-Report ('Physical adapter: ' + $adapter.InterfaceAlias + '; index=' + $adapter.InterfaceIndex + '; source=' + $sourceAddress)
    if ($candidates.Count -gt 1) { Write-Report 'Multiple physical adapters found. To choose Wi-Fi explicitly, rerun with -InterfaceAlias Wi-Fi.' }
    $route = Find-NetRoute -RemoteIPAddress $serverAddress
    Write-Report ('Normal Windows route: ' + (($route | Where-Object InterfaceAlias | Select-Object -ExpandProperty InterfaceAlias -Unique) -join ', '))

    Write-Report ''
    Write-Report 'SYSTEM DNS (uses existing system configuration; may use VPN DNS):'
    $resolved = @()
    try {
        $resolved = @(Resolve-DnsName $domain -Type A -DnsOnly -QuickTimeout | Where-Object Type -eq 'A' | Select-Object -ExpandProperty IPAddress -Unique)
        Write-Report ('A records: ' + ($resolved -join ', '))
        if ($resolved -notcontains $serverAddress) { Write-Report 'WARNING: system DNS does not return the known server IPv4.' }
    } catch { Write-Report ('DNS FAIL: ' + $_.Exception.GetBaseException().Message) }
    Write-Report 'INDEPENDENT DNS over HTTPS, also through the physical adapter:'
    Write-Report ([MaikoDirectNetwork]::Request('1.1.1.1', 'cloudflare-dns.com', ('/dns-query?name=' + $domain + '&type=A'), $adapter.InterfaceIndex, $sourceAddress, $false, $false))

    foreach ($address in @(@($serverAddress) + $resolved | Select-Object -Unique)) {
        Write-Report ''
        Write-Report ('DIRECT HTTPS to ' + $address + ' with the original hostname and certificate validation:')
        foreach ($requestPath in @('/api/health', '/', '/api/socket/?EIO=4&transport=polling')) {
            Write-Report ($requestPath + ': ' + [MaikoDirectNetwork]::Request($address, $domain, $requestPath, $adapter.InterfaceIndex, $sourceAddress, $false, $false))
        }
        Write-Report ('WebSocket: ' + [MaikoDirectNetwork]::Request($address, $domain, '/api/socket/?EIO=4&transport=websocket', $adapter.InterfaceIndex, $sourceAddress, $false, $true))
        Write-Report ('TLS 1.2 compatibility: ' + [MaikoDirectNetwork]::Request($address, $domain, '/api/health', $adapter.InterfaceIndex, $sourceAddress, $true, $false))
    }
    Write-Report ''
    Write-Report 'Interpretation:'
    Write-Report 'Known IP works + DNS fails/returns another IP: investigate DNS/router filtering.'
    Write-Report 'FAIL at TCP:443: server IP/port is unreachable on this network; DNS changes cannot fix that.'
    Write-Report 'TCP succeeds + FAIL at TLS: investigate TLS filtering, certificate error, device clock or path MTU.'
    Write-Report 'HTTP 200 works + WebSocket is not 101: network may block WebSockets; chat already supports HTTP polling.'
    Write-Report 'Ping packet loss alone does not prove HTTPS is blocked.'
} catch {
    Write-Report ('Diagnostic error: ' + $_.Exception.GetBaseException().Message)
} finally {
    $destination = [System.IO.Path]::GetFullPath($OutputPath)
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    $report | Set-Content -Encoding UTF8 -LiteralPath $destination
    Write-Host ('Report saved: ' + $destination)
}
