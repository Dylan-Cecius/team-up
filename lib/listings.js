// Validation et stockage en mémoire des annonces.

import {getGame, LANGS, LIMITS} from '../public/games.js';

// Retire les caractères de contrôle, replie les espaces, borne la longueur.
// Caractères invisibles : contrôles, espaces de largeur nulle, marques de direction.
const isHidden = (code) =>
	code < 0x20 ||
	(code >= 0x7f && code <= 0x9f) ||
	(code >= 0x200b && code <= 0x200f) ||
	(code >= 0x2028 && code <= 0x202e) ||
	(code >= 0x2066 && code <= 0x2069);

export function cleanText(value, maxLength) {
	if (typeof value !== 'string' && typeof value !== 'number') return '';
	let out = '';
	for (const char of String(value)) {
		const code = char.codePointAt(0);
		if (code === 9 || code === 10 || code === 13) out += ' ';
		else if (!isHidden(code)) out += char;
	}
	return out.replace(/ +/g, ' ').trim().slice(0, maxLength);
}

const fail = (error) => ({ok: false, error});

function validateField(field, raw) {
	if (field.type === 'select') {
		if (typeof raw !== 'string' || !field.options.includes(raw)) {
			return fail(`${field.label} : choisis une valeur dans la liste.`);
		}
		return {ok: true, value: raw};
	}

	if (field.type === 'number') {
		const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
		if (!/^\d{1,4}$/.test(text)) {
			return fail(`${field.label} : entre un nombre entier.`);
		}
		const value = Number(text);
		if (value < field.min || value > field.max) {
			return fail(`${field.label} : entre ${field.min} et ${field.max}.`);
		}
		return {ok: true, value};
	}

	const value = cleanText(raw, field.maxLength ?? 30);
	if (!value) return fail(`${field.label} : ce champ est obligatoire.`);
	return {ok: true, value};
}

// Renvoie {ok: true, listing} avec une annonce propre, ou {ok: false, error}.
export function validateListing(input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return fail('Annonce illisible.');
	}

	const game = getGame(input.game);
	if (!game) return fail('Ce jeu n’est pas proposé.');

	const pseudo = cleanText(input.pseudo, LIMITS.pseudoMax);
	if (pseudo.length < LIMITS.pseudoMin) {
		return fail(`Pseudo : au moins ${LIMITS.pseudoMin} caractères.`);
	}

	const contact = cleanText(input.contact, LIMITS.contactMax);
	if (contact.length < LIMITS.contactMin) {
		return fail(`${game.contact.label} : au moins ${LIMITS.contactMin} caractères.`);
	}

	const rawCriteria =
		input.criteria !== null && typeof input.criteria === 'object' && !Array.isArray(input.criteria)
			? input.criteria
			: {};

	const criteria = {};
	for (const field of game.fields) {
		const raw = Object.hasOwn(rawCriteria, field.id) ? rawCriteria[field.id] : undefined;
		const result = validateField(field, raw);
		if (!result.ok) return result;
		criteria[field.id] = result.value;
	}

	return {
		ok: true,
		listing: {
			game: game.id,
			pseudo,
			contact,
			lang: LANGS.includes(input.lang) ? input.lang : 'Autre',
			mic: Boolean(input.mic),
			discord: cleanText(input.discord, LIMITS.discordMax),
			note: cleanText(input.note, LIMITS.noteMax),
			criteria,
		},
	};
}

// Pour un profil enregistré : garde les critères valides, ignore le reste.
export function partialCriteria(game, raw) {
	const criteria = {};
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return criteria;
	for (const field of game.fields) {
		if (!Object.hasOwn(raw, field.id)) continue;
		const result = validateField(field, raw[field.id]);
		if (result.ok) criteria[field.id] = result.value;
	}
	return criteria;
}

export {compatibility} from '../public/compat.js';

let nextId = 1;

// Annonces en mémoire, indexées par jeton secret de session.
// Les annonces renvoyées portent un `id` public, jamais le jeton.
export function createStore({max = 500} = {}) {
	const byToken = new Map();
	const listeners = new Set();
	const emit = () => {
		for (const listener of listeners) listener();
	};

	return {
		get size() {
			return byToken.size;
		},

		// Publie ou met à jour. Renvoie l'annonce publique, ou null si c'est plein.
		upsert(token, listing, {demo = false, member = false, plus = false, since} = {}) {
			const existing = byToken.get(token);
			if (!existing && byToken.size >= max) return null;
			const entry = {
				...listing,
				id: existing?.id ?? `p${(nextId++).toString(36)}`,
				since: existing?.since ?? since ?? Date.now(),
				...(demo ? {demo: true} : {}),
				...(member ? {member: true} : {}),
				...(plus ? {plus: true} : {}),
			};
			byToken.set(token, entry);
			emit();
			return entry;
		},

		remove(token) {
			const removed = byToken.delete(token);
			if (removed) emit();
			return removed;
		},

		get(token) {
			return byToken.get(token) ?? null;
		},

		all() {
			return [...byToken.values()];
		},

		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
