// Mode démo : des joueurs fictifs qui vont et viennent, pour juger le rendu
// quand personne d'autre n'est connecté. Chacun est marqué `demo: true`
// et affiché avec un badge « DÉMO » dans l'interface.

import {GAMES} from '../public/games.js';
import {validateListing} from './listings.js';

const PSEUDOS = [
	'Kaelth', 'NyxVolt', 'Sombrelune', 'Grizzlax', 'Pixelle', 'Zephyrin', 'TankZilla',
	'MidOuRien', 'Ombrefer', 'Lunaria', 'Vortek', 'Sakuraa', 'DocHeal', 'Astralys',
	'Frostine', 'Ragnak', 'Elowen', 'Typhon', 'Mirabelle', 'NoxAeterna', 'Skadi',
	'Brumeciel', 'Katchou', 'Orionis', 'Velkan', 'PetitBiscuit', 'Hexa', 'Morwen',
	'Zoltar', 'Feuillemorte', 'Clutchy', 'Baguette', 'Solstice', 'Drakar', 'Yuna',
	'Tornade', 'Nebula', 'Fenrir', 'Caramel', 'Quartz',
];

const NOTES = {
	wow: [
		'Chaud pour des clés ce soir, vocal Discord.',
		'Je monte un reroll, on avance ensemble ?',
		'Cherche groupe régulier pour le raid du mercredi.',
		'Débutant, patient et motivé.',
		'',
	],
	lol: [
		'Je cherche un duo calme, pas de tilt.',
		'Main support, je m’adapte à ton ADC.',
		'Quelques ARAM pour se détendre.',
		'Objectif : monter d’un palier cette saison.',
		'',
	],
	valorant: [
		'Je joue fumigènes, je call beaucoup.',
		'Cherche un duo pour grimper sérieusement.',
		'Soirée détente en non classé.',
		'',
	],
	cs2: [
		'Il manque un cinquième pour du Premier.',
		'Je connais les smokes de Mirage et Inferno.',
		'Wingman pour s’échauffer.',
		'',
	],
	ow2: [
		'Main Soutien, je cherche un tank fiable.',
		'Quelques parties rapides entre potes.',
		'Placements à faire ce soir.',
		'',
	],
	dofus: [
		'Je cherche un groupe pour enchaîner les donjons.',
		'Team de 2 comptes, il me manque un soigneur.',
		'Kolizéum ce soir, niveau 200.',
		'Je débute, on monte ensemble ?',
		'',
	],
	rl: [
		'Je cherche un mate pour du 2v2 régulier.',
		'Rotations propres, je ne ball-chase pas.',
		'Tournoi dans une heure, il manque un joueur.',
		'',
	],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function contactFor(game, pseudo) {
	const tag = between(1000, 9999);
	if (game.contact.label === 'BattleTag') return `${pseudo}#${tag}`;
	if (game.contact.label === 'Riot ID') return `${pseudo}#${pick(['EUW', 'FR1', '0000', String(tag)])}`;
	return `${pseudo.toLowerCase()}_${String(tag).slice(0, 2)}`;
}

function randomCriteria(game) {
	const criteria = {};
	for (const field of game.fields) {
		if (field.type === 'select') {
			// On favorise la première moitié des listes de région/version,
			// pour que les filtres trouvent du monde.
			const pool = field.match === 'same' && Math.random() < 0.6 ? field.options.slice(0, 2) : field.options;
			criteria[field.id] = pick(pool);
		} else if (field.type === 'number') {
			criteria[field.id] = Math.random() < 0.5 ? field.max - 10 : between(field.min + 9, field.max);
		} else {
			criteria[field.id] = pick(field.suggestions.slice(0, 4));
		}
	}
	return criteria;
}

function randomListing(usedPseudos) {
	// WoW et LoL un peu plus peuplés que les autres.
	const game = pick([...GAMES, GAMES[0], GAMES[0], GAMES[1]]);
	const free = PSEUDOS.filter((pseudo) => !usedPseudos.has(pseudo));
	const pseudo = pick(free.length ? free : PSEUDOS);
	const result = validateListing({
		game: game.id,
		pseudo,
		contact: contactFor(game, pseudo),
		lang: Math.random() < 0.8 ? 'Français' : 'English',
		mic: Math.random() < 0.7,
		note: pick(NOTES[game.id]),
		criteria: randomCriteria(game),
	});
	if (!result.ok) throw new Error(`Annonce de démo invalide : ${result.error}`);
	return result.listing;
}

// Peuple le store et renouvelle un joueur de temps en temps.
// Renvoie une fonction qui arrête tout.
export function startDemo(store, {count = 26, intervalMs = 6500} = {}) {
	const bots = new Map(); // jeton -> pseudo
	let serial = 0;

	const join = (since) => {
		const listing = randomListing(new Set(bots.values()));
		const token = `demo-${++serial}`;
		if (store.upsert(token, listing, {demo: true, since})) bots.set(token, listing.pseudo);
	};

	for (let i = 0; i < count; i++) {
		join(Date.now() - between(20, 25 * 60) * 1000);
	}

	const timer = setInterval(() => {
		const tokens = [...bots.keys()];
		if (tokens.length >= count) {
			const leaving = pick(tokens);
			bots.delete(leaving);
			store.remove(leaving);
		}
		join();
	}, intervalMs);
	timer.unref();

	return {
		get size() {
			return bots.size;
		},
		stop() {
			clearInterval(timer);
			for (const token of bots.keys()) store.remove(token);
			bots.clear();
		},
	};
}
