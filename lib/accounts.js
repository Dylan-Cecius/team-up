// Comptes : inscription, connexion, sessions et profil enregistré.
//
// - Connexion par pseudo + mot de passe. Aucun e-mail n'est demandé, donc
//   aucun moyen de récupérer un mot de passe oublié.
// - Les mots de passe sont hachés avec scrypt et un sel par compte.
// - Les jetons de session sont stockés hachés : un vol du fichier ne permet
//   pas de se connecter à la place de quelqu'un.
// - Tout est gardé dans un fichier JSON (ou en mémoire si `file` est null).

import {createHash, randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {GAMES, LANGS, LIMITS} from '../public/games.js';
import {cleanText, partialCriteria} from './listings.js';

const scryptAsync = promisify(scrypt);
const KEY_BYTES = 64;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const PLUS_STATUSES = new Set(['active', 'trialing']);
const hasPlus = (billing) => Boolean(billing && PLUS_STATUSES.has(billing.status));

export const SESSION_SECONDS = SESSION_MS / 1000;

const fail = (status, error) => ({ok: false, status, error});
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Deux pseudos qui ne diffèrent que par la casse ou une forme Unicode
// équivalente désignent le même compte.
export const pseudoKey = (pseudo) => String(pseudo).normalize('NFKC').toLocaleLowerCase('fr');

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

async function hashPassword(password, saltHex) {
	const derived = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), KEY_BYTES);
	return derived.toString('hex');
}

function checkPassword(password) {
	if (typeof password !== 'string' || password.length < LIMITS.passwordMin) {
		return `Mot de passe : au moins ${LIMITS.passwordMin} caractères.`;
	}
	if (password.length > LIMITS.passwordMax) {
		return `Mot de passe : ${LIMITS.passwordMax} caractères au maximum.`;
	}
	return null;
}

// Ne garde d'un profil que ce qui est connu et valide.
export function sanitizeProfile(raw) {
	const input = isObject(raw) ? raw : {};
	const rawGames = isObject(input.games) ? input.games : {};
	const games = {};
	for (const game of GAMES) {
		const entry = Object.hasOwn(rawGames, game.id) ? rawGames[game.id] : null;
		if (!isObject(entry)) continue;
		const clean = {
			contact: cleanText(entry.contact, LIMITS.contactMax),
			note: cleanText(entry.note, LIMITS.noteMax),
			criteria: partialCriteria(game, entry.criteria),
		};
		if (clean.contact || clean.note || Object.keys(clean.criteria).length) games[game.id] = clean;
	}
	return {
		lang: LANGS.includes(input.lang) ? input.lang : LANGS[0],
		mic: Boolean(input.mic),
		discord: cleanText(input.discord, LIMITS.discordMax),
		games,
	};
}

