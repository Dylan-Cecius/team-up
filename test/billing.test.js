import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, randomBytes} from 'node:crypto';
import {BillingError, createBilling, toUpdate} from '../lib/billing.js';
import {createAccounts} from '../lib/accounts.js';
import {createApp} from '../server.js';

// Tout est faux ici : jamais d'appel réseau, jamais de vraie clé.
const rand = (prefix) => `${prefix}-${randomBytes(9).toString('base64url')}`;
const SECRET = rand('whsec-test');
const now = () => Math.floor(Date.now() / 1000);

const sign = (body, secret = SECRET, timestamp = now()) =>
	`t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

function fakeStripe() {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({url, init, params: Object.fromEntries(new URLSearchParams(String(init.body)))});
		if (url.endsWith('/checkout/sessions')) {
			return Response.json({id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1'});
		}
		if (url.endsWith('/billing_portal/sessions')) {
			return Response.json({url: 'https://billing.stripe.com/p/session/test_1'});
		}
		return Response.json({error: {message: 'message interne de Stripe'}}, {status: 404});
	};
	return {calls, fetchImpl};
}

function makeBilling(over = {}) {
	const stripe = fakeStripe();
	const billing = createBilling({
		secretKey: rand('sk-test'),
		priceId: 'price_test',
		webhookSecret: SECRET,
		siteUrl: 'http://localhost:3210/',
		priceLabel: '2,99 € / mois',
		fetchImpl: stripe.fetchImpl,
		...over,
	});
	return {billing, stripe};
}

const checkoutEvent = (userId, over = {}) => ({
	id: 'evt_checkout',
	type: 'checkout.session.completed',
	data: {
		object: {
			mode: 'subscription',
			client_reference_id: userId,
			customer: 'cus_test_1',
			subscription: 'sub_test_1',
			payment_status: 'paid',
			...over,
		},
	},
});

const subscriptionEvent = (type, over = {}) => ({
	id: 'evt_subscription',
	type,
	data: {
		object: {
			id: 'sub_test_1',
			customer: 'cus_test_1',
			status: 'active',
			cancel_at_period_end: false,
			current_period_end: now() + 30 * 86400,
			metadata: {},
			...over,
		},
	},
});

// ---------- Signature des webhooks ----------

test('webhook : une signature valide est acceptée', () => {
	const {billing} = makeBilling();
	const body = JSON.stringify(checkoutEvent('u1'));
	assert.equal(billing.verifyEvent(body, sign(body)).type, 'checkout.session.completed');
	assert.equal(billing.verifyEvent(Buffer.from(body), sign(body)).id, 'evt_checkout');
});

test('webhook : corps modifié, mauvais secret, en-tête absent ou abîmé → refusé', () => {
	const {billing} = makeBilling();
	const body = JSON.stringify(checkoutEvent('u1'));
	const header = sign(body);
	const refuses = (value, signature) =>
		assert.throws(() => billing.verifyEvent(value, signature), BillingError, String(signature).slice(0, 30));

	refuses(body.replace('u1', 'u2'), header);
	refuses(body, sign(body, rand('autre-secret')));
	refuses(body, undefined);
	refuses(body, '');
	refuses(body, 'n’importe quoi');
	refuses(body, `t=${now()}`);
	refuses(body, `t=${now()},v1=pasdelhex`);
	refuses(body, `t=${now()},v1=${'0'.repeat(64)}`);
	refuses(body, header.replace(/^t=\d+/, 't=abc'));
});

test('webhook : un ancien envoi rejoué est refusé, un léger décalage d’horloge est toléré', () => {
	const {billing} = makeBilling();
	const body = JSON.stringify(checkoutEvent('u1'));
	assert.throws(() => billing.verifyEvent(body, sign(body, SECRET, now() - 3600)), /ancienne/);
	assert.throws(() => billing.verifyEvent(body, sign(body, SECRET, now() + 3600)), /ancienne/);
	assert.ok(billing.verifyEvent(body, sign(body, SECRET, now() - 60)));
});

test('webhook : une seule bonne signature parmi plusieurs suffit', () => {
	const {billing} = makeBilling();
	const body = JSON.stringify(checkoutEvent('u1'));
	const t = now();
	const good = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
	assert.ok(billing.verifyEvent(body, `t=${t},v1=${'a'.repeat(64)},v1=${good}`));
});

test('webhook : une signature valide sur du JSON cassé est refusée', () => {
	const {billing} = makeBilling();
	const body = '{pas du json';
	assert.throws(() => billing.verifyEvent(body, sign(body)), BillingError);
});

// ---------- Appels à Stripe ----------

test('l’abonnement n’est ouvert que si tous les réglages sont là', async () => {
	assert.equal(createBilling({}).enabled, false);
	for (const missing of ['secretKey', 'priceId', 'webhookSecret', 'siteUrl']) {
		assert.equal(makeBilling({[missing]: undefined}).billing.enabled, false, missing);
	}
	assert.equal(makeBilling({siteUrl: 'localhost:3210'}).billing.enabled, false);
	assert.equal(makeBilling().billing.enabled, true);
	await assert.rejects(createBilling({}).createCheckout({userId: 'u1'}), BillingError);
});

test('checkout : envoie le bon abonnement, rattaché au compte', async () => {
	const {billing, stripe} = makeBilling();
	const url = await billing.createCheckout({userId: 'u1'});
	assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_test_1');

	const [call] = stripe.calls;
	assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
	assert.match(call.init.headers.Authorization, /^Bearer sk-test-/);
	assert.equal(call.params.mode, 'subscription');
	assert.equal(call.params['line_items[0][price]'], 'price_test');
	assert.equal(call.params.client_reference_id, 'u1');
	assert.equal(call.params['subscription_data[metadata][user_id]'], 'u1');
	assert.equal(call.params.success_url, 'http://localhost:3210/?plus=ok');
	assert.equal(call.params.cancel_url, 'http://localhost:3210/?plus=annule');
	assert.equal('customer' in call.params, false);

	await billing.createCheckout({userId: 'u1', customerId: 'cus_test_1'});
	assert.equal(stripe.calls[1].params.customer, 'cus_test_1');
});

test('portail : ouvre la page de gestion du client', async () => {
	const {billing, stripe} = makeBilling();
	assert.equal(await billing.createPortal({customerId: 'cus_test_1'}), 'https://billing.stripe.com/p/session/test_1');
	assert.equal(stripe.calls[0].params.customer, 'cus_test_1');
	assert.equal(stripe.calls[0].params.return_url, 'http://localhost:3210/');
});

test('un refus de Stripe ne laisse pas fuiter son message', async () => {
	const {billing} = makeBilling({fetchImpl: async () => Response.json({error: {message: 'secret interne'}}, {status: 400})});
	const originalError = console.error;
	console.error = () => {};
	try {
		await assert.rejects(billing.createCheckout({userId: 'u1'}), (error) => {
			assert.ok(error instanceof BillingError);
			assert.equal(error.message.includes('secret interne'), false);
			return true;
		});
	} finally {
		console.error = originalError;
	}
});

test('on ne redirige jamais vers une page qui n’est pas chez Stripe', async () => {
	for (const url of ['https://pirate.example/pay', 'http://checkout.stripe.com/x', 'https://stripe.com.pirate.example/x', 'javascript:alert(1)', '']) {
		const {billing} = makeBilling({fetchImpl: async () => Response.json({url})});
		await assert.rejects(billing.createCheckout({userId: 'u1'}), BillingError, url);
	}
	const {billing} = makeBilling({fetchImpl: async () => Response.json({url: 'https://billing.stripe.com/ok'})});
	assert.ok(await billing.createCheckout({userId: 'u1'}));
});

test('Stripe injoignable : erreur claire, pas de plantage', async () => {
	const {billing} = makeBilling({
		fetchImpl: async () => {
			throw new TypeError('fetch failed');
		},
	});
	await assert.rejects(billing.createCheckout({userId: 'u1'}), /injoignable/);
});

// ---------- Lecture des événements ----------

test('toUpdate : paiement terminé', () => {
	assert.deepEqual(toUpdate(checkoutEvent('u1')), {
		kind: 'checkout',
		userId: 'u1',
		customerId: 'cus_test_1',
		subscriptionId: 'sub_test_1',
		paid: true,
	});
	assert.equal(toUpdate(checkoutEvent('u1', {payment_status: 'unpaid'})).paid, false);
	assert.equal(toUpdate(checkoutEvent('u1', {mode: 'payment'})), null);
	assert.equal(toUpdate(checkoutEvent(undefined)), null);
});

test('toUpdate : abonnement, dont la date de fin placée sur les lignes (API récente)', () => {
	const seconds = now() + 1000;
	const direct = toUpdate(subscriptionEvent('customer.subscription.updated', {current_period_end: seconds}));
	assert.equal(direct.currentPeriodEnd, seconds * 1000);

	const nested = toUpdate(
		subscriptionEvent('customer.subscription.updated', {
			current_period_end: undefined,
			items: {data: [{current_period_end: seconds}]},
		}),
	);
	assert.equal(nested.currentPeriodEnd, seconds * 1000);

	const withUser = toUpdate(subscriptionEvent('customer.subscription.created', {metadata: {user_id: 'u1'}}));
	assert.equal(withUser.userId, 'u1');
});

test('toUpdate : la suppression force le statut « canceled », le reste est ignoré', () => {
	assert.equal(toUpdate(subscriptionEvent('customer.subscription.deleted', {status: 'active'})).status, 'canceled');
	assert.equal(toUpdate({type: 'invoice.paid', data: {object: {}}}), null);
	assert.equal(toUpdate({type: 'customer.subscription.updated'}), null);
	assert.equal(toUpdate(null), null);
});

// ---------- Cycle de vie d'un abonnement sur un compte ----------

async function memberWithAccounts() {
	const accounts = createAccounts();
	const {token} = await accounts.register('Kaelth', rand('mdp-test'));
	return {accounts, user: accounts.authenticate(token), token};
}

test('compte : le paiement active Plus, la résiliation programmée le garde jusqu’à la fin', async () => {
	const {accounts, user, token} = await memberWithAccounts();
	assert.equal(user.plus, false);

	accounts.applyBilling(toUpdate(checkoutEvent(user.id)));
	assert.equal(accounts.authenticate(token).plus, true);
	assert.equal(accounts.authenticate(token).canManage, true);

	const end = now() + 10 * 86400;
	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.updated', {cancel_at_period_end: true, current_period_end: end})));
	const cancelling = accounts.authenticate(token);
	assert.equal(cancelling.plus, true, 'payé jusqu’à la fin de la période');
	assert.equal(cancelling.cancelsAtPeriodEnd, true);
	assert.equal(cancelling.plusUntil, end * 1000);

	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.deleted')));
	const ended = accounts.authenticate(token);
	assert.equal(ended.plus, false);
	assert.equal(ended.plusUntil, null);
	assert.equal(ended.canManage, true, 'le client garde accès à ses factures');
});

test('compte : un paiement non abouti, un impayé ou une résiliation ne donnent pas Plus', async () => {
	const {accounts, user, token} = await memberWithAccounts();
	accounts.applyBilling(toUpdate(checkoutEvent(user.id, {payment_status: 'unpaid'})));
	assert.equal(accounts.authenticate(token).plus, false);
	for (const status of ['past_due', 'unpaid', 'incomplete', 'canceled', 'paused']) {
		accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.updated', {status})));
		assert.equal(accounts.authenticate(token).plus, false, status);
	}
	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.updated', {status: 'trialing'})));
	assert.equal(accounts.authenticate(token).plus, true, 'l’essai gratuit compte');
});

test('compte : le même événement reçu deux fois donne le même résultat', async () => {
	const {accounts, user, token} = await memberWithAccounts();
	const update = toUpdate(checkoutEvent(user.id));
	accounts.applyBilling(update);
	accounts.applyBilling(update);
	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.updated')));
	accounts.applyBilling(update); // le paiement arrive en retard : il n'écrase pas l'état plus précis
	assert.equal(accounts.authenticate(token).plus, true);
	assert.equal(accounts.authenticate(token).plusUntil > Date.now(), true);
});

test('compte : l’événement d’un ancien abonnement ne coupe pas le nouveau', async () => {
	const {accounts, user, token} = await memberWithAccounts();
	accounts.applyBilling(toUpdate(checkoutEvent(user.id)));
	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.deleted')));
	assert.equal(accounts.authenticate(token).plus, false);

	accounts.applyBilling(toUpdate(checkoutEvent(user.id, {subscription: 'sub_test_2'})));
	assert.equal(accounts.authenticate(token).plus, true);
	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.deleted', {id: 'sub_test_1'})));
	assert.equal(accounts.authenticate(token).plus, true, 'l’ancien abonnement résilié tardivement');
});

test('compte : retrouvé par client Stripe quand l’événement n’a pas l’identifiant du compte', async () => {
	const {accounts, user, token} = await memberWithAccounts();
	accounts.applyBilling(toUpdate(checkoutEvent(user.id)));
	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.deleted')));
	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.updated', {id: 'sub_test_3', metadata: {}})));
	assert.equal(accounts.authenticate(token).plus, true);
	assert.equal(accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.updated', {customer: 'cus_inconnu', metadata: {}}))), null);
	assert.equal(accounts.applyBilling(toUpdate(checkoutEvent('compte-inexistant', {customer: 'cus_autre'}))), null);
});

test('compte : impossible de supprimer son compte tant que l’abonnement court', async () => {
	const accounts = createAccounts();
	const password = rand('mdp-test');
	const {token} = await accounts.register('Kaelth', password);
	const user = accounts.authenticate(token);
	accounts.applyBilling(toUpdate(checkoutEvent(user.id)));

	const blocked = await accounts.remove(user.id, password);
	assert.equal(blocked.status, 409);
	assert.match(blocked.error, /Résilie/);
	assert.equal(accounts.isTaken('Kaelth'), true);

	accounts.applyBilling(toUpdate(subscriptionEvent('customer.subscription.updated', {cancel_at_period_end: true})));
	assert.equal((await accounts.remove(user.id, password)).ok, true, 'résiliation déjà programmée : plus de prélèvement à venir');
});

test('compte : le statut de paiement survit à un redémarrage sans exposer l’identifiant client', async () => {
	const {mkdtempSync, readFileSync, rmSync} = await import('node:fs');
	const {tmpdir} = await import('node:os');
	const path = await import('node:path');
	const dir = mkdtempSync(path.join(tmpdir(), 'teamup-plus-'));
	const file = path.join(dir, 'accounts.json');
	try {
		const first = createAccounts({file});
		const {token} = await first.register('Kaelth', rand('mdp-test'));
		first.applyBilling(toUpdate(checkoutEvent(first.authenticate(token).id)));
		await first.flush();

		const second = createAccounts({file});
		const user = second.authenticate(token);
		assert.equal(user.plus, true);
		assert.equal(JSON.stringify(user).includes('cus_test_1'), false);
		assert.equal(readFileSync(file, 'utf8').includes('cus_test_1'), true);
		await second.flush();
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

// ---------- Par le serveur ----------

async function withApp(billingOptions, run) {
	const {billing, stripe} = makeBilling(billingOptions);
	const server = createApp({billing, postIntervalMs: 0});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = (method, route, {body, headers = {}} = {}) =>
		fetch(base + route, {
			method,
			headers: {...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
			body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
		});
	const webhook = (event, signature) => {
		const body = JSON.stringify(event);
		return call('POST', '/api/billing/webhook', {body, headers: {'Stripe-Signature': signature ?? sign(body)}});
	};
	const register = async (pseudo = 'Kaelth') => {
		const res = await call('POST', '/api/auth/register', {body: {pseudo, password: rand('mdp-test')}});
		return res.headers.get('set-cookie').split(';')[0];
	};
	try {
		await run({base, call, webhook, register, stripe});
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

const me = async (call, cookie) => (await call('GET', '/api/me', {headers: {Cookie: cookie}})).json();

test('serveur : parcours complet d’un abonnement', async () => {
	await withApp({}, async ({call, webhook, register, stripe}) => {
		const cookie = await register();
		const before = await me(call, cookie);
		assert.equal(before.user.plus, false);
		assert.deepEqual(before.billing, {enabled: true, priceLabel: '2,99 € / mois'});
		assert.equal('id' in before.user, false, 'l’identifiant interne ne sort pas');

		const checkout = await call('POST', '/api/billing/checkout', {headers: {Cookie: cookie}});
		assert.equal(checkout.status, 200);
		assert.equal((await checkout.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_1');
		const userId = stripe.calls[0].params.client_reference_id;

		// Revenir de la page de paiement ne suffit pas : seul le webhook active Plus.
		assert.equal((await me(call, cookie)).user.plus, false);

		assert.equal((await webhook(checkoutEvent(userId))).status, 200);
		const after = await me(call, cookie);
		assert.equal(after.user.plus, true);
		assert.equal(JSON.stringify(after).includes('cus_test_1'), false);

		assert.equal((await call('POST', '/api/billing/checkout', {headers: {Cookie: cookie}})).status, 409, 'déjà abonné');

		const portal = await call('POST', '/api/billing/portal', {headers: {Cookie: cookie}});
		assert.equal((await portal.json()).url, 'https://billing.stripe.com/p/session/test_1');

		await webhook(subscriptionEvent('customer.subscription.deleted'));
		assert.equal((await me(call, cookie)).user.plus, false);
	});
});

test('serveur : webhook refusé sans signature valide, rien ne change', async () => {
	await withApp({}, async ({call, webhook, register, stripe}) => {
		const cookie = await register();
		await call('POST', '/api/billing/checkout', {headers: {Cookie: cookie}});
		const userId = stripe.calls[0].params.client_reference_id;
		const event = checkoutEvent(userId);

		assert.equal((await webhook(event, 'nimporte-quoi')).status, 400);
		const body = JSON.stringify(event);
		assert.equal((await webhook(event, sign(body, rand('faux-secret')))).status, 400);
		assert.equal((await webhook(event, sign(body, SECRET, now() - 3600))).status, 400);
		assert.equal((await call('POST', '/api/billing/webhook', {body})).status, 400);
		assert.equal((await me(call, cookie)).user.plus, false);
	});
});

test('serveur : webhook trop gros → 413, événement inconnu → 200 sans effet', async () => {
	await withApp({}, async ({call, webhook, register}) => {
		const cookie = await register();
		const huge = 'x'.repeat(300_000);
		const big = await call('POST', '/api/billing/webhook', {body: huge, headers: {'Stripe-Signature': sign(huge)}});
		assert.equal(big.status, 413);
		assert.equal((await webhook({id: 'evt_x', type: 'invoice.paid', data: {object: {}}})).status, 200);
		assert.equal((await me(call, cookie)).user.plus, false);
	});
});

test('serveur : paiement et portail demandent d’être connecté, et un abonnement à gérer', async () => {
	await withApp({}, async ({call, register}) => {
		assert.equal((await call('POST', '/api/billing/checkout')).status, 401);
		assert.equal((await call('POST', '/api/billing/portal')).status, 401);
		const cookie = await register();
		assert.equal((await call('POST', '/api/billing/portal', {headers: {Cookie: cookie}})).status, 409);
	});
});

test('serveur : Stripe en panne → 502 avec un message neutre', async () => {
	const failing = async () => Response.json({error: {message: 'détail interne'}}, {status: 500});
	const originalError = console.error;
	console.error = () => {};
	try {
		await withApp({fetchImpl: failing}, async ({call, register}) => {
			const cookie = await register();
			const res = await call('POST', '/api/billing/checkout', {headers: {Cookie: cookie}});
			assert.equal(res.status, 502);
			assert.equal(JSON.stringify(await res.json()).includes('détail interne'), false);
		});
	} finally {
		console.error = originalError;
	}
});

test('serveur : trop de demandes de paiement → 429', async () => {
	await withApp({}, async ({call, register}) => {
		const cookie = await register();
		let last;
		for (let i = 0; i < 11; i++) last = await call('POST', '/api/billing/checkout', {headers: {Cookie: cookie}});
		assert.equal(last.status, 429);
	});
});

test('serveur : sans réglages Stripe, tout est fermé', async () => {
	const server = createApp({postIntervalMs: 0});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const registered = await fetch(`${base}/api/auth/register`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({pseudo: 'Kaelth', password: rand('mdp-test')}),
		});
		const cookie = registered.headers.get('set-cookie').split(';')[0];
		assert.equal((await fetch(`${base}/api/billing/checkout`, {method: 'POST', headers: {Cookie: cookie}})).status, 503);
		assert.equal((await fetch(`${base}/api/billing/webhook`, {method: 'POST', body: '{}'})).status, 503);
		const info = await (await fetch(`${base}/api/me`, {headers: {Cookie: cookie}})).json();
		assert.equal(info.billing.enabled, false);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test('serveur : l’annonce d’un abonné porte le drapeau Plus, pas celle d’un autre', async () => {
	await withApp({}, async ({base, call, webhook, register, stripe}) => {
		const plusCookie = await register('Abonne');
		const freeCookie = await register('Gratuit');
		await call('POST', '/api/billing/checkout', {headers: {Cookie: plusCookie}});
		await webhook(checkoutEvent(stripe.calls[0].params.client_reference_id));

		const publish = async (cookie) => {
			const controller = new AbortController();
			const stream = await fetch(`${base}/api/stream`, {signal: controller.signal});
			const reader = stream.body.getReader();
			const {value} = await reader.read();
			const token = /"token":"([0-9a-f]+)"/.exec(new TextDecoder().decode(value))[1];
			const res = await call('POST', '/api/listing', {
				headers: {Cookie: cookie, 'X-Session': token},
				body: {
					game: 'lol',
					pseudo: 'ignoré',
					contact: 'Contact#EUW',
					lang: 'Français',
					mic: true,
					criteria: {rank: 'Or', role: 'Mid', region: 'EUW', mode: 'ARAM'},
				},
			});
			const {listing} = await res.json();
			return {listing, close: () => controller.abort()};
		};

		const plus = await publish(plusCookie);
		const free = await publish(freeCookie);
		assert.equal(plus.listing.plus, true);
		assert.equal(plus.listing.member, true);
		assert.equal('plus' in free.listing, false);
		plus.close();
		free.close();
	});
});
