// Abonnement Plus via Stripe Checkout. Aucune dépendance : on parle à l'API
// Stripe avec fetch et on vérifie la signature des webhooks à la main.
//
// L'abonnement n'est ouvert que si les quatre réglages sont présents
// (clé secrète, prix, secret du webhook, adresse du site). Sinon `enabled`
// vaut false et toutes les routes de paiement répondent « pas encore ouvert ».

import {createHmac, timingSafeEqual} from 'node:crypto';

const API = 'https://api.stripe.com/v1';
const TOLERANCE_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 10_000;

export class BillingError extends Error {}

const text = (value) => (typeof value === 'string' && value ? value : null);

export function createBilling({
	secretKey,
	priceId,
	webhookSecret,
	siteUrl,
	priceLabel = null,
	fetchImpl = globalThis.fetch,
} = {}) {
	const base = typeof siteUrl === 'string' ? siteUrl.trim().replace(/\/+$/, '') : '';
	const enabled = Boolean(secretKey && priceId && webhookSecret && /^https?:\/\/[^/\s]+$/.test(base));

	async function call(route, params) {
		let response;
		try {
			response = await fetchImpl(`${API}${route}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${secretKey}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams(params),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new BillingError('Stripe est injoignable.');
		}
		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			// Le message de Stripe reste côté serveur (journal), jamais renvoyé au navigateur.
			console.error(`Team Up : Stripe a refusé ${route} (${response.status}) :`, data?.error?.message ?? 'sans détail');
			throw new BillingError('Stripe a refusé la demande.');
		}
		return data;
	}

	// On ne redirige le navigateur que vers une page Stripe.
	function stripePage(value) {
		let url;
		try {
			url = new URL(value);
		} catch {
			throw new BillingError('Réponse de Stripe inattendue.');
		}
		if (url.protocol !== 'https:' || !(url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))) {
			throw new BillingError('Réponse de Stripe inattendue.');
		}
		return url.href;
	}

	return {
		enabled,
		priceLabel,

		// Ouvre une page de paiement pour l'abonnement. Renvoie son adresse.
		async createCheckout({userId, customerId = null}) {
			if (!enabled) throw new BillingError('Abonnements désactivés.');
			const params = {
				mode: 'subscription',
				'line_items[0][price]': priceId,
				'line_items[0][quantity]': '1',
				success_url: `${base}/?plus=ok`,
				cancel_url: `${base}/?plus=annule`,
				client_reference_id: userId,
				'subscription_data[metadata][user_id]': userId,
				allow_promotion_codes: 'true',
				locale: 'fr',
			};
			if (customerId) params.customer = customerId;
			const session = await call('/checkout/sessions', params);
			return stripePage(session.url);
		},

		// Page où l'abonné change sa carte, télécharge ses factures ou résilie.
		async createPortal({customerId}) {
			if (!enabled) throw new BillingError('Abonnements désactivés.');
			const session = await call('/billing_portal/sessions', {customer: customerId, return_url: `${base}/`});
			return stripePage(session.url);
		},

		// Vérifie la signature d'un webhook et renvoie l'événement.
		// `rawBody` doit être le corps exact reçu, octet pour octet.
		verifyEvent(rawBody, header, now = Date.now()) {
			if (!webhookSecret) throw new BillingError('Webhook non configuré.');
			const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');

			let timestamp = null;
			const signatures = [];
			for (const part of String(header ?? '').split(',')) {
				const cut = part.indexOf('=');
				if (cut < 0) continue;
				const key = part.slice(0, cut).trim();
				const value = part.slice(cut + 1).trim();
				if (key === 't') timestamp = value;
				else if (key === 'v1') signatures.push(value);
			}
			if (!/^\d{1,12}$/.test(timestamp ?? '') || signatures.length === 0) {
				throw new BillingError('Signature absente ou illisible.');
			}
			if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
				throw new BillingError('Signature trop ancienne.');
			}

			const expected = createHmac('sha256', webhookSecret)
				.update(Buffer.concat([Buffer.from(`${timestamp}.`), raw]))
				.digest();
			const valid = signatures.some(
				(signature) => /^[0-9a-f]{64}$/i.test(signature) && timingSafeEqual(Buffer.from(signature, 'hex'), expected),
			);
			if (!valid) throw new BillingError('Signature invalide.');

			try {
				return JSON.parse(raw.toString('utf8'));
			} catch {
				throw new BillingError('Événement illisible.');
			}
		},
	};
}

const periodEnd = (subscription) => {
	// Selon la version de l'API Stripe, la date est sur l'abonnement ou sur ses lignes.
	const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
	return typeof seconds === 'number' ? seconds * 1000 : null;
};

// Réduit un événement Stripe à ce dont les comptes ont besoin, ou null
// pour tous les événements qui ne nous concernent pas.
export function toUpdate(event) {
	const object = event?.data?.object;
	if (!object || typeof object !== 'object') return null;

	switch (event.type) {
		case 'checkout.session.completed':
			if (object.mode !== 'subscription' || !text(object.client_reference_id)) return null;
			return {
				kind: 'checkout',
				userId: object.client_reference_id,
				customerId: text(object.customer),
				subscriptionId: text(object.subscription),
				paid: object.payment_status === 'paid' || object.payment_status === 'no_payment_required',
			};
		case 'customer.subscription.created':
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted':
			if (!text(object.id)) return null;
			return {
				kind: 'subscription',
				userId: text(object.metadata?.user_id),
				customerId: text(object.customer),
				subscriptionId: object.id,
				status: event.type === 'customer.subscription.deleted' ? 'canceled' : text(object.status),
				currentPeriodEnd: periodEnd(object),
				cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
			};
		default:
			return null;
	}
}
