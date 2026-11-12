// Team Up — interface.
// Tout contenu venant d'un joueur est inséré avec textContent, jamais en HTML.

import {GAMES, LANGS, LIMITS, getGame} from './games.js';
import {compatibility} from './compat.js';
import {$, el, hueOf, initials, toast} from './dom.js';
import {initAccount} from './account.js';

// ---------- Mémoire locale (pseudo, critères, annonce active) ----------

const STORAGE_KEY = 'teamup:v1';

function loadSaved() {
	const defaults = {pseudo: '', lang: LANGS[0], mic: false, discord: '', alerts: false, games: {}, lastGame: null};
	try {
		const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			const merged = {...defaults, ...data};
			if (!merged.games || typeof merged.games !== 'object') merged.games = {};
			return merged;
		}
	} catch {
		// stockage indisponible ou contenu abîmé : on repart de zéro
	}
	return defaults;
}

const saved = loadSaved();

function persist() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
	} catch {
		// navigation privée ou stockage plein : le site marche quand même
	}
}

// Le jeu de l'annonce en ligne est retenu par onglet (sessionStorage) :
// un rechargement la republie, mais un second onglet reste un autre joueur.
const ACTIVE_KEY = 'teamup:active';

function getActive() {
	try {
		return sessionStorage.getItem(ACTIVE_KEY);
	} catch {
		return null;
	}
}

function setActive(gameId) {
	try {
		if (gameId) sessionStorage.setItem(ACTIVE_KEY, gameId);
		else sessionStorage.removeItem(ACTIVE_KEY);
	} catch {
		// stockage indisponible : l'annonce ne survivra pas à un rechargement
	}
}

// ---------- État ----------

const state = {
	token: null,
	connected: false,
	online: 0,
	listings: [],
	clockOffset: 0, // horloge du navigateur moins horloge du serveur
	game: null,
	mine: null, // mon annonce telle que le serveur l'a acceptée
	filters: {},
	busy: false,
	user: null, // compte connecté, ou null
};

// ---------- Petits outils ----------

function ago(since) {
	const seconds = Math.max(0, (Date.now() - state.clockOffset - since) / 1000);
	if (seconds < 60) return 'à l’instant';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `il y a ${minutes} min`;
	return `il y a ${Math.floor(minutes / 60)} h`;
}

const plural = (count, one, many) => (count > 1 ? many : one);

function formatValue(field, value) {
	return field.prefix ? `${field.prefix}${value}` : String(value);
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Presse-papiers refusé : on tente l'ancienne méthode.
		const area = el('textarea', {value: text, readonly: true, 'aria-hidden': 'true', tabindex: '-1'});
		area.className = 'skip-link';
		document.body.append(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} catch {
			ok = false;
		}
		area.remove();
		return ok;
	}
}

// Logo d'un jeu, ou sa lettre s'il n'a pas de fichier (ou s'il ne charge pas).
function gameLogo(game, className) {
	const letter = () => {
		const mark = el('span', {class: 'mono', 'aria-hidden': 'true', text: game.mono});
		mark.style.setProperty('--tile', game.color);
		return mark;
	};
	const box = el('span', {class: className, 'aria-hidden': 'true'});
	if (!game.logo) {
		box.append(letter());
		return box;
	}
	const image = el('img', {src: game.logo, alt: '', decoding: 'async'});
	image.addEventListener('error', () => box.replaceChildren(letter()));
	box.append(image);
	return box;
}

// ---------- Choix du jeu ----------

const tiles = new Map(); // id du jeu -> {button, count}

function buildGameTiles() {
	const grid = $('#game-grid');
	for (const game of GAMES) {
		const count = el('span', {class: 'game-count is-zero'});
		const mono = gameLogo(game, 'game-logo');
		const button = el(
			'button',
			{class: 'game-tile cut', type: 'button', 'aria-pressed': 'false'},
			mono,
			el('span', {class: 'game-name', text: game.name}),
			el('span', {class: 'game-tagline', text: game.tagline}),
			count,
		);
		button.style.setProperty('--tile', game.color);
		button.addEventListener('click', () => selectGame(game.id, {scroll: true}));
		tiles.set(game.id, {button, count});
		grid.append(button);
	}
}

