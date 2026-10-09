/**
 * Teams saved in this browser (localStorage via core/storage, scope "pokemon", key "teams").
 * Nothing leaves the device. Stored as the compact team text so old saves survive model changes.
 */
import { createStore, type Store } from '../../../../core/storage.ts';
import { packTeam, unpackTeam, type Team } from './team.ts';

export const SAVED_KEY = 'teams';
export const MAX_SAVED = 30;

export interface SavedTeam {
  id: string;
  name: string;
  /** packTeam() text. */
  team: string;
  /** ISO time of the last save. */
  savedAt: string;
}

function isSaved(x: unknown): x is SavedTeam {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.team === 'string' && typeof r.savedAt === 'string';
}

export function validateSaved(value: unknown): SavedTeam[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isSaved).slice(0, MAX_SAVED);
}

let shared: Store | null = null;
export function pokemonStore(): Store {
  shared ??= createStore('pokemon');
  return shared;
}

export function listSaved(store: Store = pokemonStore()): SavedTeam[] {
  return store.get<SavedTeam[]>(SAVED_KEY, [], validateSaved);
}

/** Insert or replace by id (newest first). Returns the updated list. */
export function saveTeam(entry: { id?: string; name: string; team: Team }, store: Store = pokemonStore(), now = new Date()): SavedTeam[] {
  const id = entry.id ?? `t${now.getTime().toString(36)}`;
  const record: SavedTeam = { id, name: entry.name.trim().slice(0, 60) || 'Untitled team', team: packTeam(entry.team), savedAt: now.toISOString() };
  const list = [record, ...listSaved(store).filter((t) => t.id !== id)].slice(0, MAX_SAVED);
  store.set(SAVED_KEY, list);
  return list;
}

export function deleteSaved(id: string, store: Store = pokemonStore()): SavedTeam[] {
  const list = listSaved(store).filter((t) => t.id !== id);
  store.set(SAVED_KEY, list);
  return list;
}

export function savedToTeam(saved: SavedTeam): Team {
  return unpackTeam(saved.team);
}
