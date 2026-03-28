const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

class IntelliconClient {
  constructor() {
    this.baseUrl = process.env.INTELLICON_BASE_URL || 'https://diamondgroup.contegris.com';
    this.email = process.env.INTELLICON_EMAIL;
    this.password = process.env.INTELLICON_PASSWORD;
    this.cookieJar = new tough.CookieJar();
    this.loggedIn = false;
    this.ws = null;

    this.client = wrapper(axios.create({
      baseURL: this.baseUrl,
      jar: this.cookieJar,
      withCredentials: true,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json'
      }
    }));
  }

  async login() {
    const endpoints = [
      '/apis/auth/login',
      '/cx9/api/auth/login',
      '/api/auth/login',
      '/auth/login',
    ];

    const payload = { email: this.email, password: this.password };

    for (const endpoint of endpoints) {
      try {
        console.log(`[Intellicon] Trying login at ${endpoint}...`);
        const res = await this.client.post(endpoint, payload);

        if (res.status === 200 || res.status === 201) {
          // Some APIs return token in body
          if (res.data?.token) {
            this.client.defaults.headers['Authorization'] = `Bearer ${res.data.token}`;
          }
          this.loggedIn = true;
          console.log(`[Intellicon] Login successful via ${endpoint}`);
          return { success: true, endpoint };
        }
      } catch (err) {
        const status = err.response?.status;
        console.log(`[Intellicon] Login at ${endpoint} failed: ${status || err.message}`);
        if (status === 401 || status === 403) {
          // Wrong credentials — stop trying
          return { success: false, error: 'Invalid credentials' };
        }
        // Otherwise try next endpoint
      }
    }

    return { success: false, error: 'Could not reach any login endpoint' };
  }

  async fetchCallPage(pageNumber, days = 7) {
    const filter = JSON.stringify({
      answered: true,
      dashboard: true,
      pageNumber
    });

    const endpoints = [
      `/apis/report/call_center?filter=${encodeURIComponent(filter)}&offset=0`,
      `/cx9/api/report/call_center?filter=${encodeURIComponent(filter)}&offset=0`,
      `/api/report/call_center?filter=${encodeURIComponent(filter)}&offset=0`,
    ];

    for (const endpoint of endpoints) {
      try {
        const res = await this.client.get(endpoint);
        const data = res.data;

        // Handle different response shapes
        const calls = Array.isArray(data)
          ? data
          : (data?.data || data?.calls || data?.interactions || data?.records || []);

        console.log(`[Intellicon] Page ${pageNumber}: got ${calls.length} calls`);
        return calls;
      } catch (err) {
        const status = err.response?.status;
        if (status === 401) {
          console.log('[Intellicon] Session expired, re-logging in...');
          await this.login();
          continue;
        }
        console.log(`[Intellicon] fetchCallPage ${pageNumber} at ${endpoint} failed: ${err.message}`);
      }
    }

    return [];
  }

  async fetchAllCalls(days = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const allCalls = [];
    let page = 1;

    while (true) {
      const calls = await this.fetchCallPage(page);
      if (!calls || calls.length === 0) break;

      // Filter to last N days
      const recent = calls.filter(c => {
        const d = new Date(c.createdAt || c.created_at || c.startTime || 0);
        return d >= cutoff;
      });

      allCalls.push(...recent);

      // If all calls were filtered out (older than cutoff), stop paginating
      if (recent.length < calls.length && calls.length > 0) break;

      page++;
      if (page > 50) break; // Safety cap
    }

    console.log(`[Intellicon] Fetched total ${allCalls.length} calls from last ${days} days`);
    return allCalls;
  }

  async downloadRecording(call, uploadsDir) {
    const interactionId = call.interactionId || call.interaction_id || call.id;
    if (!interactionId) return null;

    const date = new Date(call.createdAt || call.created_at || call.startTime);
    if (isNaN(date.getTime())) return null;

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const direction = (call.direction || 'inbound').toLowerCase();
    const cli = call.cli || call.did || call.callerNumber || '';
    const destPath = path.join(uploadsDir, `${interactionId}.mp3`);

    // Skip if already downloaded
    if (fs.existsSync(destPath)) {
      console.log(`[Intellicon] Recording already exists for ${interactionId}`);
      return destPath;
    }

    console.log(`[Intellicon] Downloading recording for ${interactionId}...`);

    const urlPatterns = [
      `/intellicon/sounds/recording/${yyyy}/${mm}/${dd}/${direction}-${cli}-${interactionId}.mp3`,
      `/intellicon/sounds/recording/${yyyy}/${mm}/${dd}/${interactionId}.mp3`,
      `/sounds/recording/${yyyy}/${mm}/${dd}/${direction}-${cli}-${interactionId}.mp3`,
      `/recordings/${interactionId}.mp3`,
      `/api/recordings/${interactionId}`,
    ];

    for (const urlPattern of urlPatterns) {
      try {
        const res = await this.client.get(urlPattern, { responseType: 'stream' });
        if (res.status === 200) {
          await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(destPath);
            res.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
          console.log(`[Intellicon] Downloaded recording to ${destPath}`);
          return destPath;
        }
      } catch (err) {
        if (err.response?.status === 404) continue;
        console.log(`[Intellicon] Download attempt failed (${urlPattern}): ${err.message}`);
      }
    }

    // Try listing directory to find file by interactionId
    try {
      const listUrl = `/intellicon/sounds/recording/${yyyy}/${mm}/${dd}/`;
      const res = await this.client.get(listUrl);
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const match = html.match(new RegExp(`[\\w-]*${interactionId}[\\w-]*\\.mp3`));
      if (match) {
        const filename = match[0];
        const fileUrl = `${listUrl}${filename}`;
        const fileRes = await this.client.get(fileUrl, { responseType: 'stream' });
        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(destPath);
          fileRes.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        console.log(`[Intellicon] Downloaded via directory listing to ${destPath}`);
        return destPath;
      }
    } catch (_) {}

    console.log(`[Intellicon] Could not download recording for ${interactionId}`);
    return null;
  }

  connectWebSocket(onCallComplete) {
    const wsUrls = [
      `${this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/socket.io/?EIO=4&transport=websocket`,
      `${this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/ws`,
      `${this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/cx9/socket`,
    ];

    // Get cookies for WebSocket handshake
    let cookieString = '';
    try {
      const cookies = this.cookieJar.getCookiesSync(this.baseUrl);
      cookieString = cookies.map(c => `${c.key}=${c.value}`).join('; ');
    } catch (_) {}

    const tryConnect = (urlIndex = 0) => {
      if (urlIndex >= wsUrls.length) {
        console.log('[Intellicon] WebSocket: all URL attempts failed, retrying in 30s...');
        setTimeout(() => tryConnect(0), 30000);
        return;
      }

      const wsUrl = wsUrls[urlIndex];
      console.log(`[Intellicon] WebSocket connecting to ${wsUrl}...`);

      const ws = new WebSocket(wsUrl, {
        headers: {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Origin': this.baseUrl,
        },
        rejectUnauthorized: false
      });

      ws.on('open', () => {
        console.log(`[Intellicon] WebSocket connected to ${wsUrl}`);
        this.ws = ws;
        // Socket.IO handshake: send "40" to connect to default namespace
        try { ws.send('40'); } catch (_) {}
      });

      ws.on('message', (data) => {
        const msg = data.toString();

        // Socket.IO ping/pong
        if (msg === '2') { try { ws.send('3'); } catch (_) {} return; }

        // Parse Socket.IO event: 42["event",{data}]
        const siMatch = msg.match(/^42\["([^"]+)",(.*)\]$/s);
        if (siMatch) {
          const [, eventName, payloadStr] = siMatch;
          try {
            const payload = JSON.parse(payloadStr);
            const callEndEvents = ['call-ended', 'interaction-complete', 'AgentACW', 'call-complete', 'HANGUP', 'callEnd'];
            if (callEndEvents.includes(eventName)) {
              console.log(`[Intellicon] Real-time event: ${eventName}`);
              onCallComplete(payload);
            }
          } catch (_) {}
          return;
        }

        // Plain JSON event
        try {
          const parsed = JSON.parse(msg);
          const eventType = parsed.type || parsed.event || parsed.eventType || '';
          const callEndEvents = ['call-ended', 'interaction-complete', 'AgentACW', 'call-complete', 'HANGUP', 'callEnd'];
          if (callEndEvents.includes(eventType)) {
            console.log(`[Intellicon] Real-time event: ${eventType}`);
            onCallComplete(parsed);
          }
        } catch (_) {}
      });

      ws.on('error', (err) => {
        console.log(`[Intellicon] WebSocket error on ${wsUrl}: ${err.message}`);
      });

      ws.on('close', (code) => {
        console.log(`[Intellicon] WebSocket closed (code ${code}), trying next URL in 5s...`);
        this.ws = null;
        // Try next URL or loop back
        setTimeout(() => tryConnect(urlIndex + 1 < wsUrls.length ? urlIndex + 1 : 0), 5000);
      });
    };

    tryConnect();
  }

  isWsConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

module.exports = IntelliconClient;
