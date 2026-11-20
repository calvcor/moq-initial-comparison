// SFU de la rama WebRTC (RTC_SERVER=mediasoup): una aplicación mínima sobre la biblioteca mediasoup, que no es un
// servidor por sí sola. Solo hace de pegamento: la decisión de qué capa recibe cada espectador es de mediasoup, sin
// capas preferidas ni límites, y aquí no se toca (principio 1 de CLAUDE.md).
//
// - Ingesta: POST /ingest, del orquestador. RTP sin cifrar en un PlainTransport (va por la red interna, como el
//   MPEG-TS hacia MediaMTX). El simulcast son los SSRC de las calidades, de la más baja a la más alta, que es el orden
//   de mediasoup. Todo llega por un solo puerto, y lo que entra por él se aprende del primer paquete (comedia).
// - Espectadores: una conexión WebSocket por espectador, directa a este servidor por el router (8189/tcp, sin pasar
//   por el proxy de la página), como la aplicación del paper. Mientras está abierta, la sesión vive; si la página se
//   recarga o Chrome muere, el sistema del cliente cierra la conexión y la sesión se cierra al momento (con peticiones
//   HTTP sueltas, el SFU no se enteraba y seguía enviando ~29 s, hasta dar ICE por perdido). El vídeo va después
//   directo por UDP 8189, también por el router.
// - TLS: con DASH_HOST y su certificado (el de DASH directo), el mismo puerto acepta wss://, para páginas en HTTPS; sin
//   él, ws:// (en local). Se distinguen por el primer byte de la conexión.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as mediasoup from 'mediasoup';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8890);
const RTC_PORT = Number(process.env.RTC_PORT ?? 8189);
const SIGNAL_PORT = Number(process.env.SIGNAL_PORT ?? 8189); // TCP: el mismo número que el vídeo, que va por UDP
const DASH_HOST = (process.env.DASH_HOST ?? '').trim();
const ANNOUNCED = process.env.ANNOUNCED_ADDRESS || '127.0.0.1';
// Búferes de los sockets UDP: el tamaño por defecto del sistema es menor que una ráfaga de keyframe
const BUFFERS = { sendBufferSize: 4 << 20, recvBufferSize: 4 << 20 };