function renderGameTiles() {
	const counts = new Map();
	for (const listing of state.listings) counts.set(listing.game, (counts.get(listing.game) ?? 0) + 1);

	for (const [id, tile] of tiles) {
		const n = counts.get(id) ?? 0;
		tile.button.setAttribute('aria-pressed', String(state.game?.id === id));
		tile.count.classList.toggle('is-zero', n === 0);
		tile.count.replaceChildren(
			...(n > 0 ? [el('span', {class: 'pulse', 'aria-hidden': 'true'})] : []),
			n > 0 ? `${n} ${plural(n, 'joueur cherche', 'joueurs cherchent')}` : 'Personne pour l’instant',
		);
	}
}

function selectGame(id, {scroll = false} = {}) {
	const game = getGame(id) ?? GAMES[0];
	state.game = game;
	state.filters = {};
	saved.lastGame = game.id;
	persist();

	document.documentElement.style.setProperty('--game', game.color);
	try {
		history.replaceState(null, '', `?jeu=${game.id}`);
	} catch {
		// certaines intégrations interdisent de toucher à l'historique
	}

	cardCache.clear();
	$('#cards').replaceChildren();

	renderGameTiles();
	buildForm();
	buildFilters();
	renderStatus();
	renderBoard();

	if (scroll) $('#salon').scrollIntoView({block: 'start'});
}

// ---------- Formulaire ----------

function criterionControl(field, value) {
	const id = `c-${field.id}`;

	// Deux ou trois choix : des pastilles, plus rapides qu'une liste.
	if (field.type === 'select' && field.options.length <= 3) {
		const labelId = `${id}-label`;
		const pills = el('div', {class: 'pills', role: 'radiogroup', 'aria-labelledby': labelId, 'data-field': field.id});
		for (const option of field.options) {
			pills.append(
				el(
					'label',
					{class: 'pill'},
					el('input', {type: 'radio', name: id, value: option, checked: option === value}),
					el('span', {text: option}),
				),
			);
		}
		return el(
			'div',
			{class: field.options.length === 3 ? 'field is-wide' : 'field'},
			el('span', {class: 'label', id: labelId, text: field.label}),
			pills,
		);
	}

	let control;
	if (field.type === 'select') {
		control = el('select', {id, 'data-field': field.id}, el('option', {value: '', text: 'Choisir…'}));
		for (const option of field.options) control.append(el('option', {value: option, text: option}));
		control.value = field.options.includes(value) ? value : '';
	} else if (field.type === 'number') {
		control = el('input', {
			id,
			'data-field': field.id,
			type: 'number',
			inputmode: 'numeric',
			min: field.min,
			max: field.max,
			step: 1,
			placeholder: `${field.min} à ${field.max}`,
			value: value ?? '',
		});
	} else {
		const listId = `${id}-list`;
		control = el('input', {
			id,
			'data-field': field.id,
			type: 'text',
			maxlength: field.maxLength ?? 30,
			placeholder: field.placeholder ?? '',
			autocomplete: 'off',
			spellcheck: 'false',
			list: field.suggestions ? listId : null,
			value: value ?? '',
		});
		const wrapper = el('div', {class: 'field'}, el('label', {for: id, text: field.label}), control);
		if (field.suggestions) {
			wrapper.append(el('datalist', {id: listId}, ...field.suggestions.map((s) => el('option', {value: s}))));
		}
		return wrapper;
	}
	return el('div', {class: 'field'}, el('label', {for: id, text: field.label}), control);
}

function buildForm() {
	const game = state.game;
	const draft = saved.games[game.id] ?? {};
	const criteria = draft.criteria ?? {};

	const pseudoInput = $('#f-pseudo');
	pseudoInput.value = state.user?.pseudo ?? saved.pseudo ?? '';
	pseudoInput.readOnly = Boolean(state.user);
	$('#pseudo-hint').hidden = !state.user;
	$('#f-discord').value = saved.discord ?? '';
	$('#contact-label').textContent = game.contact.label;
	$('#f-contact').placeholder = game.contact.placeholder;
	$('#f-contact').value = draft.contact ?? '';
	$('#f-lang').value = LANGS.includes(saved.lang) ? saved.lang : LANGS[0];
	$('#f-mic').checked = Boolean(saved.mic);
	$('#f-note').value = draft.note ?? '';
	renderMicText();

	$('#criteria-fields').replaceChildren(...game.fields.map((field) => criterionControl(field, criteria[field.id])));
	clearErrors();
}

