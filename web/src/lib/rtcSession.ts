// Conexión del reproductor WebRTC con el servidor de la rama (RTC_SERVER): lo único que cambia entre MediaMTX y
// mediasoup es cómo se negocia. La medida, sobre el RTCPeerConnection y el <video>, es la misma.

import { Device } from 'mediasoup-client';

export interface RtcCallbacks {
  onTrack: (track: MediaStreamTrack, stream: MediaStream | undefined) => void;
  onState: (state: RTCPeerConnectionState) => void;
  onReceiver: (receiver: RTCRtpReceiver) => void; // receptor de vídeo, para pedirle el búfer de jitter
}

// Lo que decide mediasoup sobre este espectador; con MediaMTX no hay nada que preguntar
export interface SfuStats {
  available_kbps: number | null; // estimación de ancho de banda hacia el espectador
  spatial_layer: number | null; // capa que le está enviando: 0 es la más baja
  layers: number;
  score: number | null;
}

export interface RtcSession {
  start(): Promise<void>; // negocia; falla si el servidor aún no tiene la emisión
  connected(): boolean;
  getStats(): Promise<RTCStatsReport>;
  sfuStats?(): Promise<SfuStats | null>;
  close(): void;
}

// WHEP sin trickle: una petición con la oferta, ya con todos los candidatos, y la respuesta
export function openWhep(url: string, withAudio: boolean, callbacks: RtcCallbacks): RtcSession {
  const connection = new RTCPeerConnection();
  const transceiver = connection.addTransceiver('video', { direction: 'recvonly' });
  callbacks.onReceiver(transceiver.receiver);
  // Con audio, el navegador sincroniza las dos pistas (mismo MediaStream) y puede retrasar el vídeo
  if (withAudio) connection.addTransceiver('audio', { direction: 'recvonly' });
  connection.ontrack = (event) => callbacks.onTrack(event.track, event.streams[0]);
  connection.onconnectionstatechange = () => callbacks.onState(connection.connectionState);
  return {
    async start() {
      await connection.setLocalDescription(await connection.createOffer());
      await new Promise<void>((resolve) => {
        if (connection.iceGatheringState === 'complete') return resolve();
        const done = () => connection.iceGatheringState === 'complete' && resolve();
        connection.addEventListener('icegatheringstatechange', done);
        setTimeout(resolve, 2000);
      });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: connection.localDescription!.sdp,
      });
      if (!res.ok) throw new Error(`WHEP ${res.status}`);
      await connection.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    },
    connected: () => connection.connectionState === 'connected',
    getStats: () => connection.getStats(),
    close: () => connection.close(),
  };
}

// Señalización de la rama WebRTC, directa al servidor por el router (8189/tcp, en la cola de WebRTC), sin pasar por
// nginx-web: el WebSocket de mediasoup o el WHEP de MediaMTX. En una página HTTPS, con TLS y el nombre del certificado
// (rtc_tls_host, SERVER_HOST); en HTTP, sin TLS a moq_host o al host de la página. Devuelve la dirección con http(s)://
// Con mediasoup, la del WebSocket (ws:// o wss://); con MediaMTX, la URL WHEP del path de la emisión (rtc_path).
type SignalStatus = {
  rtc_server?: string; rtc_path?: string; rtc_signal_port?: number; rtc_tls_host?: string | null; moq_host?: string | null;
} | null | undefined;
export function rtcSignalUrl(status: SignalStatus) {
  const port = status?.rtc_signal_port ?? 8189;
  const base = window.location.protocol === 'https:'
    ? `https://${status?.rtc_tls_host || window.location.hostname}:${port}`
    : `http://${status?.moq_host || window.location.hostname}:${port}`;
  return status?.rtc_server === 'mediamtx' ? `${base}/${status.rtc_path ?? 'liveudp'}/whep` : base.replace(/^http/, 'ws');
}

// Peticiones sobre una conexión: { id, method, data } y su respuesta { id, result } o { id, error }
function signalling(url: string, onLost: () => void) {
  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let next = 0;
  let closing = false;
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('SFU: no se pudo abrir la señalización'));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.error) call.reject(new Error(`SFU: ${msg.error}`));
    else call.resolve(msg.result);
  };
  // Al cerrarse la conexión, el SFU cierra la sesión (y al revés): el reproductor debe recrearse
  ws.onclose = () => {
    for (const call of pending.values()) call.reject(new Error('SFU: señalización cerrada'));
    pending.clear();
    if (!closing) onLost();
  };
  return {
    async call(method: string, data?: object): Promise<any> {
      await opened;
      return new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, data }));
      });
    },
    close() {
      closing = true;
      ws.close();
    },
  };
}

// mediasoup no habla WHEP: la señalización es suya (sfu/server.mjs) y el cliente, mediasoup-client. Sin capas
// preferidas: la capa de cada espectador la elige mediasoup. La sesión vive lo que la conexión de señalización.
export function openMediasoup(signalUrl: string, withAudio: boolean, callbacks: RtcCallbacks): RtcSession {
  let transport: ReturnType<Device['createRecvTransport']> | null = null;
  let closed = false;
  let state: RTCPeerConnectionState = 'new';
  const sfu = signalling(signalUrl, () => {
    state = 'failed';
    callbacks.onState(state);
  });
  return {
    async start() {
      const session = await sfu.call('session');
      const device = new Device();
      await device.load({ routerRtpCapabilities: session.routerRtpCapabilities });
      if (closed) return;
      const recv = device.createRecvTransport({
        id: session.transportId,
        iceParameters: session.iceParameters,
        iceCandidates: session.iceCandidates,
        dtlsParameters: session.dtlsParameters,
      });
      transport = recv;
      recv.on('connect', ({ dtlsParameters }, callback, errback) => {
        sfu.call('connect', { dtlsParameters }).then(() => callback(), errback);
      });
      recv.on('connectionstatechange', (next) => {
        state = next as RTCPeerConnectionState;
        callbacks.onState(state);
      });
      const offers: any[] = await sfu.call('consume', { rtpCapabilities: device.rtpCapabilities, audio: withAudio });
      if (!offers.some((offer) => offer.kind === 'video')) throw new Error('sin vídeo');
      for (const offer of offers) {
        const consumer = await recv.consume({ id: offer.id, producerId: offer.producerId, kind: offer.kind, rtpParameters: offer.rtpParameters });
        if (consumer.kind === 'video') callbacks.onReceiver(consumer.rtpReceiver as RTCRtpReceiver);
        callbacks.onTrack(consumer.track, undefined);
      }
      await sfu.call('resume');
    },
    connected: () => state === 'connected',
    getStats: () => transport!.getStats(),
    sfuStats: async () => sfu.call('stats').catch(() => null),
    close() {
      closed = true;
      transport?.close();
      sfu.close();
    },
  };
}
