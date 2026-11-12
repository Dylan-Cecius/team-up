// Team Up — serveur.
// Sert l'interface, garde les annonces en mémoire et les pousse en direct
// à tous les navigateurs connectés. Gère aussi les comptes. Aucune dépendance.
//
//   node server.js          démarre sur http://localhost:3210
//   node server.js --demo   ajoute des joueurs fictifs marqués « DÉMO »

import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createStore, validateListing} from './lib/listings.js';
import {createAccounts, pseudoKey, SESSION_SECONDS} from './lib/accounts.js';
import {createBilling, toUpdate} from './lib/billing.js';
import {startDemo} from './lib/demo.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const LISTING_BODY_BYTES = 4096;
const PROFILE_BODY_BYTES = 16_384;
const WEBHOOK_BODY_BYTES = 262_144;
const HEARTBEAT_MS = 25_000;
const SESSION_COOKIE = 'teamup_session';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
	'Content-Security-Policy': [
		"default-src 'self'",
		"style-src 'self' https://fonts.googleapis.com",
		'font-src https://fonts.gstatic.com',
		"img-src 'self' data:",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'self'",
		"object-src 'none'",
	].join('; '),
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'Cross-Origin-Resource-Policy': 'same-origin',
};

function sendJson(res, status, body, extraHeaders = {}) {
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		...extraHeaders,
	});
	res.end(JSON.stringify(body));
}

// Lit un corps JSON borné. Rejette avec {status, error} si ça ne va pas.
function readJson(req, maxBytes = LISTING_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
		if (type !== 'application/json') {
			req.resume();
			reject({status: 415, error: 'Envoie du JSON.'});
			return;
		}
		if (Number(req.headers['content-length']) > maxBytes) {
			req.resume();
			reject({status: 413, error: 'Envoi trop volumineux.'});
			return;
		}

		const chunks = [];
		let size = 0;
		let rejected = false;
		req.on('data', (chunk) => {
			if (rejected) return;
			size += chunk.length;
			if (size > maxBytes) {
				rejected = true;
				reject({status: 413, error: 'Envoi trop volumineux.'});
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (rejected) return;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject({status: 400, error: 'Envoi illisible.'});
			}
		});
		req.on('error', () => {
			if (!rejected) reject({status: 400, error: 'Requête interrompue.'});
		});
	});
}

// Lit le corps tel quel, borné. Sert au webhook : la signature de Stripe
// porte sur les octets reçus, pas sur du JSON relu.
function readRaw(req, maxBytes) {
	return new Promise((resolve, reject) => {
		if (Number(req.headers['content-length']) > maxBytes) {
			req.resume();
			reject({status: 413, error: 'Envoi trop volumineux.'});
			return;
		}
		const chunks = [];
		let size = 0;
		let rejected = false;
		req.on('data', (chunk) => {
			if (rejected) return;
			size += chunk.length;
			if (size > maxBytes) {
				rejected = true;
				reject({status: 413, error: 'Envoi trop volumineux.'});
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!rejected) resolve(Buffer.concat(chunks));
		});
		req.on('error', () => {
			if (!rejected) reject({status: 400, error: 'Requête interrompue.'});
		});
	});
}

function readCookie(req, name) {
	for (const part of String(req.headers.cookie ?? '').split(';')) {
		const cut = part.indexOf('=');
		if (cut > 0 && part.slice(0, cut).trim() === name) return part.slice(cut + 1).trim();
	}
	return null;
}

// Compteur de tentatives par clé, remis à zéro après `windowMs`.
function createLimiter({max, windowMs}) {
	const hits = new Map();
	return {
		blocked(key) {
			const entry = hits.get(key);
			return Boolean(entry && entry.resetAt > Date.now() && entry.count >= max);
		},
		hit(key) {
			const now = Date.now();
			const entry = hits.get(key);
			if (!entry || entry.resetAt <= now) hits.set(key, {count: 1, resetAt: now + windowMs});
			else entry.count += 1;
			if (hits.size > 10_000) {
				for (const [other, value] of hits) if (value.resetAt <= now) hits.delete(other);
			}
		},
		clear(key) {
			hits.delete(key);
		},
	};
}