function renderMicText() {
	$('#mic-text').textContent = $('#f-mic').checked ? 'Avec micro' : 'Sans micro';
}

function clearErrors() {
	for (const node of document.querySelectorAll('#listing-form [aria-invalid]')) node.removeAttribute('aria-invalid');
	const box = $('#form-error');
	box.hidden = true;
	box.textContent = '';
}

function showError(message) {
	const box = $('#form-error');
	box.textContent = message;
	box.hidden = false;
}

// Lit le formulaire. Renvoie {listing} ou {error, focus}.
function readForm() {
	clearErrors();
	const game = state.game;
	const problems = [];
	const flag = (node, message, focusNode = node) => {
		node.setAttribute('aria-invalid', 'true');
		problems.push({message, focusNode});
	};

	const pseudoInput = $('#f-pseudo');
	const pseudo = pseudoInput.value.trim();
	if (pseudo.length < LIMITS.pseudoMin) flag(pseudoInput, `Pseudo : au moins ${LIMITS.pseudoMin} caractères.`);

	const contactInput = $('#f-contact');
	const contact = contactInput.value.trim();
	if (contact.length < LIMITS.contactMin) {
		flag(contactInput, `${game.contact.label} : au moins ${LIMITS.contactMin} caractères.`);
	}

	const criteria = {};
	for (const field of game.fields) {
		const control = document.querySelector(`#criteria-fields [data-field="${field.id}"]`);
		if (control.classList.contains('pills')) {
			const checked = control.querySelector('input:checked');
			if (checked) criteria[field.id] = checked.value;
			else flag(control, `${field.label} : fais un choix.`, control.querySelector('input'));
		} else if (field.type === 'select') {
			if (control.value) criteria[field.id] = control.value;
			else flag(control, `${field.label} : fais un choix.`);
		} else if (field.type === 'number') {
			const raw = control.value.trim();
			const number = Number(raw);
			if (!/^\d+$/.test(raw) || number < field.min || number > field.max) {
				flag(control, `${field.label} : un nombre entre ${field.min} et ${field.max}.`);
			} else {
				criteria[field.id] = number;
			}
		} else {
			const text = control.value.trim();
			if (text) criteria[field.id] = text;
			else flag(control, `${field.label} : ce champ est obligatoire.`);
		}
	}

	if (problems.length) {
		return {error: problems[0].message, focus: problems[0].focusNode};
	}

	return {
		listing: {
			game: game.id,
			pseudo,
			contact,
			lang: $('#f-lang').value,
			mic: $('#f-mic').checked,
			discord: $('#f-discord').value.trim(),
			note: $('#f-note').value.trim(),
			criteria,
		},
	};
}

function saveDraft(listing) {
	saved.pseudo = listing.pseudo;
	saved.lang = listing.lang;
	saved.mic = listing.mic;
	saved.discord = listing.discord;
	saved.games[listing.game] = {contact: listing.contact, note: listing.note, criteria: listing.criteria};
	persist();
	// Connecté : le profil suit le compte, d'un appareil à l'autre.
	account?.saveProfile(localProfile());
}

function localProfile() {
	return {lang: saved.lang, mic: saved.mic, discord: saved.discord, games: saved.games};
}

function setBusy(busy) {
	state.busy = busy;
	$('#publish-btn').disabled = busy;
	$('#unpublish-btn').disabled = busy;
}

async function publish(listing, {silent = false} = {}) {
	if (!state.token) {
		if (!silent) showError('Connexion au salon perdue. Nouvelle tentative en cours…');
		return false;
	}
	setBusy(true);
	try {
		let response;
		try {
			response = await fetch('/api/listing', {
				method: 'POST',
				headers: {'Content-Type': 'application/json', 'X-Session': state.token},
				body: JSON.stringify(listing),
			});
		} catch {
			throw new Error('Serveur injoignable. Réessaie dans un instant.');
		}
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || 'Publication impossible pour l’instant.');

		state.mine = data.listing;
		setActive(listing.game);
		if (!silent) toast('Ton annonce est en ligne.');
		return true;
	} catch (error) {
		if (silent) toast(error.message, true);
		else showError(error.message);
		return false;
	} finally {
		setBusy(false);
		renderStatus();
		renderBoard();
	}
}