// H.264 Constrained Baseline, el de la escalera (x264 -preset ultrafast), y Opus. mediasoup compara el perfil, no el nivel.
const MEDIA_CODECS = [
	{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
	{ kind: 'video', mimeType: 'video/H264', clockRate: 90000,
		parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
];

const worker = await mediasoup.createWorker({ logLevel: 'warn' });
worker.on('died', () => { console.error('el worker de mediasoup ha muerto'); process.exit(1); });
const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
// Un solo puerto UDP para todos los espectadores: el router de emulación clasifica el tráfico por ese puerto
const webRtcServer = await worker.createWebRtcServer({
	listenInfos: [{ protocol: 'udp', ip: '0.0.0.0', announcedAddress: ANNOUNCED, port: RTC_PORT, ...BUFFERS }],
});
console.log(`mediasoup ${mediasoup.version}: UDP ${RTC_PORT}, anuncia ${ANNOUNCED}`);

let ingest = null; // { transport, producers: [] }
const sessions = new Map(); // id -> { transport, consumers: [] }

async function startIngest({ video, audio, cname }) {
	ingest?.transport.close();
	const transport = await router.createPlainTransport({
		listenInfo: { protocol: 'udp', ip: '0.0.0.0', ...BUFFERS }, rtcpMux: true, comedia: true,
	});
	const producers = [await transport.produce({ kind: 'video', rtpParameters: {
		codecs: [{ mimeType: 'video/H264', payloadType: video.payloadType, clockRate: 90000,
			parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
			// Sin esto mediasoup no pediría keyframes; aquí no los atiende nadie, pero es lo que hace por defecto
			rtcpFeedback: [{ type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }] }],
		encodings: video.ssrcs.map((ssrc) => ({ ssrc })),
		rtcp: { cname, reducedSize: true },
	} })];
	if (audio) {
		producers.push(await transport.produce({ kind: 'audio', rtpParameters: {
			codecs: [{ mimeType: 'audio/opus', payloadType: audio.payloadType, clockRate: 48000, channels: 2 }],
			encodings: [{ ssrc: audio.ssrc }],
			rtcp: { cname, reducedSize: true },
		} }));
	}
	ingest = { transport, producers };
	// Los espectadores de la emisión anterior consumían productores que ya no existen: su reproductor se recrea
	for (const id of sessions.keys()) closeSession(id);
	transport.on('tuple', (t) => console.log(`ingesta desde ${t.remoteIp}:${t.remotePort}`));
	console.log(`ingesta: ${video.ssrcs.length} calidades${audio ? ' y audio' : ''}, puerto ${transport.tuple.localPort}`);
	return { port: transport.tuple.localPort };
}

function closeSession(id) {
	const session = sessions.get(id);
	if (!session) return;
	sessions.delete(id);
	session.transport.close();
	// Si la cierra el servidor (ICE perdido, emisión nueva), el reproductor lo ve por su conexión y se recrea
	session.ws?.close();
}

async function createSession(ws) {
	const transport = await router.createWebRtcTransport({ webRtcServer });
	const id = randomUUID();
	// Diagnóstico (SFU_TRACE=1): estimación y sondeos de mediasoup, en una línea JSON por evento (docs/architecture.md)
	if (process.env.SFU_TRACE) {
		await transport.enableTraceEvent(['bwe', 'probation']);
		transport.on('trace', (t) => {
			if (t.type === 'bwe') console.log(`TRACE ${JSON.stringify({ t: Date.now(), type: 'bwe', available: t.info.availableBitrate, desired: t.info.desiredBitrate })}`);
			else console.log(`TRACE ${JSON.stringify({ t: Date.now(), type: 'probe', bytes: t.info.payloadSize ?? t.info.size ?? 0 })}`);
		});
	}
	sessions.set(id, { transport, consumers: [], ws });
	// El navegador cierra la conexión sin avisar por HTTP: se ve aquí, en DTLS o en ICE
	transport.on('dtlsstatechange', (state) => { if (state === 'closed' || state === 'failed') closeSession(id); });
	transport.on('icestatechange', (state) => { if (state === 'disconnected' || state === 'closed') closeSession(id); });
	return { id, routerRtpCapabilities: router.rtpCapabilities, iceParameters: transport.iceParameters,
		iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters, transportId: transport.id };
}

async function consume(session, { rtpCapabilities, audio }) {
	if (!ingest) throw new Error('aún no hay emisión');
	const result = [];
	for (const producer of ingest.producers) {
		if (producer.kind === 'audio' && !audio) continue;
		const consumer = await session.transport.consume({ producerId: producer.id, rtpCapabilities, paused: true });
		session.consumers.push(consumer);
		// Registro de lo que decide mediasoup, para poder explicar un cambio de calidad o un corte
		if (consumer.kind === 'video') consumer.on('layerschange', (layers) => console.log(`${new Date().toISOString()} capa: ${layers ? layers.spatialLayer : 'ninguna'}`));
		result.push({ id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
	}
	return result;
}

// Lo que decide mediasoup: estimación de ancho de banda hacia este espectador y capa que le está enviando
async function sessionStats(session) {
	const [transport] = await session.transport.getStats();
	const video = session.consumers.find((c) => c.kind === 'video');
	return {
		available_kbps: transport.availableOutgoingBitrate ? Math.round(transport.availableOutgoingBitrate / 1000) : null,
		spatial_layer: video?.currentLayers?.spatialLayer ?? null,
		layers: ingest?.producers[0].rtpParameters.encodings.length ?? 0,
		score: video?.score ?? null,
	};
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); } });
		req.on('error', reject);
	});
}

// Ingesta, del orquestador por la red interna (puerto PORT)
const routes = [
	['POST', /^\/ingest$/, (_, body) => startIngest(body)],
];

