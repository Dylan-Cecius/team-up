// Petits outils d'interface partagés.

export const $ = (selector) => document.querySelector(selector);

const PROPERTIES = new Set(['value', 'checked', 'hidden', 'disabled']);

// Crée un élément. `text` remplit textContent ; le reste devient attribut.
// Rien ne passe par innerHTML : un contenu de joueur reste du texte.
export function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === 'class') node.className = value;
		else if (key === 'text') node.textContent = value;
		else if (PROPERTIES.has(key)) node[key] = value;
		else node.setAttribute(key, value === true ? '' : String(value));
	}
	node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
	return node;
}

export function hueOf(text) {
	let hash = 0;
	for (const char of text) hash = (hash * 31 + char.codePointAt(0)) % 360;
	return hash;
}

export function initials(pseudo) {
	const letters = [...pseudo].filter((char) => /[\p{L}\p{N}]/u.test(char));
	return letters.slice(0, 2).join('').toUpperCase() || '?';
}

let toastTimer;
export function toast(message, isError = false) {
	const node = $('#toast');
	node.textContent = message;
	node.classList.toggle('is-error', isError);
	node.classList.add('is-visible');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2800);
}