async function unpublish() {
	setActive(null);
	if (state.token) {
		setBusy(true);
		try {
			await fetch('/api/listing', {method: 'DELETE', headers: {'X-Session': state.token}});
		} catch {
			// Hors ligne : le serveur retirera l'annonce avec la connexion.
		} finally {
			setBusy(false);
		}
	}
	state.mine = null;
	toast('Ton annonce est retirée.');
	renderStatus();
	renderBoard();
}

// Après un rechargement ou une reconnexion, on remet l'annonce en ligne.
function republishSaved() {
	const active = getActive();
	const draft = active ? saved.games[active] : null;
	if (!draft || !getGame(active)) return;
	publish(
		{
			game: active,
			pseudo: saved.pseudo,
			contact: draft.contact,
			lang: saved.lang,
			mic: saved.mic,
			discord: saved.discord,
			note: draft.note,
			criteria: draft.criteria,
		},
		{silent: true},
	).then((ok) => {
		if (!ok) setActive(null);
	});
}

function renderStatus() {
	const status = $('#form-status');
	const publishBtn = $('#publish-btn');
	const unpublishBtn = $('#unpublish-btn');
	const mine = state.mine;

	if (!mine) {
		status.hidden = true;
		unpublishBtn.hidden = true;
		publishBtn.textContent = 'Je cherche un mate';
		return;
	}

	unpublishBtn.hidden = false;
	status.hidden = false;
	if (mine.game === state.game.id) {
		status.className = 'status';
		status.replaceChildren(
			el('span', {class: 'pulse', 'aria-hidden': 'true'}),
			el('span', {text: 'Ton annonce est en ligne. Elle reste visible tant que cet onglet est ouvert.'}),
		);
		publishBtn.textContent = 'Mettre à jour';
	} else {
		const other = getGame(mine.game);
		status.className = 'status is-elsewhere';
		status.replaceChildren(
			el('span', {text: `Ton annonce est en ligne sur ${other?.short ?? 'un autre jeu'}. Publier ici la remplacera.`}),
		);
		publishBtn.textContent = 'Je cherche un mate';
	}
}

// ---------- Filtres ----------

function buildFilters() {
	const game = state.game;
	const form = $('#filters');
	const controls = [];

	for (const field of game.fields) {
		const id = `flt-${field.id}`;
		let control;
		if (field.type === 'select') {
			control = el('select', {id, 'data-filter': field.id}, el('option', {value: '', text: 'Tous'}));
			for (const option of field.options) control.append(el('option', {value: option, text: option}));
		} else if (field.type === 'number') {
			control = el('input', {
				id,
				'data-filter': field.id,
				type: 'number',
				inputmode: 'numeric',
				min: field.min,
				max: field.max,
				placeholder: 'Minimum',
			});
		} else {
			control = el('input', {
				id,
				'data-filter': field.id,
				type: 'text',
				placeholder: 'Tous',
				autocomplete: 'off',
				spellcheck: 'false',
			});
		}
		const label = field.type === 'number' ? `${field.label} min.` : field.label;
		controls.push(el('div', {class: 'field'}, el('label', {for: id, text: label}), control));
	}

	const lang = el('select', {id: 'flt-lang', 'data-filter': 'lang'}, el('option', {value: '', text: 'Toutes'}));
	for (const option of LANGS) lang.append(el('option', {value: option, text: option}));
	controls.push(el('div', {class: 'field'}, el('label', {for: 'flt-lang', text: 'Langue'}), lang));

	controls.push(
		el(
			'div',
			{class: 'field'},
			el('span', {class: 'label', id: 'flt-mic-label', text: 'Micro'}),
			el(
				'label',
				{class: 'switch'},
				el('input', {type: 'checkbox', 'data-filter': 'mic', 'aria-labelledby': 'flt-mic-label'}),
				el('span', {class: 'switch-track', 'aria-hidden': 'true'}),
				el('span', {class: 'switch-text', text: 'Exigé'}),
			),
		),
	);

	controls.push(el('button', {class: 'filter-reset', id: 'filter-reset', type: 'button', hidden: true, text: 'Effacer les filtres'}));
	form.replaceChildren(...controls);
}

