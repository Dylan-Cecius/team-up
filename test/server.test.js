import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from '../server.js';

let server;
let base;
let port;

before(async () => {
	server = createApp({postIntervalMs: 0});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = server.address().port;
	base = `http://127.0.0.1:${port}`;
});

after(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

const listing = (over = {}) => ({
	game: 'lol',
	pseudo: 'Testeur',
	contact: 'Testeur#EUW',
	lang: 'Français',
	mic: true,
	note: '',
	criteria: {rank: 'Or', role: 'Mid', region: 'EUW', mode: 'ARAM'},
	...over,
});

// Ouvre le flux d'événements et permet d'attendre un événement précis.
async function openStream() {
	const controller = new AbortController();
	const res = await fetch(`${base}/api/stream`, {signal: controller.signal});
	assert.equal(res.status, 200);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const events = [];
	const waiters = [];
	let buffer = '';

	const deliver = () => {
		for (let w = waiters.length - 1; w >= 0; w--) {
			const index = events.findIndex(waiters[w].match);
			if (index >= 0) {
				const [event] = events.splice(index, 1);
				waiters.splice(w, 1)[0].resolve(event);
			}
		}
	};

	(async () => {
		try {
			for (;;) {
				const {value, done} = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, {stream: true});
				let cut;
				while ((cut = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					const type = /^event: (.+)$/m.exec(block)?.[1];
					const data = /^data: (.+)$/m.exec(block)?.[1];
					if (type && data) events.push({type, data: JSON.parse(data)});
				}
				deliver();
			}
		} catch {
			// flux fermé par le test
		}
	})();

	const next = (match, label) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`événement attendu : ${label}`)), 2000);
			waiters.push({
				match,
				resolve: (event) => {
					clearTimeout(timer);
					resolve(event.data);
				},
			});
			deliver();
		});

	const hello = await next((e) => e.type === 'hello', 'hello');
	return {
		token: hello.token,
		state: (predicate = () => true, label = 'state') =>
			next((e) => e.type === 'state' && predicate(e.data), label),
		close: () => controller.abort(),
	};
}

const post = (token, body, headers = {}) =>
	fetch(`${base}/api/listing`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', 'X-Session': token, ...headers},
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});

// Requête brute : fetch normaliserait les « .. » avant d'envoyer.
const rawGet = (path) =>
	new Promise((resolve, reject) => {
		http
			.get({host: '127.0.0.1', port, path}, (res) => {
				let body = '';
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () => resolve({status: res.statusCode, body}));
			})
			.on('error', reject);
	});

test('sert la page d’accueil avec les en-têtes de sécurité', async () => {
	const res = await fetch(`${base}/`);
	assert.equal(res.status, 200);
	assert.match(res.headers.get('content-type'), /text\/html/);
	assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	assert.match(await res.text(), /Team Up/);
});

test('ne sort jamais du dossier public', async () => {
	for (const path of ['/../server.js', '/..%2fserver.js', '/%2e%2e/package.json', '/..\\server.js']) {
		const res = await rawGet(path);
		assert.notEqual(res.status, 200, path);
		assert.equal(res.body.includes('createApp'), false, path);
	}
});

test('fichier inconnu : 404 ; URL mal formée : 400', async () => {
	assert.equal((await fetch(`${base}/nope.js`)).status, 404);
	assert.equal((await rawGet('/%E0%A4%A')).status, 400);
});

test('le flux envoie hello puis l’état', async () => {
	const stream = await openStream();
	assert.match(stream.token, /^[0-9a-f]{32}$/);
	const state = await stream.state();
	assert.equal(typeof state.online, 'number');
	assert.ok(Array.isArray(state.listings));
	stream.close();
});

test('publier fait apparaître l’annonce chez les autres, sans le jeton', async () => {
	const alice = await openStream();
	const bob = await openStream();

	const res = await post(alice.token, listing({pseudo: 'Alice'}));
	assert.equal(res.status, 200);
	const {listing: mine} = await res.json();
	assert.ok(mine.id);

	const state = await bob.state((s) => s.listings.some((l) => l.pseudo === 'Alice'), 'annonce d’Alice');
	assert.equal(JSON.stringify(state).includes(alice.token), false);
	assert.ok(state.online >= 2);

	alice.close();
	bob.close();
});

test('fermer le flux retire l’annonce', async () => {
	const alice = await openStream();
	const bob = await openStream();
	await post(alice.token, listing({pseudo: 'Ephemere'}));
	await bob.state((s) => s.listings.some((l) => l.pseudo === 'Ephemere'), 'annonce publiée');

	alice.close();
	await bob.state((s) => !s.listings.some((l) => l.pseudo === 'Ephemere'), 'annonce retirée');
	bob.close();
});

