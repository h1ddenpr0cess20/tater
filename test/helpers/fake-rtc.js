export function installMediaStack({
  sdpStatus = 200,
  micRejects = null,
  channelOpens = true,
  mediaDevices = true,
  secureContext = true,
} = {}) {
  const saved = new Map();
  const state = {
    peers: [],
    micTracks: [],
    audioContexts: [],
    sdpRequests: [],
    secretRequests: [],
    secret: { value: 'ek_test', model: 'gpt-realtime-2.1', voice: 'ballad' },
    secretStatus: 200,
  };

  const set = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  };

  class FakeTrack {
    constructor() { this.stopped = false; this.enabled = true; }
    stop() { this.stopped = true; }
  }

  class FakeStream {
    constructor({ mic = false } = {}) {
      this.tracks = [new FakeTrack()];
      if (mic) state.micTracks.push(...this.tracks);
    }
    getAudioTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
  }

  class FakeChannel {
    constructor() {
      this.readyState = 'connecting';
      this.sent = [];
      this.closed = false;
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    _fire(type, event) { (this._listeners.get(type) ?? []).forEach((fn) => fn(event)); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.readyState = 'closed'; }
    open() {
      if (this.readyState === 'open') return;
      this.readyState = 'open';
      this._fire('open', {});
    }
    deliver(event) { this._fire('message', { data: JSON.stringify(event) }); }
    deliverRaw(data) { this._fire('message', { data }); }
  }

  class FakePeerConnection {
    constructor() {
      this.connectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.tracks = [];
      this.closed = false;
      this.channel = null;
      this.ontrack = null;
      this._stateListeners = [];
      state.peers.push(this);
    }
    addEventListener(type, fn) {
      if (type === 'connectionstatechange') this._stateListeners.push(fn);
    }
    addTrack(track, stream) { this.tracks.push({ track, stream }); }
    createDataChannel() { this.channel = new FakeChannel(); return this.channel; }
    async createOffer() { return { type: 'offer', sdp: 'v=0 fake offer' }; }
    async setLocalDescription(desc) { this.localDescription = desc; }
    async setRemoteDescription(desc) {
      this.remoteDescription = desc;
      if (channelOpens) setTimeout(() => this.open(), 0);
    }
    close() { this.closed = true; this.connectionState = 'closed'; }

    open() {
      if (this.closed) return;
      this.connectionState = 'connected';
      this.ontrack?.({ streams: [new FakeStream()] });
      this.channel.open();
    }
    drop(reason = 'failed') {
      this.connectionState = reason;
      this._stateListeners.forEach((fn) => fn());
    }
  }

  class FakeAnalyser {
    constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0; }
    connect() {}
    getFloatTimeDomainData(buf) { buf.fill(0); }
  }

  class FakeAudioContext {
    constructor() { this.closed = false; state.audioContexts.push(this); }
    createAnalyser() { return new FakeAnalyser(); }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.closed = true; }
  }

  set('navigator', mediaDevices ? {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        if (micRejects) throw new Error(micRejects);
        state.lastConstraints = constraints;
        return new FakeStream({ mic: true });
      },
    },
  } : {});

  set('isSecureContext', secureContext);

  set('AudioContext', FakeAudioContext);
  set('RTCPeerConnection', FakePeerConnection);
  set('Audio', class { constructor() { this.srcObject = null; this.autoplay = false; } });

  set('fetch', async (url, init) => {
    if (String(url).startsWith('/api/session')) {
      state.secretRequests.push(JSON.parse(init.body));
      return {
        ok: state.secretStatus === 200,
        status: state.secretStatus,
        json: async () => (state.secretStatus === 200 ? state.secret : { error: 'mint failed' }),
      };
    }
    state.sdpRequests.push({ url: String(url), init });
    return {
      ok: sdpStatus === 200,
      status: sdpStatus,
      text: async () => 'v=0 fake answer',
    };
  });

  const frames = new Map();
  let nextFrame = 1;
  set('requestAnimationFrame', (fn) => { const id = nextFrame++; frames.set(id, fn); return id; });
  set('cancelAnimationFrame', (id) => frames.delete(id));

  state.pendingFrames = frames;
  state.tick = () => {
    const entry = [...frames][0];
    if (!entry) return false;
    frames.delete(entry[0]);
    entry[1]();
    return true;
  };

  state.restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };

  return state;
}