function readFilters() {
	const filters = {};
	for (const control of document.querySelectorAll('#filters [data-filter]')) {
		const key = control.dataset.filter;
		if (control.type === 'checkbox') {
			if (control.checked) filters[key] = true;
		} else if (control.type === 'number') {
			const number = Number(control.value);
			if (control.value.trim() !== '' && Number.isFinite(number)) filters[key] = number;
		} else if (control.value.trim()) {
			filters[key] = control.value.trim();
		}
	}
	state.filters = filters;
}

function resetFilters() {
	$('#filters').reset();
	state.filters = {};
	renderBoard();
}

function passesFilters(listing) {
	const filters = state.filters;
	for (const field of state.game.fields) {
		if (!(field.id in filters)) continue;
		const want = filters[field.id];
		const have = listing.criteria[field.id];
		if (field.type === 'select' && have !== want) return false;
		if (field.type === 'number' && have < want) return false;
		if (field.type === 'text' && !String(have).toLocaleLowerCase('fr').includes(want.toLocaleLowerCase('fr'))) {
			return false;
		}
	}
	if (filters.lang && listing.lang !== filters.lang) return false;
	if (filters.mic && !listing.mic) return false;
	return true;
}

// ---------- Cartes ----------

const cardCache = new Map(); // id public -> {node, signature}

function buildCard({listing, score, isMine}, index, isNew) {
	const game = state.game;

	const avatar = el('span', {class: 'avatar', 'aria-hidden': 'true', text: initials(listing.pseudo)});
	avatar.style.setProperty('--hue', String(hueOf(listing.pseudo)));

	const name = el('div', {class: 'card-name'}, el('h3', {text: listing.pseudo}));
	if (isMine) name.append(el('span', {class: 'badge badge-mine', text: 'Toi'}));
	if (listing.plus) name.append(el('span', {class: 'badge badge-plus', title: 'Membre Team Up Plus', text: 'Plus'}));
	if (listing.member) name.append(el('span', {class: 'badge badge-member', title: 'Pseudo réservé par un compte', text: 'Membre'}));
	if (listing.demo) name.append(el('span', {class: 'badge', title: 'Joueur fictif du mode démo', text: 'Démo'}));

	const meta = el(
		'p',
		{class: 'card-meta'},
		el('span', {class: 'online'}, el('span', {class: 'pulse', 'aria-hidden': 'true'}), 'En ligne'),
		el('span', {'data-since': listing.since, text: ago(listing.since)}),
		el('span', {text: listing.lang}),
		el('span', {text: listing.mic ? 'Micro' : 'Sans micro'}),
	);

	const tags = el('ul', {class: 'tags', 'aria-label': 'Critères'});
	game.fields.forEach((field, position) => {
		tags.append(
			el('li', {
				class: position < 2 ? 'tag is-key' : 'tag',
				title: field.label,
				text: formatValue(field, listing.criteria[field.id]),
			}),
		);
	});

	const card = el(
		'li',
		{class: `card cut${isMine ? ' is-mine' : ''}${listing.plus ? ' is-plus' : ''}${isNew ? ' is-new' : ''}`},
		el('div', {class: 'card-head'}, avatar, el('div', {class: 'card-id'}, name, meta)),
		tags,
	);
	if (isNew) card.style.setProperty('--i', String(Math.min(index, 12)));

	if (listing.note) card.append(el('p', {class: 'card-note', text: listing.note}));

	if (score !== null && !isMine) {
		const percent = Math.round(score * 100);
		const level = score >= 0.75 ? ' is-high' : score >= 0.5 ? ' is-mid' : '';
		const bar = el('span', {class: 'compat-bar', 'aria-hidden': 'true'}, el('span'));
		bar.firstChild.style.setProperty('--score', String(score));
		card.append(el('p', {class: `compat${level}`}, bar, el('span', {text: `${percent} % compatible`})));
	}

	const contactRow = (label, value) =>
		el(
			'div',
			{class: 'contact'},
			el(
				'div',
				{class: 'card-id'},
				el('span', {class: 'contact-label', text: label}),
				el('span', {class: 'contact-value', text: value}),
			),
			el('button', {
				class: 'copy-btn',
				type: 'button',
				'data-copy': value,
				'aria-label': `Copier ${label} de ${listing.pseudo}`,
				text: 'Copier',
			}),
		);
	const contacts = el('div', {class: 'contacts'}, contactRow(game.contact.label, listing.contact));
	if (listing.discord) contacts.append(contactRow('Discord', listing.discord));
	card.append(contacts);

	return card;
}