export function createAccounts({file = null, maxUsers = 20_000} = {}) {
	const users = new Map(); // id -> compte
	const byKey = new Map(); // pseudo normalisé -> id
	const sessions = new Map(); // hachage du jeton -> {userId, expiresAt}

	if (file && existsSync(file)) {
		// Un fichier illisible doit arrêter le démarrage : repartir de zéro
		// effacerait tous les comptes à la prochaine écriture.
		const data = JSON.parse(readFileSync(file, 'utf8'));
		for (const user of data.users ?? []) {
			users.set(user.id, user);
			byKey.set(pseudoKey(user.pseudo), user.id);
		}
		const now = Date.now();
		for (const session of data.sessions ?? []) {
			if (session.expiresAt > now && users.has(session.userId)) {
				sessions.set(session.tokenHash, {userId: session.userId, expiresAt: session.expiresAt});
			}
		}
	}

	// Écritures l'une après l'autre, via un fichier temporaire renommé :
	// une coupure en pleine écriture ne laisse jamais un fichier tronqué.
	let writing = Promise.resolve();
	function save() {
		if (!file) return writing;
		writing = writing
			.then(async () => {
				const now = Date.now();
				const data = {
					version: 1,
					users: [...users.values()],
					sessions: [...sessions]
						.filter(([, session]) => session.expiresAt > now)
						.map(([tokenHash, session]) => ({tokenHash, ...session})),
				};
				mkdirSync(path.dirname(file), {recursive: true});
				const temporary = `${file}.tmp`;
				await writeFile(temporary, JSON.stringify(data, null, '\t'), {mode: 0o600});
				await rename(temporary, file);
			})
			.catch((error) => {
				console.error('Team Up : impossible d’enregistrer les comptes.', error);
			});
		return writing;
	}

	// Ce que le titulaire voit de son propre compte (jamais les identifiants Stripe).
	const publicUser = (user) => {
		const plus = hasPlus(user.billing);
		return {
			pseudo: user.pseudo,
			createdAt: user.createdAt,
			profile: user.profile,
			plus,
			plusUntil: plus ? (user.billing.currentPeriodEnd ?? null) : null,
			cancelsAtPeriodEnd: plus && Boolean(user.billing.cancelAtPeriodEnd),
			canManage: Boolean(user.billing?.customerId),
		};
	};

	function openSession(userId) {
		const token = randomBytes(32).toString('hex');
		sessions.set(hashToken(token), {userId, expiresAt: Date.now() + SESSION_MS});
		return token;
	}

	function closeSessionsOf(userId) {
		for (const [tokenHash, session] of sessions) {
			if (session.userId === userId) sessions.delete(tokenHash);
		}
	}

	async function passwordMatches(user, password) {
		if (typeof password !== 'string' || password.length > LIMITS.passwordMax) password = '';
		// Même travail que le compte existe ou non, pour ne pas révéler
		// par le temps de réponse quels pseudos sont inscrits.
		const salt = user?.salt ?? '00'.repeat(16);
		const derived = Buffer.from(await hashPassword(password, salt), 'hex');
		const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(KEY_BYTES);
		return timingSafeEqual(derived, expected) && Boolean(user);
	}

	return {
		get size() {
			return users.size;
		},

		isTaken(pseudo) {
			return byKey.has(pseudoKey(cleanText(pseudo, LIMITS.pseudoMax)));
		},

		async register(rawPseudo, password) {
			const pseudo = cleanText(rawPseudo, LIMITS.pseudoMax);
			if (pseudo.length < LIMITS.pseudoMin) {
				return fail(400, `Pseudo : au moins ${LIMITS.pseudoMin} caractères.`);
			}
			const problem = checkPassword(password);
			if (problem) return fail(400, problem);

			const key = pseudoKey(pseudo);
			if (byKey.has(key)) return fail(409, 'Ce pseudo est déjà pris.');
			if (users.size >= maxUsers) return fail(503, 'Les inscriptions sont fermées pour l’instant.');

			const salt = randomBytes(16).toString('hex');
			const hash = await hashPassword(password, salt);
			// Quelqu'un a pu prendre le pseudo pendant le calcul.
			if (byKey.has(key)) return fail(409, 'Ce pseudo est déjà pris.');

			const user = {
				id: randomBytes(8).toString('hex'),
				pseudo,
				salt,
				hash,
				createdAt: Date.now(),
				profile: sanitizeProfile(null),
				billing: null,
			};
			users.set(user.id, user);
			byKey.set(key, user.id);
			const token = openSession(user.id);
			save();
			return {ok: true, user: publicUser(user), token};
		},

		async login(rawPseudo, password) {
			const user = users.get(byKey.get(pseudoKey(cleanText(rawPseudo, LIMITS.pseudoMax)))) ?? null;
			if (!(await passwordMatches(user, password))) {
				return fail(401, 'Pseudo ou mot de passe incorrect.');
			}
			const token = openSession(user.id);
			save();
			return {ok: true, user: publicUser(user), token};
		},

		// Renvoie le compte lié à un jeton de session, ou null.
		authenticate(token) {
			if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
			const tokenHash = hashToken(token);
			const session = sessions.get(tokenHash);
			if (!session) return null;
			if (session.expiresAt <= Date.now()) {
				sessions.delete(tokenHash);
				return null;
			}
			const user = users.get(session.userId);
			return user ? {id: user.id, ...publicUser(user)} : null;
		},

		logout(token) {
			if (typeof token === 'string' && sessions.delete(hashToken(token))) save();
		},

		updateProfile(userId, rawProfile) {
			const user = users.get(userId);
			if (!user) return fail(401, 'Session expirée.');
			user.profile = sanitizeProfile(rawProfile);
			save();
			return {ok: true, user: publicUser(user)};
		},

		// Change le mot de passe et ferme toutes les sessions ouvertes ailleurs.
		async changePassword(userId, current, next) {
			const user = users.get(userId);
			if (!user) return fail(401, 'Session expirée.');
			if (!(await passwordMatches(user, current))) return fail(403, 'Mot de passe actuel incorrect.');
			const problem = checkPassword(next);
			if (problem) return fail(400, problem.replace('Mot de passe', 'Nouveau mot de passe'));

			user.salt = randomBytes(16).toString('hex');
			user.hash = await hashPassword(next, user.salt);
			closeSessionsOf(user.id);
			const token = openSession(user.id);
			save();
			return {ok: true, user: publicUser(user), token};
		},

		async remove(userId, password) {
			const user = users.get(userId);
			if (!user) return fail(401, 'Session expirée.');
			if (!(await passwordMatches(user, password))) return fail(403, 'Mot de passe incorrect.');
			// Supprimer le compte ne résilie pas l'abonnement : on ne laisse pas
			// quelqu'un continuer à payer pour un compte qui n'existe plus.
			if (hasPlus(user.billing) && !user.billing.cancelAtPeriodEnd) {
				return fail(409, 'Résilie d’abord ton abonnement Plus (« Gérer mon abonnement »), puis supprime ton compte.');
			}
			closeSessionsOf(user.id);
			users.delete(user.id);
			byKey.delete(pseudoKey(user.pseudo));
			save();
			return {ok: true};
		},

		// Identifiant client Stripe d'un compte, s'il a déjà payé.
		billingCustomer(userId) {
			return users.get(userId)?.billing?.customerId ?? null;
		},

		// Applique un événement Stripe (voir toUpdate dans billing.js).
		// Idempotent : le même événement reçu deux fois donne le même résultat.
		applyBilling(update) {
			let user = update.userId ? (users.get(update.userId) ?? null) : null;
			if (!user && update.customerId) {
				user = [...users.values()].find((candidate) => candidate.billing?.customerId === update.customerId) ?? null;
			}
			if (!user) return null;

			const current = user.billing ?? {};
			if (update.kind === 'checkout') {
				const known = current.subscriptionId && current.subscriptionId === update.subscriptionId;
				user.billing = known
					? {...current, customerId: update.customerId ?? current.customerId ?? null}
					: {
							customerId: update.customerId ?? current.customerId ?? null,
							subscriptionId: update.subscriptionId,
							status: update.paid ? 'active' : 'incomplete',
							currentPeriodEnd: null,
							cancelAtPeriodEnd: false,
						};
			} else {
				// L'événement d'un ancien abonnement résilié ne doit pas écraser le nouveau.
				const other = current.subscriptionId && current.subscriptionId !== update.subscriptionId;
				if (other && !PLUS_STATUSES.has(update.status)) return publicUser(user);
				user.billing = {
					customerId: update.customerId ?? current.customerId ?? null,
					subscriptionId: update.subscriptionId,
					status: update.status,
					currentPeriodEnd: update.currentPeriodEnd ?? (other ? null : (current.currentPeriodEnd ?? null)),
					cancelAtPeriodEnd: update.cancelAtPeriodEnd,
				};
			}
			save();
			return publicUser(user);
		},

		// Attend la fin des écritures en cours (utile aux tests et à l'arrêt).
		flush() {
			return writing;
		},
	};
}