test('DELETE retire l’annonce mais garde la session', async () => {
	const alice = await openStream();
	await post(alice.token, listing({pseudo: 'Retrait'}));
	await alice.state((s) => s.listings.some((l) => l.pseudo === 'Retrait'), 'annonce publiée');

	const res = await fetch(`${base}/api/listing`, {method: 'DELETE', headers: {'X-Session': alice.token}});
	assert.equal(res.status, 200);
	await alice.state((s) => !s.listings.some((l) => l.pseudo === 'Retrait'), 'annonce retirée');

	assert.equal((await post(alice.token, listing({pseudo: 'Retour'}))).status, 200);
	alice.close();
});

test('jeton inconnu ou absent : 401', async () => {
	assert.equal((await post('f'.repeat(32), listing())).status, 401);
	const res = await fetch(`${base}/api/listing`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(listing()),
	});
	assert.equal(res.status, 401);
	assert.equal(
		(await fetch(`${base}/api/listing`, {method: 'DELETE', headers: {'X-Session': 'nope'}})).status,
		401,
	);
});

test('annonce invalide : 400 avec un message', async () => {
	const alice = await openStream();
	const res = await post(alice.token, listing({game: 'tetris'}));
	assert.equal(res.status, 400);
	assert.match((await res.json()).error, /jeu/i);
	assert.equal((await post(alice.token, '{pas du json')).status, 400);
	alice.close();
});

test('corps trop gros : 413 ; mauvais type : 415', async () => {
	const alice = await openStream();
	const big = await post(alice.token, listing({note: 'x'.repeat(10_000)}));
	assert.equal(big.status, 413);
	const wrong = await post(alice.token, listing(), {'Content-Type': 'text/plain'});
	assert.equal(wrong.status, 415);
	alice.close();
});

test('méthode non prévue : 405', async () => {
	assert.equal((await fetch(`${base}/api/listing`, {method: 'PUT'})).status, 405);
	assert.equal((await fetch(`${base}/`, {method: 'POST'})).status, 405);
});

test('limite le rythme des publications par session', async () => {
	const limited = createApp({postIntervalMs: 60_000});
	await new Promise((resolve) => limited.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${limited.address().port}`;
	try {
		const controller = new AbortController();
		const res = await fetch(`${url}/api/stream`, {signal: controller.signal});
		const reader = res.body.getReader();
		const {value} = await reader.read();
		const token = /"token":"([0-9a-f]+)"/.exec(new TextDecoder().decode(value))[1];
		const send = () =>
			fetch(`${url}/api/listing`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', 'X-Session': token},
				body: JSON.stringify(listing()),
			});
		assert.equal((await send()).status, 200);
		assert.equal((await send()).status, 429);
		controller.abort();
	} finally {
		limited.closeAllConnections();
		await new Promise((resolve) => limited.close(resolve));
	}
});

test('limite le nombre de flux par adresse', async () => {
	const limited = createApp({maxStreamsPerIp: 2});
	await new Promise((resolve) => limited.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${limited.address().port}`;
	const controller = new AbortController();
	try {
		const open = () => fetch(`${url}/api/stream`, {signal: controller.signal});
		assert.equal((await open()).status, 200);
		assert.equal((await open()).status, 200);
		assert.equal((await open()).status, 429);
	} finally {
		controller.abort();
		limited.closeAllConnections();
		await new Promise((resolve) => limited.close(resolve));
	}
});

test('mode démo : des joueurs fictifs, tous marqués', async () => {
	const demo = createApp({demo: true});
	await new Promise((resolve) => demo.listen(0, '127.0.0.1', resolve));
	const controller = new AbortController();
	try {
		const res = await fetch(`http://127.0.0.1:${demo.address().port}/api/stream`, {signal: controller.signal});
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let text = '';
		while (!/event: state\ndata: .+\n\n/.test(text)) {
			const {value, done} = await reader.read();
			if (done) break;
			text += decoder.decode(value, {stream: true});
		}
		const state = JSON.parse(/event: state\ndata: (.+)\n\n/.exec(text)[1]);
		assert.ok(state.listings.length >= 20);
		assert.ok(state.listings.every((l) => l.demo === true));
	} finally {
		controller.abort();
		demo.closeAllConnections();
		await new Promise((resolve) => demo.close(resolve));
	}
});