function renderBoard() {
	const game = state.game;
	if (!game) return;

	const inGame = state.listings.filter((listing) => listing.game === game.id);
	const mineHere = state.mine && state.mine.game === game.id ? state.mine : null;
	const others = inGame.filter((listing) => listing.id !== mineHere?.id);

	const items = inGame
		.map((listing) => {
			const isMine = listing.id === mineHere?.id;
			return {listing, isMine, score: mineHere && !isMine ? compatibility(mineHere, listing) : null};
		})
		.filter((item) => item.isMine || passesFilters(item.listing))
		.sort(
			(a, b) =>
				Number(b.isMine) - Number(a.isMine) ||
				Number(Boolean(b.listing.plus)) - Number(Boolean(a.listing.plus)) ||
				(b.score ?? 0) - (a.score ?? 0) ||
				b.listing.since - a.listing.since,
		);

	const shownOthers = items.filter((item) => !item.isMine).length;
	const filtering = Object.keys(state.filters).length > 0;

	// En-tête
	$('#board-title').textContent = game.name;
	const countText =
		filtering && shownOthers !== others.length
			? ` sur ${others.length} ${plural(others.length, 'joueur', 'joueurs')}`
			: ` ${plural(shownOthers, 'joueur cherche', 'joueurs cherchent')}`;
	$('#board-count').replaceChildren(el('strong', {text: String(shownOthers)}), countText);
	const reset = $('#filter-reset');
	if (reset) reset.hidden = !filtering;

	// Cartes : on ne reconstruit que ce qui a changé, pour garder le focus.
	const list = $('#cards');
	const keep = new Set();
	let previous = null;
	items.forEach((item, index) => {
		const id = item.listing.id;
		const signature = JSON.stringify([item.listing, item.score, item.isMine]);
		let entry = cardCache.get(id);
		if (!entry || entry.signature !== signature) {
			const node = buildCard(item, index, !entry);
			if (entry) entry.node.replaceWith(node);
			entry = {node, signature};
			cardCache.set(id, entry);
		}
		keep.add(id);
		const expected = previous ? previous.nextSibling : list.firstChild;
		if (entry.node !== expected) list.insertBefore(entry.node, expected);
		previous = entry.node;
	});
	for (const [id, entry] of cardCache) {
		if (!keep.has(id)) {
			entry.node.remove();
			cardCache.delete(id);
		}
	}

	// État vide
	const empty = $('#empty');
	const emptyAction = $('#empty-action');
	if (shownOthers > 0) {
		empty.hidden = true;
	} else if (others.length > 0) {
		empty.hidden = false;
		$('#empty-title').textContent = 'Aucun joueur ne correspond';
		$('#empty-text').textContent = 'Élargis tes filtres pour voir plus de monde.';
		emptyAction.hidden = false;
	} else {
		empty.hidden = false;
		$('#empty-title').textContent = mineHere ? 'Tu es le premier' : 'Le salon est vide';
		$('#empty-text').textContent = mineHere
			? `Garde l’onglet ouvert : le prochain joueur sur ${game.short} te verra tout de suite.`
			: `Personne ne cherche sur ${game.short} pour l’instant. Publie ton annonce, le prochain joueur te verra tout de suite.`;
		emptyAction.hidden = true;
	}
}

// ---------- En-tête, chiffres, dernières arrivées ----------

function renderLive() {
	const pill = $('#live-pill');
	pill.classList.toggle('is-offline', !state.connected);
	const text = $('#live-text');
	if (state.connected) {
		text.replaceChildren(el('strong', {text: String(state.online)}), ' en ligne');
	} else {
		text.textContent = 'Reconnexion…';
	}
	$('#stat-online').textContent = state.connected ? String(state.online) : '–';
	$('#stat-listings').textContent = state.connected ? String(state.listings.length) : '–';
	$('#stat-games').textContent = String(GAMES.length);
}

