import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createAccounts, sanitizeProfile} from '../lib/accounts.js';
import {createApp} from '../server.js';

// Mots de passe de test, tirés au hasard à chaque exécution.
const secret = () => `test-${randomBytes(9).toString('base64url')}`;

test('inscription puis connexion', async () => {
	const accounts = createAccounts();
	const password = secret();
	const created = await accounts.register('  Kaelth ', password);
	assert.equal(created.ok, true);
	assert.equal(created.user.pseudo, 'Kaelth');
	assert.match(created.token, /^[0-9a-f]{64}$/);
	assert.equal(accounts.authenticate(created.token).pseudo, 'Kaelth');

	const logged = await accounts.login('kaelth', password);
	assert.equal(logged.ok, true, 'la casse du pseudo ne compte pas');
	assert.notEqual(logged.token, created.token);
});

test('refuse les doublons, y compris en changeant la casse', async () => {
	const accounts = createAccounts();
	await accounts.register('Kaelth', secret());
	const again = await accounts.register('KAELTH', secret());
	assert.equal(again.ok, false);
	assert.equal(again.status, 409);
	assert.equal(accounts.isTaken('kaelth'), true);
	assert.equal(accounts.isTaken('Autre'), false);
});

test('refuse pseudo trop court et mot de passe trop court ou trop long', async () => {
	const accounts = createAccounts();
	assert.equal((await accounts.register('a', secret())).status, 400);
	assert.equal((await accounts.register('Valide', 'court')).status, 400);
	assert.equal((await accounts.register('Valide', 'x'.repeat(500))).status, 400);
	assert.equal((await accounts.register('Valide', 12345678)).status, 400);
	assert.equal(accounts.size, 0);
});

test('mauvais mot de passe et compte inconnu : même réponse', async () => {
	const accounts = createAccounts();
	await accounts.register('Kaelth', secret());
	const wrong = await accounts.login('Kaelth', secret());
	const unknown = await accounts.login('Personne', secret());
	assert.equal(wrong.status, 401);
	assert.equal(unknown.status, 401);
	assert.equal(wrong.error, unknown.error);
});

test('jeton invalide, inconnu ou déconnecté : pas de compte', async () => {
	const accounts = createAccounts();
	const {token} = await accounts.register('Kaelth', secret());
	assert.equal(accounts.authenticate(null), null);
	assert.equal(accounts.authenticate('nope'), null);
	assert.equal(accounts.authenticate('f'.repeat(64)), null);
	accounts.logout(token);
	assert.equal(accounts.authenticate(token), null);
});

test('changer le mot de passe ferme les autres sessions', async () => {
	const accounts = createAccounts();
	const oldPassword = secret();
	const newPassword = secret();
	const first = await accounts.register('Kaelth', oldPassword);
	const second = await accounts.login('Kaelth', oldPassword);
	const user = accounts.authenticate(first.token);

	assert.equal((await accounts.changePassword(user.id, secret(), newPassword)).status, 403);
	assert.equal((await accounts.changePassword(user.id, oldPassword, 'court')).status, 400);

	const changed = await accounts.changePassword(user.id, oldPassword, newPassword);
	assert.equal(changed.ok, true);
	assert.equal(accounts.authenticate(first.token), null);
	assert.equal(accounts.authenticate(second.token), null);
	assert.equal(accounts.authenticate(changed.token).pseudo, 'Kaelth');
	assert.equal((await accounts.login('Kaelth', oldPassword)).ok, false);
	assert.equal((await accounts.login('Kaelth', newPassword)).ok, true);
});

test('supprimer le compte libère le pseudo', async () => {
	const accounts = createAccounts();
	const password = secret();
	const {token} = await accounts.register('Kaelth', password);
	const user = accounts.authenticate(token);
	assert.equal((await accounts.remove(user.id, secret())).status, 403);
	assert.equal((await accounts.remove(user.id, password)).ok, true);
	assert.equal(accounts.authenticate(token), null);
	assert.equal(accounts.isTaken('Kaelth'), false);
});

