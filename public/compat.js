// Score de compatibilité entre deux annonces.
// Utilisé par le navigateur (tri de la liste) et par les tests côté serveur.

import {getGame} from './games.js';

function fieldScore(field, mine, other) {
	if (field.match === 'same') {
		if (field.type === 'text') {
			return String(mine).toLocaleLowerCase('fr') === String(other).toLocaleLowerCase('fr') ? 1 : 0;
		}
		return mine === other ? 1 : 0;
	}

	// 'near' : rangs voisins ou niveaux proches.
	let gap;
	let tolerance;
	if (field.type === 'number') {
		gap = Math.abs(mine - other);
		tolerance = field.tolerance ?? 5;
	} else {
		gap = Math.abs(field.options.indexOf(mine) - field.options.indexOf(other));
		tolerance = 1;
	}
	if (gap <= tolerance) return 1;
	if (gap <= tolerance * 2) return 0.5;
	return 0;
}

// Entre 0 et 1 : part des critères « à faire correspondre » qui collent.
// La langue compte comme un critère.
export function compatibility(mine, other) {
	if (!mine || !other || mine.game !== other.game) return 0;
	const game = getGame(mine.game);
	if (!game) return 0;

	let total = 1;
	let score = mine.lang === other.lang ? 1 : 0;
	for (const field of game.fields) {
		if (!field.match) continue;
		total += 1;
		score += fieldScore(field, mine.criteria[field.id], other.criteria[field.id]);
	}
	return score / total;
}