async function serveStatic(req, res, pathname) {
	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		res.writeHead(400).end('Requête invalide');
		return;
	}
	if (decoded.includes('\0') || decoded.includes('\\')) {
		res.writeHead(400).end('Requête invalide');
		return;
	}

	const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
	const file = path.resolve(PUBLIC_DIR, relative);
	if (!file.startsWith(PUBLIC_DIR + path.sep)) {
		res.writeHead(404).end('Introuvable');
		return;
	}
	const type = MIME[path.extname(file).toLowerCase()];
	if (!type) {
		res.writeHead(404).end('Introuvable');
		return;
	}

	try {
		const content = await readFile(file);
		res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-cache'});
		res.end(req.method === 'HEAD' ? undefined : content);
	} catch {
		res.writeHead(404).end('Introuvable');
	}
}

export function createApp({
	demo = false,
	maxStreamsPerIp = 8,
	postIntervalMs = 1000,
	maxListings = 500,
	accountsFile = null, // null : comptes en mémoire seulement
	secureCookies = false, // true derrière HTTPS
	loginLimit = {max: 8, windowMs: 10 * 60 * 1000},
	registerLimit = {max: 5, windowMs: 60 * 60 * 1000},
	billing = createBilling({}), // abonnement Plus ; désactivé par défaut
} = {}) {
	const store = createStore({max: maxListings});
	const accounts = createAccounts({file: accountsFile});
	const clients = new Map(); // jeton -> {res, ip, lastPost}
	const bots = demo ? startDemo(store) : null;
	const loginAttempts = createLimiter(loginLimit);
	const registrations = createLimiter(registerLimit);
	const checkouts = createLimiter({max: 10, windowMs: 10 * 60 * 1000});

	// Diffusion groupée : plusieurs changements rapprochés = un seul envoi.
	let pending = null;
	const snapshot = () =>
		`event: state\ndata: ${JSON.stringify({
			now: Date.now(),
			online: clients.size + (bots?.size ?? 0),
			listings: store.all(),
		})}\n\n`;
	const broadcast = () => {
		if (pending) return;
		pending = setTimeout(() => {
			pending = null;
			const frame = snapshot();
			for (const client of clients.values()) client.res.write(frame);
		}, 40);
	};
	store.onChange(broadcast);

	const heartbeat = setInterval(() => {
		for (const client of clients.values()) client.res.write(': ping\n\n');
	}, HEARTBEAT_MS);
	heartbeat.unref();

	const ipOf = (req) => req.socket.remoteAddress ?? 'inconnue';

	// ---------- Sessions de compte (cookie) ----------

	const sessionCookie = (token, maxAge) =>
		`${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
	const withSession = (token) => ({'Set-Cookie': sessionCookie(token, SESSION_SECONDS)});
	const withoutSession = () => ({'Set-Cookie': sessionCookie('', 0)});
	const currentUser = (req) => accounts.authenticate(readCookie(req, SESSION_COOKIE));
	// Le compte tel que son titulaire le voit : tout sauf son identifiant interne.
	const present = (user) => {
		if (!user) return null;
		const {id, ...visible} = user;
		return visible;
	};
	const billingInfo = () => ({enabled: billing.enabled, priceLabel: billing.priceLabel});

	async function bodyOr(req, res, maxBytes) {
		try {
			const body = await readJson(req, maxBytes);
			if (body === null || typeof body !== 'object' || Array.isArray(body)) {
				sendJson(res, 400, {error: 'Envoi illisible.'});
				return null;
			}
			return body;
		} catch (problem) {
			sendJson(res, problem.status, {error: problem.error}, {Connection: 'close'});
			return null;
		}
	}

	async function register(req, res) {
		const ip = ipOf(req);
		if (registrations.blocked(ip)) {
			req.resume();
			return sendJson(res, 429, {error: 'Trop d’inscriptions depuis cette adresse. Réessaie plus tard.'});
		}
		const body = await bodyOr(req, res);
		if (!body) return;
		const result = await accounts.register(body.pseudo, body.password);
		if (!result.ok) return sendJson(res, result.status, {error: result.error});
		registrations.hit(ip);
		sendJson(res, 201, {user: result.user}, withSession(result.token));
	}

	async function login(req, res) {
		const body = await bodyOr(req, res);
		if (!body) return;
		const ip = ipOf(req);
		const keys = [`${ip}|${pseudoKey(String(body.pseudo ?? '').slice(0, 64))}`, `ip|${ip}`];
		if (loginAttempts.blocked(keys[0]) || loginAttempts.blocked(keys[1])) {
			return sendJson(res, 429, {error: 'Trop de tentatives. Réessaie dans quelques minutes.'});
		}
		const result = await accounts.login(body.pseudo, body.password);
		if (!result.ok) {
			for (const key of keys) loginAttempts.hit(key);
			return sendJson(res, result.status, {error: result.error});
		}
		loginAttempts.clear(keys[0]);
		sendJson(res, 200, {user: result.user}, withSession(result.token));
	}

	function logout(req, res) {
		req.resume();
		accounts.logout(readCookie(req, SESSION_COOKIE));
		sendJson(res, 200, {ok: true}, withoutSession());
	}

	async function updateProfile(req, res) {
		const user = currentUser(req);
		if (!user) {
			req.resume();
			return sendJson(res, 401, {error: 'Connecte-toi pour continuer.'});
		}
		const body = await bodyOr(req, res, PROFILE_BODY_BYTES);
		if (!body) return;
		const result = accounts.updateProfile(user.id, body.profile);
		if (!result.ok) return sendJson(res, result.status, {error: result.error});
		sendJson(res, 200, {user: result.user});
	}

	async function changePassword(req, res) {
		const user = currentUser(req);
		if (!user) {
			req.resume();
			return sendJson(res, 401, {error: 'Connecte-toi pour continuer.'});
		}
		const body = await bodyOr(req, res);
		if (!body) return;
		const key = `pw|${user.id}`;
		if (loginAttempts.blocked(key)) {
			return sendJson(res, 429, {error: 'Trop de tentatives. Réessaie dans quelques minutes.'});
		}
		const result = await accounts.changePassword(user.id, body.current, body.next);
		if (!result.ok) {
			if (result.status === 403) loginAttempts.hit(key);
			return sendJson(res, result.status, {error: result.error});
		}
		sendJson(res, 200, {user: result.user}, withSession(result.token));
	}

	async function deleteAccount(req, res) {
		const user = currentUser(req);
		if (!user) {
			req.resume();
			return sendJson(res, 401, {error: 'Connecte-toi pour continuer.'});
		}
		const body = await bodyOr(req, res);
		if (!body) return;
		const key = `pw|${user.id}`;
		if (loginAttempts.blocked(key)) {
			return sendJson(res, 429, {error: 'Trop de tentatives. Réessaie dans quelques minutes.'});
		}
		const result = await accounts.remove(user.id, body.password);
		if (!result.ok) {
			if (result.status === 403) loginAttempts.hit(key);
			return sendJson(res, result.status, {error: result.error});
		}
		sendJson(res, 200, {ok: true}, withoutSession());
	}

	// ---------- Abonnement Plus ----------

	const needsBilling = (res) => {
		if (billing.enabled) return false;
		sendJson(res, 503, {error: 'Les abonnements ne sont pas encore ouverts.'});
		return true;
	};

	async function startCheckout(req, res) {
		req.resume();
		const user = currentUser(req);
		if (!user) return sendJson(res, 401, {error: 'Connecte-toi pour continuer.'});
		if (needsBilling(res)) return;
		if (user.plus) return sendJson(res, 409, {error: 'Tu es déjà abonné à Plus.'});
		if (checkouts.blocked(user.id)) return sendJson(res, 429, {error: 'Trop de tentatives. Réessaie dans quelques minutes.'});
		checkouts.hit(user.id);
		try {
			const url = await billing.createCheckout({userId: user.id, customerId: accounts.billingCustomer(user.id)});
			sendJson(res, 200, {url});
		} catch (error) {
			console.error('Team Up : paiement impossible.', error.message);
			sendJson(res, 502, {error: 'Le paiement est indisponible pour l’instant. Réessaie dans un instant.'});
		}
	}

	async function openPortal(req, res) {
		req.resume();
		const user = currentUser(req);
		if (!user) return sendJson(res, 401, {error: 'Connecte-toi pour continuer.'});
		if (needsBilling(res)) return;
		const customerId = accounts.billingCustomer(user.id);
		if (!customerId) return sendJson(res, 409, {error: 'Aucun abonnement à gérer.'});
		if (checkouts.blocked(user.id)) return sendJson(res, 429, {error: 'Trop de tentatives. Réessaie dans quelques minutes.'});
		checkouts.hit(user.id);
		try {
			sendJson(res, 200, {url: await billing.createPortal({customerId})});
		} catch (error) {
			console.error('Team Up : portail indisponible.', error.message);
			sendJson(res, 502, {error: 'La gestion de l’abonnement est indisponible pour l’instant. Réessaie dans un instant.'});
		}
	}

	// Stripe prévient ici quand un paiement réussit, change ou s'arrête.
	// C'est la seule chose qui active ou coupe Plus : le retour du navigateur
	// après paiement n'est jamais cru sur parole.
	async function stripeWebhook(req, res) {
		if (!billing.enabled) {
			req.resume();
			return sendJson(res, 503, {error: 'Les abonnements ne sont pas encore ouverts.'});
		}
		let raw;
		try {
			raw = await readRaw(req, WEBHOOK_BODY_BYTES);
		} catch (problem) {
			return sendJson(res, problem.status, {error: problem.error}, {Connection: 'close'});
		}
		let event;
		try {
			event = billing.verifyEvent(raw, req.headers['stripe-signature']);
		} catch {
			return sendJson(res, 400, {error: 'Signature invalide.'});
		}
		const update = toUpdate(event);
		if (update) accounts.applyBilling(update);
		sendJson(res, 200, {received: true});
	}

	// ---------- Annonces en direct ----------

	function openStream(req, res) {
		const ip = ipOf(req);
		let sameIp = 0;
		for (const client of clients.values()) if (client.ip === ip) sameIp += 1;
		if (sameIp >= maxStreamsPerIp) {
			sendJson(res, 429, {error: 'Trop d’onglets ouverts depuis cette adresse.'});
			return;
		}

		const token = randomBytes(16).toString('hex');
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Accel-Buffering': 'no',
		});
		res.write('retry: 2000\n\n');
		res.write(`event: hello\ndata: ${JSON.stringify({token})}\n\n`);
		res.write(snapshot());
		clients.set(token, {res, ip, lastPost: 0});
		broadcast();

		// Onglet fermé ou connexion perdue : l'annonce disparaît avec lui.
		res.on('close', () => {
			clients.delete(token);
			if (!store.remove(token)) broadcast();
		});
	}

	async function publish(req, res) {
		const token = String(req.headers['x-session'] ?? '');
		const client = clients.get(token);
		if (!client) {
			req.resume();
			sendJson(res, 401, {error: 'Session expirée. Recharge la page.'});
			return;
		}

		const now = Date.now();
		if (now - client.lastPost < postIntervalMs) {
			req.resume();
			sendJson(res, 429, {error: 'Doucement ! Réessaie dans une seconde.'});
			return;
		}

		let body;
		try {
			body = await readJson(req);
		} catch (problem) {
			// On ferme la connexion : inutile de recevoir la suite d'un envoi refusé.
			sendJson(res, problem.status, {error: problem.error}, {Connection: 'close'});
			return;
		}

		// Un membre publie toujours sous le pseudo de son compte.
		const user = currentUser(req);
		if (user && body !== null && typeof body === 'object' && !Array.isArray(body)) {
			body.pseudo = user.pseudo;
		}

		const result = validateListing(body);
		if (!result.ok) {
			sendJson(res, 400, {error: result.error});
			return;
		}
		if (!user && accounts.isTaken(result.listing.pseudo)) {
			sendJson(res, 409, {error: 'Ce pseudo appartient à un membre. Connecte-toi ou choisis-en un autre.'});
			return;
		}
		// La session a pu se fermer pendant la lecture du corps.
		if (!clients.has(token)) {
			sendJson(res, 401, {error: 'Session expirée. Recharge la page.'});
			return;
		}

		const listing = store.upsert(token, result.listing, {member: Boolean(user), plus: Boolean(user?.plus)});
		if (!listing) {
			sendJson(res, 503, {error: 'Le salon est complet pour l’instant. Réessaie dans un moment.'});
			return;
		}
		client.lastPost = now;
		sendJson(res, 200, {listing});
	}

	function unpublish(req, res) {
		const token = String(req.headers['x-session'] ?? '');
		if (!clients.has(token)) {
			sendJson(res, 401, {error: 'Session expirée. Recharge la page.'});
			return;
		}
		store.remove(token);
		sendJson(res, 200, {ok: true});
	}

	// ---------- Aiguillage ----------

	// Les requêtes qui modifient quelque chose doivent venir du site lui-même.
	function sameOrigin(req) {
		const origin = req.headers.origin;
		if (!origin) return true;
		try {
			return new URL(origin).host === req.headers.host;
		} catch {
			return false;
		}
	}

	const api = {
		'GET /api/stream': openStream,
		'POST /api/listing': publish,
		'DELETE /api/listing': unpublish,
		'GET /api/me': (req, res) => sendJson(res, 200, {user: present(currentUser(req)), billing: billingInfo()}),
		'PUT /api/me': updateProfile,
		'DELETE /api/me': deleteAccount,
		'POST /api/me/password': changePassword,
		'POST /api/billing/checkout': startCheckout,
		'POST /api/billing/portal': openPortal,
		'POST /api/billing/webhook': stripeWebhook,
		'POST /api/auth/register': register,
		'POST /api/auth/login': login,
		'POST /api/auth/logout': logout,
	};
	const apiPaths = new Map();
	for (const key of Object.keys(api)) {
		const [method, route] = key.split(' ');
		apiPaths.set(route, [...(apiPaths.get(route) ?? []), method]);
	}

	const server = http.createServer((req, res) => {
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

		// On ne garde que le chemin, sans le laisser être normalisé :
		// la vérification anti-sortie de dossier se fait dans serveStatic.
		const pathname = (req.url ?? '/').split(/[?#]/)[0];

		if (pathname.startsWith('/api/')) {
			const methods = apiPaths.get(pathname);
			if (!methods) {
				req.resume();
				return sendJson(res, 404, {error: 'Introuvable.'});
			}
			if (!methods.includes(req.method)) {
				req.resume();
				return sendJson(res, 405, {error: 'Méthode non prévue.'}, {Allow: methods.join(', ')});
			}
			if (req.method !== 'GET' && !sameOrigin(req)) {
				req.resume();
				return sendJson(res, 403, {error: 'Requête refusée.'});
			}
			Promise.resolve()
				.then(() => api[`${req.method} ${pathname}`](req, res))
				.catch((error) => {
					console.error('Team Up : erreur inattendue.', error);
					if (!res.headersSent) sendJson(res, 500, {error: 'Erreur du serveur. Réessaie dans un instant.'});
					else res.end();
				});
			return;
		}

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			req.resume();
			res.writeHead(405, {Allow: 'GET, HEAD'}).end('Méthode non prévue');
			return;
		}
		return serveStatic(req, res, pathname);
	});

	server.on('close', () => {
		clearInterval(heartbeat);
		clearTimeout(pending);
		bots?.stop();
	});

	server.accounts = accounts;
	return server;
}

// Démarrage direct : `node server.js [--demo]`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const demo = process.argv.includes('--demo');
	const port = Number(process.env.PORT) || 3210;
	const billing = createBilling({
		secretKey: process.env.STRIPE_SECRET_KEY,
		priceId: process.env.STRIPE_PRICE_ID,
		webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
		siteUrl: process.env.SITE_URL,
		priceLabel: process.env.PLUS_PRICE_LABEL || null,
	});
	const host = process.env.HOST || 'localhost';
	createApp({
		demo,
		accountsFile: process.env.ACCOUNTS_FILE || path.join(ROOT, 'data', 'accounts.json'),
		secureCookies: process.env.SECURE_COOKIES === '1',
		billing,
	}).listen(port, host, () => {
		console.log(`Team Up est en ligne : http://localhost:${port}${demo ? '  (mode démo)' : ''}`);
		console.log(billing.enabled ? 'Abonnement Plus : ouvert.' : 'Abonnement Plus : fermé (réglages Stripe absents).');
	});
}