let radarSignature = '';
function renderRadar() {
	const latest = [...state.listings].sort((a, b) => b.since - a.since).slice(0, 5);
	const signature = latest.map((listing) => listing.id).join(',');
	$('#radar-empty').hidden = latest.length > 0;
	if (signature === radarSignature) return;
	radarSignature = signature;

	$('#radar-list').replaceChildren(
		...latest.map((listing) => {
			const game = getGame(listing.game);
			const mono = gameLogo(game, 'radar-logo');
			const summary = game.fields
				.slice(0, 2)
				.map((field) => formatValue(field, listing.criteria[field.id]))
				.join(' · ');
			return el(
				'li',
				{},
				mono,
				el(
					'span',
					{class: 'radar-who'},
					el('span', {class: 'radar-name', text: listing.pseudo}),
					el('span', {class: 'radar-what', text: `${game.short} · ${summary}`}),
				),
				el('span', {class: 'radar-time', 'data-since': listing.since, text: ago(listing.since)}),
			);
		}),
	);
}

function refreshTimes() {
	for (const node of document.querySelectorAll('[data-since]')) {
		node.textContent = ago(Number(node.dataset.since));
	}
}

function renderAll() {
	renderLive();
	renderGameTiles();
	renderRadar();
	renderBoard();
}

// ---------- Connexion en direct ----------

let source = null;
let retryTimer = null;

function connect() {
	clearTimeout(retryTimer);
	source?.close();
	source = new EventSource('/api/stream');

	source.addEventListener('hello', (event) => {
		knownIds = null;
		state.token = JSON.parse(event.data).token;
		state.connected = true;
		state.mine = null;
		renderLive();
		renderStatus();
		republishSaved();
	});

	source.addEventListener('state', (event) => {
		const data = JSON.parse(event.data);
		state.online = data.online;
		state.listings = Array.isArray(data.listings) ? data.listings : [];
		if (typeof data.now === 'number') state.clockOffset = Date.now() - data.now;
		checkAlerts(state.listings);
		renderAll();
	});

	source.addEventListener('error', () => {
		state.connected = false;
		state.token = null;
		state.mine = null;
		renderLive();
		renderStatus();
		renderBoard();
		// Le navigateur réessaie seul, sauf si le serveur a refusé la connexion.
		if (source.readyState === EventSource.CLOSED) {
			retryTimer = setTimeout(connect, 4000);
		}
	});
}

// ---------- Alertes (Plus) ----------

const ALERT_MIN_SCORE = 0.7;
let knownIds = null; // annonces déjà vues sur cette connexion

function alertsOn() {
	return Boolean(state.user?.plus && saved.alerts && state.mine);
}

function notify(title, body) {
	if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
		try {
			new Notification(title, {body, tag: 'teamup-alert'});
			return;
		} catch {
			// certains navigateurs mobiles l'interdisent : on retombe sur le message dans la page
		}
	}
	toast(`${title} — ${body}`);
}

// Appelée à chaque mise à jour du salon. Au premier envoi d'une connexion,
// on ne fait que mémoriser : on n'alerte pas pour ceux qui étaient déjà là.
function checkAlerts(listings) {
	const previous = knownIds;
	knownIds = new Set(listings.map((listing) => listing.id));
	if (!previous || !alertsOn()) return;

	const mine = state.mine;
	const fresh = listings
		.filter((listing) => !previous.has(listing.id) && listing.id !== mine.id && listing.game === mine.game)
		.map((listing) => ({listing, score: compatibility(mine, listing)}))
		.filter((item) => item.score >= ALERT_MIN_SCORE)
		.sort((a, b) => b.score - a.score);
	if (!fresh.length) return;

	const best = fresh[0];
	notify(
		fresh.length === 1 ? `Joueur compatible : ${best.listing.pseudo}` : `${fresh.length} joueurs compatibles`,
		`${getGame(mine.game).short} · ${Math.round(best.score * 100)} % compatible`,
	);
}

function renderAlerts() {
	const plus = Boolean(state.user?.plus);
	$('#alerts-toggle').checked = plus && saved.alerts;
	const blocked = 'Notification' in window && Notification.permission === 'denied';
	$('#alerts-hint').textContent = !plus
		? 'Réservé aux membres Plus.'
		: blocked
			? 'Notifications bloquées dans ton navigateur : l’alerte s’affichera dans la page.'
			: 'Tu es prévenu quand un joueur compatible arrive, tant que ton annonce est en ligne.';
}

// ---------- Compte ----------

let account = null;

