// Finds the addresses a phone can use to reach this computer.
const os = require('os');

function lanUrls(port) {
  const urls = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address;
      if (ip.startsWith('169.254.')) continue; // no network on that adapter
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /tailscale/i.test(name);
      const home = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
      if (!tailscale && !home) continue;
      urls.push({ url: `http://${ip}:${port}`, label: tailscale ? 'Tailscale (works away from home)' : 'Home Wi-Fi', tailscale });
    }
  }
  // Home Wi-Fi addresses first, and 192.168.x.x before the less common ranges.
  return urls.sort((a, b) => a.tailscale - b.tailscale || b.url.includes('192.168.') - a.url.includes('192.168.'));
}

module.exports = { lanUrls };
