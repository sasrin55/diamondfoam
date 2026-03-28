const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

class IntelliconClient {
  constructor() {
    this.baseUrl = (process.env.INTELLICON_BASE_URL || 'https://diamondgroup.contegris.com').replace(/\/$/, '');
    this.email = process.env.INTELLICON_EMAIL;
    this.password = process.env.INTELLICON_PASSWORD;
    this.cookieJar = new tough.CookieJar();
    this.loggedIn = false;
    this.ws = null;
    this.lastLoginEndpoint = null;

    this.client = wrapper(axios.create({
      baseURL: this.baseUrl,
      jar: this.cookieJar,
      withCredentials: true,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Referer': this.baseUrl + '/',
      }
    }));
  }

  async login() {
    // Try every combination of endpoint + payload format
    const attempts = [
      // /intellicon/ prefix — confirmed from login page URL
      { endpoint: '/intellicon/apis/auth/login',    payload: { email: this.email, password: this.password } },
      { endpoint: '/intellicon/apis/auth/login',    payload: { username: this.email, password: this.password } },
      { endpoint: '/intellicon/api/auth/login',     payload: { email: this.email, password: this.password } },
      { endpoint: '/intellicon/api/auth/login',     payload: { username: this.email, password: this.password } },
      { endpoint: '/intellicon/auth/login',         payload: { email: this.email, password: this.password } },
      { endpoint: '/intellicon/auth/login',         payload: { username: this.email, password: this.password } },
      // Without prefix — fallback
      { endpoint: '/apis/auth/login',               payload: { email: this.email, password: this.password } },
      { endpoint: '/api/auth/login',                payload: { email: this.email, password: this.password } },
    ];

    const details = [];

    for (const { endpoint, payload } of attempts) {
      try {
        console.log(`[Intellicon] Trying POST ${endpoint} with payload keys: ${Object.keys(payload).join(',')}`);
        const res = await this.client.post(endpoint, payload);

        const cookies = await this.cookieJar.getCookies(this.baseUrl);
        console.log(`[Intellicon] ${endpoint} -> status ${res.status}, cookies: [${cookies.map(c => c.key).join(', ')}]`);
        console.log(`[Intellicon] Response body keys: ${Object.keys(res.data || {}).join(', ')}`);
        console.log(`[Intellicon] Response body: ${JSON.stringify(res.data).slice(0, 300)}`);

        if (res.status >= 200 && res.status < 300) {
          if (res.data?.token)       this.client.defaults.headers['Authorization'] = `Bearer ${res.data.token}`;
          if (res.data?.accessToken) this.client.defaults.headers['Authorization'] = `Bearer ${res.data.accessToken}`;
          if (res.data?.data?.token) this.client.defaults.headers['Authorization'] = `Bearer ${res.data.data.token}`;
          this.loggedIn = true;
          this.lastLoginEndpoint = endpoint;
          return {
            success: true, endpoint,
            payloadUsed: Object.keys(payload),
            responseKeys: Object.keys(res.data || {}),
            cookies: cookies.map(c => c.key)
          };
        }

        details.push({ endpoint, payload: Object.keys(payload), status: res.status });
      } catch (err) {
        const status = err.response?.status;
        const body = err.response?.data;
        const errMsg = `${status || err.code || err.message}`;
        console.log(`[Intellicon] ${endpoint} failed: ${errMsg} | body: ${JSON.stringify(body || '').slice(0, 200)}`);
        details.push({ endpoint, payload: Object.keys(payload), status, error: errMsg, body: JSON.stringify(body || '').slice(0, 150) });

        // 401/403 with credentials error = wrong password, stop immediately
        if ((status === 401 || status === 403) && body && (JSON.stringify(body).toLowerCase().includes('password') || JSON.stringify(body).toLowerCase().includes('invalid'))) {
          return { success: false, error: 'Invalid credentials', details };
        }
      }
    }

    return { success: false, error: 'Could not authenticate with any endpoint', details };
  }

  // Raw call to the exact confirmed endpoint — tries multiple filter encoding strategies
  async fetchCallPage(pageNumber) {
    const filterObj = { answered: true, dashboard: true, pageNumber };
    const filterJson = JSON.stringify(filterObj);

    // Strategy 1: Raw JSON string in URL (as confirmed by user)
    const strategies = [
      // With /intellicon/ prefix — confirmed from login URL
      `/intellicon/apis/report/call_center?filter=${filterJson}&offset=0`,
      `/intellicon/apis/report/call_center?filter=${encodeURIComponent(filterJson)}&offset=0`,
      // Without prefix — fallback
      `/apis/report/call_center?filter=${filterJson}&offset=0`,
      `/apis/report/call_center?filter=${encodeURIComponent(filterJson)}&offset=0`,
      null, // axios params
    ];

    for (let i = 0; i < strategies.length; i++) {
      try {
        let res;
        if (i === 4) {
          res = await this.client.get('/intellicon/apis/report/call_center', {
            params: { filter: filterJson, offset: 0 }
          });
        } else {
          res = await this.client.get(strategies[i]);
        }

        console.log(`[Intellicon] fetchCallPage strategy ${i + 1} status: ${res.status}`);
        console.log(`[Intellicon] Response type: ${typeof res.data}, isArray: ${Array.isArray(res.data)}`);

        if (typeof res.data === 'object' && !Array.isArray(res.data)) {
          console.log(`[Intellicon] Response keys: ${Object.keys(res.data).join(', ')}`);
        }

        const calls = this._extractCalls(res.data);
        console.log(`[Intellicon] Page ${pageNumber} strategy ${i + 1}: extracted ${calls.length} calls`);

        if (calls.length > 0 || (Array.isArray(res.data) && res.data.length === 0)) {
          return { calls, rawSample: JSON.stringify(calls[0] || res.data).slice(0, 500) };
        }

        // If we got data but couldn't extract calls, log the shape and continue to next strategy
        console.log(`[Intellicon] Raw response sample: ${JSON.stringify(res.data).slice(0, 500)}`);

      } catch (err) {
        const status = err.response?.status;
        console.log(`[Intellicon] Page ${pageNumber} strategy ${i + 1} failed: ${status || err.message}`);
        if (err.response?.data) {
          console.log(`[Intellicon] Error body: ${JSON.stringify(err.response.data).slice(0, 300)}`);
        }
        if (status === 401) {
          console.log('[Intellicon] Session expired, re-logging in...');
          await this.login();
        }
      }
    }

    return { calls: [], rawSample: null };
  }

  _extractCalls(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];

    // Try common wrapper keys
    const keys = ['data', 'calls', 'interactions', 'records', 'results', 'items', 'rows', 'list'];
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key];
    }

    // Try nested: data.data
    if (data.data && typeof data.data === 'object') {
      for (const key of keys) {
        if (Array.isArray(data.data[key])) return data.data[key];
      }
    }

    return [];
  }

  async fetchAllCalls(days = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const allCalls = [];
    let page = 1;
    let firstRawSample = null;

    while (true) {
      const { calls, rawSample } = await this.fetchCallPage(page);
      if (!firstRawSample && rawSample) firstRawSample = rawSample;

      if (!calls || calls.length === 0) {
        console.log(`[Intellicon] Page ${page} returned 0 calls, stopping pagination`);
        break;
      }

      const recent = calls.filter(c => {
        const dateStr = c.createdAt || c.created_at || c.startTime || c.start_time || c.date || c.callDate;
        if (!dateStr) return true; // include if no date field
        const d = new Date(dateStr);
        return isNaN(d.getTime()) || d >= cutoff;
      });

      allCalls.push(...recent);
      console.log(`[Intellicon] Page ${page}: ${calls.length} total, ${recent.length} within ${days} days`);

      if (recent.length < calls.length) break; // Older pages, stop
      page++;
      if (page > 50) break;
    }

    console.log(`[Intellicon] Total fetched: ${allCalls.length} calls`);
    return { calls: allCalls, firstRawSample };
  }

  // Full test — login + one page fetch — returns everything for debugging
  async testConnection() {
    const result = {
      baseUrl: this.baseUrl,
      email: this.email ? this.email.replace(/(.{2}).*(@.*)/, '$1***$2') : 'NOT SET',
      loginResult: null,
      callPageResult: null,
      error: null
    };

    try {
      result.loginResult = await this.login();

      if (result.loginResult.success) {
        const { calls, rawSample } = await this.fetchCallPage(1);
        result.callPageResult = {
          callsExtracted: calls.length,
          firstCallKeys: calls[0] ? Object.keys(calls[0]) : [],
          rawSample
        };
      }
    } catch (err) {
      result.error = err.message;
    }

    return result;
  }

  normalizeCall(raw) {
    // Map Intellicon's field names to our schema
    // Log first-time field mapping so we can verify
    const interactionId = raw.interactionId || raw.interaction_id || raw.id || raw._id || raw.callId || raw.call_id;
    const agentName = raw.agentName || raw.agent_name || raw.agentFullName || raw.agent || raw.operatorName || raw.employeeName;
    const direction = raw.direction || raw.callDirection || raw.type;
    const cli = raw.cli || raw.callerNumber || raw.caller || raw.from || raw.ani || raw.callerID;
    const did = raw.did || raw.dialedNumber || raw.to || raw.dnis || raw.destination;
    const duration = parseInt(raw.duration || raw.totalDuration || raw.billDuration || raw.talkTime || raw.call_duration || 0);
    const recordedAt = raw.createdAt || raw.created_at || raw.startTime || raw.start_time || raw.callDate || raw.date;
    const queueName = raw.queueName || raw.queue_name || raw.queue || raw.campaign;

    return {
      interaction_id: String(interactionId),
      employee_name: agentName || null,
      agent_id: raw.agentId || raw.agent_id || null,
      distributor_name: null,
      cli: cli || null,
      did: did || null,
      direction: this._normalizeDirection(direction),
      queue_name: queueName || null,
      duration_seconds: duration,
      recorded_at: recordedAt ? new Date(recordedAt).toISOString() : new Date().toISOString(),
      sync_status: 'synced'
    };
  }

  _normalizeDirection(dir) {
    if (!dir) return 'Inbound';
    const d = String(dir).toLowerCase();
    if (d.includes('out')) return 'Outbound';
    if (d.includes('miss')) return 'Missed';
    return 'Inbound';
  }

  async downloadRecording(call, uploadsDir) {
    const interactionId = call.interactionId || call.interaction_id || call.id;
    if (!interactionId) return null;

    const dateStr = call.createdAt || call.created_at || call.startTime;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const direction = (call.direction || 'inbound').toLowerCase();
    const cli = call.cli || call.callerNumber || call.from || '';
    const destPath = path.join(uploadsDir, `${interactionId}.mp3`);

    if (fs.existsSync(destPath)) return destPath;

    console.log(`[Intellicon] Downloading recording for ${interactionId}...`);

    const urlPatterns = [
      `/intellicon/sounds/recording/${yyyy}/${mm}/${dd}/${direction}-${cli}-${interactionId}.mp3`,
      `/intellicon/sounds/recording/${yyyy}/${mm}/${dd}/${interactionId}.mp3`,
      `/sounds/recording/${yyyy}/${mm}/${dd}/${direction}-${cli}-${interactionId}.mp3`,
      `/recordings/${yyyy}/${mm}/${dd}/${interactionId}.mp3`,
      `/recordings/${interactionId}.mp3`,
      `/api/recordings/${interactionId}`,
    ];

    for (const urlPattern of urlPatterns) {
      try {
        const res = await this.client.get(urlPattern, { responseType: 'stream', timeout: 60000 });
        if (res.status === 200) {
          await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(destPath);
            res.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
          console.log(`[Intellicon] Saved recording: ${destPath}`);
          return destPath;
        }
      } catch (err) {
        if (err.response?.status === 404) continue;
        console.log(`[Intellicon] Recording download failed (${urlPattern}): ${err.message}`);
      }
    }

    // Try directory listing
    try {
      const listUrl = `/intellicon/sounds/recording/${yyyy}/${mm}/${dd}/`;
      const res = await this.client.get(listUrl);
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const match = html.match(new RegExp(`[\\w.-]*${interactionId}[\\w.-]*\\.mp3`));
      if (match) {
        const fileRes = await this.client.get(`${listUrl}${match[0]}`, { responseType: 'stream' });
        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(destPath);
          fileRes.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        return destPath;
      }
    } catch (_) {}

    console.log(`[Intellicon] No recording found for ${interactionId}`);
    return null;
  }

  connectWebSocket(onCallComplete) {
    const base = this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    const wsUrls = [
      `${base}/socket.io/?EIO=4&transport=websocket`,
      `${base}/ws`,
      `${base}/cx9/socket`,
    ];

    let cookieString = '';
    try {
      const cookies = this.cookieJar.getCookiesSync(this.baseUrl);
      cookieString = cookies.map(c => `${c.key}=${c.value}`).join('; ');
    } catch (_) {}

    const tryConnect = (urlIndex = 0) => {
      if (urlIndex >= wsUrls.length) {
        setTimeout(() => tryConnect(0), 30000);
        return;
      }
      const wsUrl = wsUrls[urlIndex];
      console.log(`[Intellicon] WebSocket connecting to ${wsUrl}...`);

      const ws = new WebSocket(wsUrl, {
        headers: { 'Cookie': cookieString, 'User-Agent': 'Mozilla/5.0', 'Origin': this.baseUrl },
        rejectUnauthorized: false
      });

      ws.on('open', () => {
        console.log(`[Intellicon] WebSocket connected`);
        this.ws = ws;
        try { ws.send('40'); } catch (_) {}
      });

      ws.on('message', (data) => {
        const msg = data.toString();
        if (msg === '2') { try { ws.send('3'); } catch (_) {} return; }

        const siMatch = msg.match(/^42\["([^"]+)",(.*)\]$/s);
        if (siMatch) {
          const [, eventName, payloadStr] = siMatch;
          try {
            const callEndEvents = ['call-ended', 'interaction-complete', 'AgentACW', 'call-complete', 'HANGUP', 'callEnd'];
            if (callEndEvents.includes(eventName)) {
              onCallComplete(JSON.parse(payloadStr));
            }
          } catch (_) {}
          return;
        }

        try {
          const parsed = JSON.parse(msg);
          const et = parsed.type || parsed.event || parsed.eventType || '';
          const callEndEvents = ['call-ended', 'interaction-complete', 'AgentACW', 'call-complete', 'HANGUP', 'callEnd'];
          if (callEndEvents.includes(et)) onCallComplete(parsed);
        } catch (_) {}
      });

      ws.on('error', (err) => console.log(`[Intellicon] WS error: ${err.message}`));
      ws.on('close', (code) => {
        this.ws = null;
        setTimeout(() => tryConnect((urlIndex + 1) % wsUrls.length), 5000);
      });
    };

    tryConnect();
  }

  isWsConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

module.exports = IntelliconClient;
