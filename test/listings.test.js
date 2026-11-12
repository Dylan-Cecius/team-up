import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateListing, createStore, compatibility} from '../lib/listings.js';

const wow = (over = {}) => ({
	game: 'wow',
	pseudo: 'Kaelth',
	contact: 'Kaelth#2481',
	lang: 'Français',
	mic: true,
	note: 'Chaud pour des clés ce soir',
	criteria: {
		version: 'Retail',
		faction: 'Horde',
		realm: 'Hyjal',
		level: 80,
		role: 'Tank',
		activity: 'Mythique+',
	},
	...over,
});

const valid = (input) => {
	const result = validateListing(input);
	assert.equal(result.ok, true, result.error);
	return result.listing;
};

test('accepte une annonce valide', () => {
	const listing = valid(wow());
	assert.equal(listing.game, 'wow');
	assert.equal(listing.pseudo, 'Kaelth');
	assert.equal(listing.criteria.level, 80);
	assert.equal(listing.mic, true);
});

test('refuse un jeu inconnu', () => {
	const result = validateListing(wow({game: 'tetris'}));
	assert.equal(result.ok, false);
	assert.match(result.error, /jeu/i);
});

test('refuse une valeur hors catalogue', () => {
	const input = wow();
	input.criteria.faction = 'Pandas';
	const result = validateListing(input);
	assert.equal(result.ok, false);
	assert.match(result.error, /Faction/);
});

test('refuse un niveau hors bornes ou non numérique', () => {
	for (const level of [0, 91, 'abc', 12.5, null]) {
		const input = wow();
		input.criteria.level = level;
		assert.equal(validateListing(input).ok, false, `niveau ${level}`);
	}
});

test('accepte un niveau envoyé comme texte', () => {
	const input = wow();
	input.criteria.level = '42';
	assert.equal(valid(input).criteria.level, 42);
});

test('refuse un pseudo ou un identifiant trop court', () => {
	assert.equal(validateListing(wow({pseudo: ' a '})).ok, false);
	assert.equal(validateListing(wow({contact: 'ab'})).ok, false);
});

test('refuse une entrée qui n’est pas un objet', () => {
	for (const input of [null, 'x', 42, [], {game: 'wow'}]) {
		assert.equal(validateListing(input).ok, false);
	}
});

test('retire les caractères de contrôle et les espaces en trop', () => {
	const listing = valid(wow({pseudo: '  Kae\u0000l\nth  ', note: 'a\t\tb'}));
	assert.equal(listing.pseudo, 'Kael th');
	assert.equal(listing.note, 'a b');
});

test('tronque les textes trop longs', () => {
	const listing = valid(wow({pseudo: 'x'.repeat(50), note: 'y'.repeat(500)}));
	assert.equal(listing.pseudo.length, 20);
	assert.equal(listing.note.length, 140);
});

test('garde le HTML comme simple texte', () => {
	const listing = valid(wow({pseudo: '<b>Zed</b>'}));
	assert.equal(listing.pseudo, '<b>Zed</b>');
});

test('ignore les champs inconnus', () => {
	const input = wow({admin: true});
	input.criteria.cheat = 'oui';
	const listing = valid(input);
	assert.equal('admin' in listing, false);
	assert.equal('cheat' in listing.criteria, false);
});

test('la langue inconnue devient « Autre » et le micro un booléen', () => {
	const listing = valid(wow({lang: 'Klingon', mic: 'oui'}));
	assert.equal(listing.lang, 'Autre');
	assert.equal(listing.mic, true);
});

test('compatibilité : identiques = 1, jeux différents = 0', () => {
	const a = valid(wow());
	assert.equal(compatibility(a, valid(wow({pseudo: 'Autre'}))), 1);
	const lol = valid({
		game: 'lol',
		pseudo: 'Mid',
		contact: 'Mid#EUW',
		lang: 'Français',
		mic: false,
		criteria: {rank: 'Or', role: 'Mid', region: 'EUW', mode: 'ARAM'},
	});
	assert.equal(compatibility(a, lol), 0);
});

test('compatibilité : baisse quand la faction diffère', () => {
	const a = valid(wow());
	const other = wow();
	other.criteria.faction = 'Alliance';
	const score = compatibility(a, valid(other));
	assert.ok(score < 1 && score > 0, `score ${score}`);
});

test('compatibilité : le serveur ne tient pas compte de la casse', () => {
	const a = valid(wow());
	const other = wow();
	other.criteria.realm = 'hyjal';
	assert.equal(compatibility(a, valid(other)), 1);
});

test('compatibilité : un rang voisin compte, un rang lointain non', () => {
	const lol = (rank) =>
		valid({
			game: 'lol',
			pseudo: 'Joueur',
			contact: 'Joueur#EUW',
			lang: 'Français',
			mic: true,
			criteria: {rank, role: 'Mid', region: 'EUW', mode: 'Classé solo/duo'},
		});
	const or = lol('Or');
	assert.equal(compatibility(or, lol('Platine')), 1);
	assert.ok(compatibility(or, lol('Challenger')) < 1);
});

test('store : publie, met à jour, retire, sans exposer le jeton', () => {
	const store = createStore();
	let changes = 0;
	store.onChange(() => changes++);

	const first = store.upsert('jeton-secret', valid(wow()));
	assert.ok(first.id);
	assert.equal(store.all().length, 1);
	assert.equal(JSON.stringify(store.all()).includes('jeton-secret'), false);

	const second = store.upsert('jeton-secret', valid(wow({pseudo: 'Kaelth2'})));
	assert.equal(second.id, first.id);
	assert.equal(second.since, first.since);
	assert.equal(store.all().length, 1);
	assert.equal(store.all()[0].pseudo, 'Kaelth2');

	assert.equal(store.remove('jeton-secret'), true);
	assert.equal(store.remove('jeton-secret'), false);
	assert.equal(store.all().length, 0);
	assert.equal(changes, 3);
});

test('store : refuse une nouvelle annonce quand il est plein', () => {
	const store = createStore({max: 1});
	assert.ok(store.upsert('a', valid(wow())));
	assert.equal(store.upsert('b', valid(wow())), null);
	assert.ok(store.upsert('a', valid(wow({pseudo: 'Encore'}))));
});