test('le profil ne garde que ce qui est connu et valide', () => {
	const profile = sanitizeProfile({
		lang: 'Klingon',
		mic: 1,
		discord: '  kaelth\n ',
		admin: true,
		games: {
			wow: {
				contact: 'Kaelth#2481',
				note: 'x'.repeat(500),
				criteria: {faction: 'Horde', level: 999, realm: 'Hyjal', cheat: 'oui'},
			},
			tetris: {contact: 'nope'},
			lol: 'pas un objet',
			__proto__: {contact: 'pollution'},
		},
	});
	assert.equal(profile.lang, 'Français');
	assert.equal(profile.mic, true);
	assert.equal(profile.discord, 'kaelth');
	assert.equal('admin' in profile, false);
	assert.deepEqual(Object.keys(profile.games), ['wow']);
	assert.equal(profile.games.wow.note.length, 140);
	assert.deepEqual(profile.games.wow.criteria, {faction: 'Horde', realm: 'Hyjal'});
	assert.deepEqual(sanitizeProfile('nope'), {lang: 'Français', mic: false, discord: '', games: {}});
});

test('les comptes survivent à un redémarrage, sans mot de passe ni jeton en clair', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'teamup-'));
	const file = path.join(dir, 'data', 'accounts.json');
	try {
		const password = secret();
		const first = createAccounts({file});
		const {token} = await first.register('Kaelth', password);
		first.updateProfile(first.authenticate(token).id, {discord: 'kaelth', games: {wow: {contact: 'Kaelth#2481'}}});
		await first.flush();

		const raw = readFileSync(file, 'utf8');
		assert.equal(raw.includes(password), false);
		assert.equal(raw.includes(token), false);

		const second = createAccounts({file});
		const user = second.authenticate(token);
		assert.equal(user.pseudo, 'Kaelth');
		assert.equal(user.profile.discord, 'kaelth');
		assert.equal(user.profile.games.wow.contact, 'Kaelth#2481');
		assert.equal((await second.login('Kaelth', password)).ok, true);
		await second.flush();
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

// ---------- Par le serveur ----------

async function withApp(options, run) {
	const server = createApp({postIntervalMs: 0, ...options});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const json = (method, route, body, headers = {}) =>
		fetch(base + route, {
			method,
			headers: {...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0] ?? '';
	try {
		await run({base, json, cookieOf});
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

async function openStream(base) {
	const controller = new AbortController();
	const res = await fetch(`${base}/api/stream`, {signal: controller.signal});
	const reader = res.body.getReader();
	const {value} = await reader.read();
	const token = /"token":"([0-9a-f]+)"/.exec(new TextDecoder().decode(value))[1];
	return {token, close: () => controller.abort()};
}

const listing = (over = {}) => ({
	game: 'lol',
	pseudo: 'Invite',
	contact: 'Invite#EUW',
	lang: 'Français',
	mic: true,
	discord: 'invite_d',
	criteria: {rank: 'Or', role: 'Mid', region: 'EUW', mode: 'ARAM'},
	...over,
});

test('serveur : inscription, cookie protégé, /api/me, déconnexion', async () => {
	await withApp({}, async ({json, cookieOf}) => {
		assert.equal((await (await json('GET', '/api/me')).json()).user, null);

		const password = secret();
		const created = await json('POST', '/api/auth/register', {pseudo: 'Kaelth', password});
		assert.equal(created.status, 201);
		const header = created.headers.get('set-cookie');
		assert.match(header, /HttpOnly/);
		assert.match(header, /SameSite=Strict/);
		const body = await created.json();
		assert.equal(body.user.pseudo, 'Kaelth');
		assert.equal(JSON.stringify(body).includes(password), false);

		const cookie = cookieOf(created);
		const me = await (await json('GET', '/api/me', undefined, {Cookie: cookie})).json();
		assert.equal(me.user.pseudo, 'Kaelth');

		const out = await json('POST', '/api/auth/logout', undefined, {Cookie: cookie});
		assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
		assert.equal((await (await json('GET', '/api/me', undefined, {Cookie: cookie})).json()).user, null);

		const back = await json('POST', '/api/auth/login', {pseudo: 'kaelth', password});
		assert.equal(back.status, 200);
		assert.equal((await json('POST', '/api/auth/login', {pseudo: 'kaelth', password: secret()})).status, 401);
	});
});

test('serveur : le profil se met à jour seulement une fois connecté', async () => {
	await withApp({}, async ({json, cookieOf}) => {
		assert.equal((await json('PUT', '/api/me', {profile: {discord: 'x'}})).status, 401);
		const created = await json('POST', '/api/auth/register', {pseudo: 'Kaelth', password: secret()});
		const cookie = cookieOf(created);
		const saved = await json('PUT', '/api/me', {profile: {discord: 'kaelth', mic: true}}, {Cookie: cookie});
		assert.equal(saved.status, 200);
		assert.equal((await saved.json()).user.profile.discord, 'kaelth');
	});
});

test('serveur : un pseudo de membre est réservé, et le membre publie sous son pseudo', async () => {
	await withApp({}, async ({base, json, cookieOf}) => {
		const created = await json('POST', '/api/auth/register', {pseudo: 'Kaelth', password: secret()});
		const cookie = cookieOf(created);

		const guest = await openStream(base);
		const stolen = await json('POST', '/api/listing', listing({pseudo: 'kaelth'}), {'X-Session': guest.token});
		assert.equal(stolen.status, 409);
		const fine = await json('POST', '/api/listing', listing(), {'X-Session': guest.token});
		assert.equal(fine.status, 200);
		const guestListing = (await fine.json()).listing;
		assert.equal(guestListing.member, undefined);
		assert.equal(guestListing.discord, 'invite_d');

		const member = await openStream(base);
		const posted = await json('POST', '/api/listing', listing({pseudo: 'Usurpateur'}), {
			'X-Session': member.token,
			Cookie: cookie,
		});
		assert.equal(posted.status, 200);
		const memberListing = (await posted.json()).listing;
		assert.equal(memberListing.pseudo, 'Kaelth');
		assert.equal(memberListing.member, true);

		guest.close();
		member.close();
	});
});

test('serveur : changement de mot de passe et suppression du compte', async () => {
	await withApp({}, async ({json, cookieOf}) => {
		const password = secret();
		const next = secret();
		const created = await json('POST', '/api/auth/register', {pseudo: 'Kaelth', password});
		const cookie = cookieOf(created);

		assert.equal((await json('POST', '/api/me/password', {current: secret(), next}, {Cookie: cookie})).status, 403);
		const changed = await json('POST', '/api/me/password', {current: password, next}, {Cookie: cookie});
		assert.equal(changed.status, 200);
		const fresh = cookieOf(changed);
		assert.equal((await (await json('GET', '/api/me', undefined, {Cookie: cookie})).json()).user, null);

		assert.equal((await json('DELETE', '/api/me', {password: secret()}, {Cookie: fresh})).status, 403);
		assert.equal((await json('DELETE', '/api/me', {password: next}, {Cookie: fresh})).status, 200);
		assert.equal((await json('POST', '/api/auth/login', {pseudo: 'Kaelth', password: next})).status, 401);
	});
});

test('serveur : trop de tentatives de connexion → 429', async () => {
	await withApp({loginLimit: {max: 3, windowMs: 60_000}}, async ({json}) => {
		const password = secret();
		await json('POST', '/api/auth/register', {pseudo: 'Kaelth', password});
		for (let i = 0; i < 3; i++) {
			assert.equal((await json('POST', '/api/auth/login', {pseudo: 'Kaelth', password: secret()})).status, 401);
		}
		// Même le bon mot de passe est refusé tant que le blocage dure.
		assert.equal((await json('POST', '/api/auth/login', {pseudo: 'Kaelth', password})).status, 429);
	});
});

test('serveur : trop d’inscriptions depuis une adresse → 429', async () => {
	await withApp({registerLimit: {max: 2, windowMs: 60_000}}, async ({json}) => {
		assert.equal((await json('POST', '/api/auth/register', {pseudo: 'Un', password: secret()})).status, 201);
		assert.equal((await json('POST', '/api/auth/register', {pseudo: 'Deux', password: secret()})).status, 201);
		assert.equal((await json('POST', '/api/auth/register', {pseudo: 'Trois', password: secret()})).status, 429);
	});
});

test('serveur : refuse une requête venue d’un autre site', async () => {
	await withApp({}, async ({json}) => {
		const res = await json(
			'POST',
			'/api/auth/register',
			{pseudo: 'Kaelth', password: secret()},
			{Origin: 'https://site-malveillant.example'},
		);
		assert.equal(res.status, 403);
	});
});

test('serveur : cookie « Secure » quand le site est servi en HTTPS', async () => {
	await withApp({secureCookies: true}, async ({json}) => {
		const created = await json('POST', '/api/auth/register', {pseudo: 'Kaelth', password: secret()});
		assert.match(created.headers.get('set-cookie'), /; Secure/);
	});
});
