// Espace compte : inscription, connexion, identifiants enregistrés,
// mot de passe, déconnexion, suppression.
//
// Le mot de passe n'est jamais gardé dans la page : il part au serveur,
// qui répond par un cookie de session illisible depuis le JavaScript.

import {GAMES, LIMITS} from './games.js';
import {$, el, hueOf, initials, toast} from './dom.js';

// Lu dès le chargement du module : app.js réécrit l'adresse juste après,
// et on perdrait le retour de la page de paiement (?plus=ok).
const paymentReturn = new URLSearchParams(location.search).get('plus');

const dateFr = (milliseconds) =>
	new Date(milliseconds).toLocaleDateString('fr-FR', {day: 'numeric', month: 'long', year: 'numeric'});

async function api(method, route, body) {
	let response;
	try {
		response = await fetch(route, {
			method,
			credentials: 'same-origin',
			headers: body === undefined ? {} : {'Content-Type': 'application/json'},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new Error('Serveur injoignable. Réessaie dans un instant.');
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || 'Action impossible pour l’instant.');
	return data;
}

function showError(box, message) {
	box.textContent = message;
	box.hidden = false;
}

function clearError(box) {
	box.textContent = '';
	box.hidden = true;
}

// Désactive le bouton d'envoi pendant l'appel, affiche l'erreur s'il échoue.
async function submitting(form, errorBox, work) {
	const button = form.querySelector('[type="submit"]');
	clearError(errorBox);
	button.disabled = true;
	try {
		await work();
	} catch (error) {
		showError(errorBox, error.message);
	} finally {
		button.disabled = false;
	}
}

// `onUser(user, reason)` est appelé à chaque changement :
// 'load', 'login', 'register', 'profile', 'password', 'logout', 'delete'.
export function initAccount({onUser}) {
	const dialog = $('#account-dialog');
	const button = $('#account-btn');
	let user = null;
	let billing = {enabled: false, priceLabel: null};
	let mode = 'login';

	function setUser(next, reason) {
		user = next;
		renderButton();
		renderView();
		onUser(user, reason);
	}

	function renderButton() {
		button.textContent = user ? user.pseudo : 'Connexion';
		button.classList.toggle('is-member', Boolean(user));
		button.classList.toggle('is-plus', Boolean(user?.plus));
		button.setAttribute('aria-label', user ? `Mon compte : ${user.pseudo}` : 'Connexion ou inscription');
	}

	function setMode(next) {
		mode = next;
		const registering = mode === 'register';
		$('#tab-login').setAttribute('aria-selected', String(!registering));
		$('#tab-register').setAttribute('aria-selected', String(registering));
		$('#a-confirm-field').hidden = !registering;
		$('#a-password-hint').hidden = !registering;
		$('#auth-note').hidden = !registering;
		$('#a-password').autocomplete = registering ? 'new-password' : 'current-password';
		$('#auth-submit').textContent = registering ? 'Créer mon compte' : 'Se connecter';
		$('#auth-intro').textContent = registering
			? 'Un compte réserve ton pseudo et garde tes identifiants de jeu d’un appareil à l’autre.'
			: 'Content de te revoir.';
		clearError($('#auth-error'));
	}

	function renderView() {
		$('#auth-view').hidden = Boolean(user);
		$('#account-view').hidden = !user;
		$('#account-title').textContent = user ? 'Mon compte' : 'Compte Team Up';
		if (!user) return;

		const avatar = $('#account-avatar');
		avatar.textContent = initials(user.pseudo);
		avatar.style.setProperty('--hue', String(hueOf(user.pseudo)));
		$('#account-pseudo').textContent = user.pseudo;
		$('#account-since').textContent = `Membre depuis le ${new Date(user.createdAt).toLocaleDateString('fr-FR', {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
		})}`;

		const fields = GAMES.map((game) => {
			const id = `p-${game.id}`;
			return el(
				'div',
				{class: 'field'},
				el('label', {for: id, text: `${game.short} · ${game.contact.label}`}),
				el('input', {
					id,
					type: 'text',
					'data-game': game.id,
					maxlength: LIMITS.contactMax,
					placeholder: game.contact.placeholder,
					autocomplete: 'off',
					spellcheck: 'false',
					value: user.profile.games[game.id]?.contact ?? '',
				}),
			);
		});
		fields.push(
			el(
				'div',
				{class: 'field'},
				el('label', {for: 'p-discord', text: 'Discord'}),
				el('input', {
					id: 'p-discord',
					type: 'text',
					maxlength: LIMITS.discordMax,
					placeholder: 'ton_pseudo',
					autocomplete: 'off',
					spellcheck: 'false',
					value: user.profile.discord ?? '',
				}),
			),
		);
		$('#profile-fields').replaceChildren(...fields);
		renderPlus();
	}

	function renderPlus() {
		const plus = Boolean(user?.plus);
		$('#plus-state').hidden = !plus;
		clearError($('#plus-error'));
		const button = $('#plus-btn');
		const info = $('#plus-info');

		if (plus) {
			info.textContent = !user.plusUntil
				? 'Ton abonnement est actif.'
				: user.cancelsAtPeriodEnd
					? `Résilié : Plus reste actif jusqu'au ${dateFr(user.plusUntil)}.`
					: `Renouvelé le ${dateFr(user.plusUntil)}.`;
			button.textContent = 'Gérer mon abonnement';
			button.disabled = !user.canManage;
			button.classList.replace('btn-primary', 'btn-ghost');
			button.classList.add('cut');
		} else {
			info.textContent = billing.enabled
				? `${billing.priceLabel || 'Abonnement mensuel'} · résiliable à tout moment.`
				: 'Bientôt disponible.';
			button.textContent = billing.enabled ? 'Passer à Plus' : 'Bientôt disponible';
			button.disabled = !billing.enabled;
			button.classList.replace('btn-ghost', 'btn-primary');
			button.classList.remove('cut');
		}
	}

	function clearSecrets() {
		for (const input of dialog.querySelectorAll('input[type="password"]')) input.value = '';
	}

	function open() {
		renderView();
		clearSecrets();
		for (const box of dialog.querySelectorAll('.form-error')) clearError(box);
		dialog.showModal();
		(user ? $('#profile-fields input') : $('#a-pseudo'))?.focus();
	}

	function close() {
		clearSecrets();
		dialog.close();
	}

	// ---------- Connexion et inscription ----------

	$('#tab-login').addEventListener('click', () => setMode('login'));
	$('#tab-register').addEventListener('click', () => setMode('register'));

	$('#auth-form').addEventListener('submit', (event) => {
		event.preventDefault();
		const form = event.currentTarget;
		const errorBox = $('#auth-error');
		const pseudo = $('#a-pseudo').value.trim();
		const password = $('#a-password').value;
		const registering = mode === 'register';

		if (pseudo.length < LIMITS.pseudoMin) {
			showError(errorBox, `Pseudo : au moins ${LIMITS.pseudoMin} caractères.`);
			$('#a-pseudo').focus();
			return;
		}
		if (registering && password.length < LIMITS.passwordMin) {
			showError(errorBox, `Mot de passe : au moins ${LIMITS.passwordMin} caractères.`);
			$('#a-password').focus();
			return;
		}
		if (registering && password !== $('#a-confirm').value) {
			showError(errorBox, 'Les deux mots de passe ne sont pas identiques.');
			$('#a-confirm').focus();
			return;
		}
		if (!password) {
			showError(errorBox, 'Entre ton mot de passe.');
			$('#a-password').focus();
			return;
		}

		submitting(form, errorBox, async () => {
			const data = await api('POST', registering ? '/api/auth/register' : '/api/auth/login', {pseudo, password});
			close();
			setUser(data.user, registering ? 'register' : 'login');
			toast(registering ? `Bienvenue, ${data.user.pseudo} ! Ton pseudo est réservé.` : `Connecté : ${data.user.pseudo}.`);
		});
	});

	// ---------- Identifiants enregistrés ----------

	$('#profile-form').addEventListener('submit', (event) => {
		event.preventDefault();
		submitting(event.currentTarget, $('#profile-error'), async () => {
			const profile = structuredClone(user.profile);
			profile.discord = $('#p-discord').value.trim();
			for (const input of document.querySelectorAll('#profile-fields [data-game]')) {
				const gameId = input.dataset.game;
				profile.games[gameId] = {note: '', criteria: {}, ...profile.games[gameId], contact: input.value.trim()};
			}
			const data = await api('PUT', '/api/me', {profile});
			setUser(data.user, 'profile');
			toast('Identifiants enregistrés.');
		});
	});

	// ---------- Mot de passe ----------

	$('#password-form').addEventListener('submit', (event) => {
		event.preventDefault();
		const errorBox = $('#password-error');
		const next = $('#pw-next').value;
		if (next.length < LIMITS.passwordMin) {
			showError(errorBox, `Nouveau mot de passe : au moins ${LIMITS.passwordMin} caractères.`);
			$('#pw-next').focus();
			return;
		}
		submitting(event.currentTarget, errorBox, async () => {
			const data = await api('POST', '/api/me/password', {current: $('#pw-current').value, next});
			clearSecrets();
			$('#password-details').open = false;
			setUser(data.user, 'password');
			toast('Mot de passe changé. Tes autres appareils sont déconnectés.');
		});
	});

	// ---------- Déconnexion et suppression ----------

	$('#logout-btn').addEventListener('click', async () => {
		try {
			await api('POST', '/api/auth/logout');
		} catch {
			// Hors ligne : on oublie quand même le compte dans cette page.
		}
		close();
		setUser(null, 'logout');
		toast('Tu es déconnecté.');
	});

	$('#delete-form').addEventListener('submit', (event) => {
		event.preventDefault();
		submitting(event.currentTarget, $('#delete-error'), async () => {
			await api('DELETE', '/api/me', {password: $('#del-password').value});
			close();
			setUser(null, 'delete');
			toast('Ton compte est supprimé.');
		});
	});

	// ---------- Plus ----------

	$('#plus-btn').addEventListener('click', () => {
		const route = user.plus ? '/api/billing/portal' : '/api/billing/checkout';
		const errorBox = $('#plus-error');
		const button = $('#plus-btn');
		clearError(errorBox);
		button.disabled = true;
		api('POST', route)
			.then((data) => {
				// Seule une page Stripe est acceptée comme destination.
				const target = new URL(data.url);
				if (target.protocol !== 'https:' || !target.hostname.endsWith('stripe.com')) {
					throw new Error('Réponse inattendue du serveur.');
				}
				location.assign(target.href);
			})
			.catch((error) => {
				showError(errorBox, error.message);
				button.disabled = false;
			});
	});

	// Au retour de la page de paiement, Stripe prévient le serveur de son côté :
	// on attend quelques secondes que Plus apparaisse sur le compte.
	async function waitForPlus() {
		toast('Paiement reçu, activation de Plus…');
		for (let attempt = 0; attempt < 12; attempt++) {
			try {
				const data = await api('GET', '/api/me');
				if (data.user?.plus) {
					billing = data.billing ?? billing;
					setUser(data.user, 'plus');
					toast('Bienvenue dans Team Up Plus !');
					return;
				}
			} catch {
				// réseau instable : on réessaie
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		toast('Ton paiement est en cours de traitement. Recharge la page dans un instant.', true);
	}

	// ---------- Fenêtre ----------

	button.addEventListener('click', open);
	$('#account-close').addEventListener('click', close);
	dialog.addEventListener('click', (event) => {
		// Un clic sur le fond (hors de la boîte) ferme la fenêtre.
		if (event.target === dialog) close();
	});
	dialog.addEventListener('close', clearSecrets);

	setMode('login');
	renderButton();

	const ready = api('GET', '/api/me')
		.then((data) => {
			billing = data.billing ?? billing;
			setUser(data.user, 'load');
		})
		.catch(() => setUser(null, 'load'))
		.then(() => {
			if (paymentReturn === 'ok') {
				if (user) waitForPlus();
				else toast('Connecte-toi pour retrouver ton abonnement Plus.');
			} else if (paymentReturn === 'annule') {
				toast('Paiement annulé. Tu peux réessayer quand tu veux.');
			}
		});

	return {
		ready,
		get user() {
			return user;
		},
		open,
		// Enregistre le profil sans bruit (après une publication, par exemple).
		async saveProfile(profile) {
			if (!user) return;
			try {
				user = (await api('PUT', '/api/me', {profile})).user;
				if (!dialog.open) renderView();
			} catch {
				// Pas grave : le profil reste gardé dans ce navigateur.
			}
		},
	};
}