// Le profil du compte complète ce que ce navigateur a gardé.
function applyProfile(profile) {
	saved.lang = profile.lang;
	saved.mic = profile.mic;
	if (profile.discord) saved.discord = profile.discord;
	for (const [gameId, entry] of Object.entries(profile.games)) {
		const local = saved.games[gameId] ?? {};
		saved.games[gameId] = {
			contact: entry.contact || local.contact || '',
			note: entry.note || local.note || '',
			criteria: {...local.criteria, ...entry.criteria},
		};
	}
}

function handleUser(user, reason) {
	const wasMember = Boolean(state.user);
	state.user = user;

	if (user) {
		saved.pseudo = user.pseudo;
		if (reason === 'register') account?.saveProfile(localProfile());
		else applyProfile(user.profile);
		persist();
	} else if (wasMember) {
		// Déconnexion : on ne laisse pas les identifiants sur un appareil partagé.
		saved.pseudo = '';
		saved.discord = '';
		saved.games = {};
		persist();
	}

	if (state.game) buildForm();
	renderAlerts();

	// L'annonce en ligne doit refléter le compte : on la republie sous le
	// pseudo réservé, ou on la retire quand le compte n'est plus là.
	if (state.mine) {
		if (!user && wasMember) unpublish();
		else if (Boolean(state.mine.member) !== Boolean(user) || Boolean(state.mine.plus) !== Boolean(user?.plus)) {
			republishSaved();
		}
	}
}

// ---------- Démarrage ----------

function init() {
	// Bornes de saisie tirées du catalogue.
	$('#f-pseudo').maxLength = LIMITS.pseudoMax;
	$('#f-contact').maxLength = LIMITS.contactMax;
	$('#f-note').maxLength = LIMITS.noteMax;
	$('#f-lang').replaceChildren(...LANGS.map((lang) => el('option', {value: lang, text: lang})));

	buildGameTiles();
	account = initAccount({onUser: handleUser});

	const fromUrl = new URLSearchParams(location.search).get('jeu');
	selectGame(getGame(fromUrl)?.id ?? getGame(getActive())?.id ?? getGame(saved.lastGame)?.id ?? GAMES[0].id);
	renderLive();

	$('#listing-form').addEventListener('submit', (event) => {
		event.preventDefault();
		if (state.busy) return;
		const result = readForm();
		if (result.error) {
			showError(result.error);
			result.focus.focus();
			return;
		}
		saveDraft(result.listing);
		publish(result.listing);
	});

	$('#unpublish-btn').addEventListener('click', unpublish);
	$('#f-mic').addEventListener('change', renderMicText);

	$('#filters').addEventListener('submit', (event) => event.preventDefault());
	$('#filters').addEventListener('input', () => {
		readFilters();
		renderBoard();
	});
	$('#filters').addEventListener('click', (event) => {
		if (event.target.closest('#filter-reset')) resetFilters();
	});
	$('#empty-action').addEventListener('click', resetFilters);

	$('#cards').addEventListener('click', async (event) => {
		const button = event.target.closest('.copy-btn');
		if (!button) return;
		const ok = await copyText(button.dataset.copy);
		if (!ok) {
			toast('Copie impossible : sélectionne l’identifiant à la main.', true);
			return;
		}
		button.textContent = 'Copié';
		button.classList.add('is-done');
		toast('Copié.');
		setTimeout(() => {
			button.textContent = 'Copier';
			button.classList.remove('is-done');
		}, 1600);
	});

	$('#alerts-toggle').addEventListener('change', async (event) => {
		if (!state.user?.plus) {
			event.target.checked = false;
			toast('Les alertes sont réservées à Team Up Plus.');
			account.open();
			return;
		}
		saved.alerts = event.target.checked;
		persist();
		if (saved.alerts && 'Notification' in window && Notification.permission === 'default') {
			try {
				await Notification.requestPermission();
			} catch {
				// refusé ou indisponible : l'alerte s'affichera dans la page
			}
		}
		renderAlerts();
	});
	renderAlerts();

	setInterval(refreshTimes, 20_000);

	// Page restaurée depuis le cache du navigateur : la connexion est morte.
	window.addEventListener('pageshow', (event) => {
		if (event.persisted) connect();
	});

	// On connaît le compte avant d'ouvrir le flux : une annonce republiée au
	// rechargement part déjà sous le bon pseudo, avec le bon statut.
	account.ready.finally(connect);
}

init();
