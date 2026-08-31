import type { FuzzyMatch, FuzzySearchOptions } from './fuzzySearch';
import type { NearbyMatch, NearbySearchOptions } from './nearbySearch';

export type LibrarySearchWorkerMatch = FuzzyMatch | NearbyMatch;

export interface LibrarySearchWorkerBatchSection {
  sectionKey: string;
  text: string;
  limit: number;
}

export interface LibrarySearchWorkerSearchPayload {
  id: number;
  sectionKey: string;
  text: string;
  query: string;
  mode: 'fuzzy' | 'nearby-words';
  fuzzyOptions: FuzzySearchOptions;
  nearbyOptions: NearbySearchOptions;
  limit: number;
}

export interface LibrarySearchWorkerBatchPayload {
  id: number;
  query: string;
  mode: 'fuzzy' | 'nearby-words';
  fuzzyOptions: FuzzySearchOptions;
  nearbyOptions: NearbySearchOptions;
  sections: LibrarySearchWorkerBatchSection[];
}

export type LibrarySearchWorkerRequest =
  | { type: 'search'; payload: LibrarySearchWorkerSearchPayload }
  | { type: 'search-batch'; payload: LibrarySearchWorkerBatchPayload };

export interface LibrarySearchWorkerResult {
  matches: LibrarySearchWorkerMatch[];
  truncated: boolean;
}

export interface LibrarySearchWorkerBatchEntry {
  sectionKey: string;
  matches: LibrarySearchWorkerMatch[];
  truncated: boolean;
}

export type LibrarySearchWorkerResponse =
  | { type: 'success'; id: number; matches: LibrarySearchWorkerMatch[]; truncated: boolean }
  | { type: 'batch-success'; id: number; results: LibrarySearchWorkerBatchEntry[] }
  | { type: 'error'; id: number; message: string; code?: string };