// Señalización de un espectador: mensajes { id, method, data } y respuestas { id, result } o { id, error }.
// Una sesión por conexión, que se cierra con ella.
const METHODS = {
	connect: (s, data) => s.transport.connect({ dtlsParameters: data.dtlsParameters }),
	consume: (s, data) => consume(s, data),
	resume: (s) => Promise.all(s.consumers.map((c) => c.resume())),
	stats: (s) => sessionStats(s),
};
function handleViewer(ws) {
	let id = null;
	ws.on('message', async (raw) => {
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		try {
			let result;
			if (msg.method === 'session') {
				if (id) throw new Error('la conexión ya tiene sesión');
				result = await createSession(ws);
				id = result.id;
				// La conexión pudo cerrarse mientras se creaba
				if (ws.readyState !== ws.OPEN) return closeSession(id);
			} else {
				const session = id && sessions.get(id);
				if (!session) throw new Error('sesión desconocida');
				if (!METHODS[msg.method]) throw new Error(`método desconocido: ${msg.method}`);
				result = await METHODS[msg.method](session, msg.data ?? {});
			}
			ws.send(JSON.stringify({ id: msg.id, result: result ?? {} }));
		} catch (err) {
			ws.send(JSON.stringify({ id: msg.id, error: String(err) }));
		}
	});
	ws.on('close', () => id && closeSession(id));
	ws.on('error', () => ws.terminate());
}

const wss = new WebSocketServer({ noServer: true });
const upgrade = (req, socket, head) => wss.handleUpgrade(req, socket, head, handleViewer);
const notFound = (_, res) => { res.writeHead(404); res.end(); };
const plain = http.createServer(notFound).on('upgrade', upgrade);
// Con certificado, servidor TLS; se vuelve a leer cada minuto, porque dash-cert lo emite y lo renueva
let secure = null, certStamp = 0;
function loadCert() {
	if (!DASH_HOST) return;
	const cert = `/certs/certificates/${DASH_HOST}.crt`, key = `/certs/certificates/${DASH_HOST}.key`;
	try {
		const stamp = statSync(cert).mtimeMs;
		if (stamp === certStamp) return;
		const options = { cert: readFileSync(cert), key: readFileSync(key) };
		if (secure) secure.setSecureContext(options);
		else secure = https.createServer(options, notFound).on('upgrade', upgrade);
		certStamp = stamp;
		console.log(`señalización con TLS para ${DASH_HOST}`);
	} catch {}
}
loadCert();
setInterval(loadCert, 60_000);
// 0x16 abre un saludo TLS; cualquier otra cosa es HTTP en claro
net.createServer((socket) => {
	socket.once('data', (chunk) => {
		socket.pause();
		socket.unshift(chunk);
		(chunk[0] === 0x16 && secure ? secure : plain).emit('connection', socket);
		process.nextTick(() => socket.resume());
	});
	socket.on('error', () => socket.destroy());
}).listen(SIGNAL_PORT, () => console.log(`señalización de espectadores en :${SIGNAL_PORT}/tcp`));

http.createServer(async (req, res) => {
	const send = (code, value) => {
		res.writeHead(code, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(value ?? {}));
	};
	try {
		const path = new URL(req.url, 'http://x').pathname;
		if (req.method === 'GET' && path === '/health') {
			// Diagnóstico, solo por la red interna (el punto de entrada no lo expone)
			const viewers = await Promise.all([...sessions.values()].map(async (s) => {
				const video = s.consumers.find((c) => c.kind === 'video');
				return { transport: (await s.transport.getStats())[0], layers: video?.currentLayers ?? null, preferred: video?.preferredLayers ?? null,
					score: video?.score ?? null, consumer: video ? await video.getStats() : null };
			}));
			const producer = ingest ? await ingest.producers[0].getStats() : [];
			return send(200, { version: mediasoup.version, ingest: Boolean(ingest), producer, viewers });
		}
		for (const [method, pattern, handler] of routes) {
			const match = req.method === method && pattern.exec(path);
			if (!match) continue;
			const session = match[1] ? sessions.get(match[1]) : null;
			if (match[1] && !session) return send(404, { error: 'sesión desconocida' });
			return send(200, await handler(session, await readJson(req)));
		}
		send(404, { error: 'ruta desconocida' });
	} catch (err) {
		console.error(err);
		send(500, { error: String(err) });
	}
}).listen(PORT, () => console.log(`ingesta y diagnóstico en :${PORT}`));
